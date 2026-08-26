//! Blocking work scheduling for N-API exports.
//!
//! # Overview
//! Runs CPU-bound or blocking Rust work on libuv's thread pool via napi's
//! `Task` trait, with profiling and cancellation support.
//!
//! # Cancellation
//! Pass a `CancelToken` to blocking tasks. Work must check
//! `CancelToken::heartbeat()` periodically to respect cancellation.
//!
//! # Profiling
//! Samples are always collected into a circular buffer. Call
//! `get_work_profile()` to retrieve the last N seconds of data.
//!
//! # Usage
//! ```ignore
//! use crate::work::{blocking_task, CancelToken};
//!
//! #[napi]
//! fn my_heavy_work(signal: Option<AbortSignal>) -> AsyncTask<impl Task<...>> {
//!     let ct = CancelToken::new(None, signal);
//!     blocking_task("my_work", ct, |ct| {
//!         ct.heartbeat()?;
//!         // ... heavy computation ...
//!         Ok(result)
//!     })
//! }
//! ```

use std::cell::Cell;
use std::future::Future;
use std::panic::{AssertUnwindSafe, catch_unwind};

use napi::{Env, Error, Result, Status, Task, bindgen_prelude::*};
use pi_shell::cancel as core_cancel;

use crate::prof::profile_region;

// ─────────────────────────────────────────────────────────────────────────────
// Cancellation
// ─────────────────────────────────────────────────────────────────────────────

/// Reason for task abortion.
#[derive(Debug, Clone, Copy)]
pub enum AbortReason {
	Unknown,
	Timeout,
	Signal,
	User,
}

impl From<core_cancel::AbortReason> for AbortReason {
	fn from(value: core_cancel::AbortReason) -> Self {
		match value {
			core_cancel::AbortReason::Unknown => Self::Unknown,
			core_cancel::AbortReason::Timeout => Self::Timeout,
			core_cancel::AbortReason::Signal => Self::Signal,
			core_cancel::AbortReason::User => Self::User,
		}
	}
}

impl From<AbortReason> for core_cancel::AbortReason {
	fn from(value: AbortReason) -> Self {
		match value {
			AbortReason::Unknown => Self::Unknown,
			AbortReason::Timeout => Self::Timeout,
			AbortReason::Signal => Self::Signal,
			AbortReason::User => Self::User,
		}
	}
}

/// Token for cooperative cancellation of blocking work.
///
/// Call `heartbeat()` periodically inside long-running work to check for
/// cancellation requests from timeouts or abort signals.
#[derive(Clone, Default)]
pub struct CancelToken {
	core: core_cancel::CancelToken,
}

impl From<()> for CancelToken {
	fn from((): ()) -> Self {
		Self::default()
	}
}

impl CancelToken {
	/// Create a new cancel token from optional timeout and abort signal.
	pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
		let mut result = Self { core: core_cancel::CancelToken::new(timeout_ms) };
		if let Some(signal) = signal.and_then(|value| AbortSignal::from_unknown(value).ok()) {
			let abort_token = result.emplace_abort_token();
			signal.on_abort(move || abort_token.abort(AbortReason::Signal));
		}
		result
	}

	/// Check if cancellation has been requested.
	///
	/// Returns `Ok(())` if work should continue, or an error if cancelled.
	/// Call this periodically in long-running loops.
	pub fn heartbeat(&self) -> Result<()> {
		self
			.core
			.heartbeat()
			.map_err(|err| Error::from_reason(err.to_string()))
	}

	/// Wait for the cancel token to be aborted.
	pub async fn wait(&self) -> AbortReason {
		self.core.wait().await.into()
	}

	/// Get an abort token for external cancellation.
	pub fn abort_token(&self) -> AbortToken {
		AbortToken(self.core.abort_token())
	}

	/// Emplaces a cancel token if there is none, returns the abort token.
	pub fn emplace_abort_token(&mut self) -> AbortToken {
		AbortToken(self.core.emplace_abort_token())
	}

	/// Check if already aborted (non-blocking).
	pub fn aborted(&self) -> bool {
		self.core.aborted()
	}

	pub fn into_core(self) -> core_cancel::CancelToken {
		self.core
	}
}

/// Token for requesting cancellation from outside the task.
#[derive(Clone, Default)]
pub struct AbortToken(core_cancel::AbortToken);

impl AbortToken {
	/// Request cancellation of the associated task.
	pub fn abort(&self, reason: AbortReason) {
		self.0.abort(reason.into());
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocking Task - libuv thread pool integration
// ─────────────────────────────────────────────────────────────────────────────

thread_local! {
	/// Number of active [`Blocking::compute`] frames on this thread.
	///
	/// The native crash hook consults [`is_recoverable_scope_active`] from
	/// inside a panic: when the panic is about to be caught by
	/// [`Blocking::compute`]'s [`catch_unwind`] guard, the hook logs the
	/// report to disk but skips the user-facing stderr crash dump — the
	/// promise rejection is the primary signal instead. A borrow-free
	/// [`Cell`] is used because the panic hook runs while an arbitrary set
	/// of other borrows are live, and a `RefCell` there could panic again
	/// and abort the process.
	static BLOCKING_SCOPE_DEPTH: Cell<usize> = const { Cell::new(0) };
}

/// RAII guard that marks the current thread as executing inside
/// [`Blocking::compute`], so a panic on this thread is classified as
/// recoverable by the native crash hook. Decrements on drop even when the
/// wrapped work unwinds.
struct BlockingScopeGuard;

impl BlockingScopeGuard {
	fn enter() -> Self {
		BLOCKING_SCOPE_DEPTH.with(|d| d.set(d.get() + 1));
		Self
	}
}

impl Drop for BlockingScopeGuard {
	fn drop(&mut self) {
		BLOCKING_SCOPE_DEPTH.with(|d| d.set(d.get().saturating_sub(1)));
	}
}

/// Whether a `Blocking::compute` frame is active on the current thread —
/// i.e. a panic here is about to be caught before it can cross napi-rs's
/// plain `extern "C" fn` async-work boundary.
#[must_use]
pub fn is_recoverable_scope_active() -> bool {
	BLOCKING_SCOPE_DEPTH.with(|d| d.get() > 0)
}

/// Best-effort stringification of a panic payload for surfacing in a
/// [`napi::Error`]. Mirrors the [`std::panic::PanicHookInfo::payload_as_str`]
/// contract: recognise the two payload types the standard panic runtime
/// produces (`&'static str` from a bare string panic, `String` from a
/// formatted panic), and fall back to a diagnostic marker otherwise. The
/// full panic record (payload, location, backtrace) is still persisted by
/// the [`crate::crash_handler`] hook on disk.
fn panic_payload_to_string(payload: &(dyn std::any::Any + Send)) -> String {
	if let Some(s) = payload.downcast_ref::<&'static str>() {
		return (*s).to_owned();
	}
	if let Some(s) = payload.downcast_ref::<String>() {
		return s.clone();
	}
	String::from("<panic (payload not extractable — see native crash log)>")
}

/// Task that runs blocking work on libuv's thread pool with profiling.
///
/// This implements napi's `Task` trait, running `compute()` on a libuv worker
/// thread and `resolve()` on the main JS thread.
pub struct Blocking<T>
where
	T: Send + 'static,
{
	tag:          &'static str,
	cancel_token: CancelToken,
	work:         Option<Box<dyn FnOnce(CancelToken) -> Result<T> + Send>>,
}

impl<T> Task for Blocking<T>
where
	T: ToNapiValue + Send + 'static + TypeName,
{
	type JsValue = T;
	type Output = T;

	/// Runs the user closure on a libuv worker thread.
	///
	/// The closure is invoked under [`catch_unwind`] so a panic — from a
	/// first-party `.expect(...)` invariant, an arithmetic overflow in a
	/// third-party crate, or anything else — is surfaced as a
	/// [`napi::Error`] and rejected on the JS `Promise`. Without this
	/// guard, the unwind would cross napi-rs's plain `extern "C" fn
	/// execute` async-work callback
	/// (`napi::async_work::execute`), which under stabilized C-unwind
	/// semantics (RFC 2945, Rust 1.81+) is a forced process abort. See
	/// <https://github.com/can1357/oh-my-pi/issues/4020>.
	fn compute(&mut self) -> Result<Self::Output> {
		let _guard = profile_region(self.tag);
		let _scope = BlockingScopeGuard::enter();
		let work = self
			.work
			.take()
			.ok_or_else(|| Error::from_reason("BlockingTask: work already consumed"))?;
		let cancel_token = self.cancel_token.clone();
		let tag = self.tag;
		// `FnOnce` closures aren't automatically `UnwindSafe`; `AssertUnwindSafe`
		// is sound here because we only observe the panic to translate it into
		// a napi error — no post-panic state on `self` is reused (the closure
		// was already taken out of `self.work`).
		match catch_unwind(AssertUnwindSafe(move || work(cancel_token))) {
			Ok(result) => result,
			Err(payload) => Err(Error::new(
				Status::GenericFailure,
				format!("panic in blocking task '{tag}': {}", panic_payload_to_string(&*payload)),
			)),
		}
	}

	fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
		Ok(output)
	}
}

/// Dispose of a caught panic payload without any possibility of a second
/// unwind escaping this frame.
///
/// A [`std::panic::panic_any`] payload is an arbitrary user type whose `Drop`
/// impl may itself panic. [`Blocking::compute`] runs inside napi's async-work
/// `extern "C"` frame, so a panic escaping the payload's destructor would
/// cross the same non-`C-unwind` FFI edge the surrounding [`catch_unwind`]
/// exists to guard — force-aborting the host and defeating the recovery. The
/// drop is therefore attempted under its own [`catch_unwind`], inside a
/// crash-handler scope so the global hook records at most a disk-only crash
/// log for a panic we are about to swallow.
///
/// Leak rationale: if the destructor panics, the *secondary* payload is
/// [`std::mem::forget`]-ten instead of dropped — dropping it could panic
/// again, unwinding out of this frame after the guard already fired once.
/// Leaking one payload on this pathological path is a bounded, acceptable
/// cost; aborting the whole host process is not. `forget` on a
/// `Box<dyn Any + Send>` is always memory-safe (it only skips the destructor
/// and leaks the allocation).
fn dispose_panic_payload(payload: Box<dyn std::any::Any + Send>) {
	if let Err(secondary) = catch_unwind(AssertUnwindSafe(|| {
		crate::crash_handler::blocking_task_panic_scope(|| drop(payload));
	})) {
		std::mem::forget(secondary);
	}
}

pub type Promise<T> = AsyncTask<Blocking<T>>;

/// Create an `AsyncTask` that runs blocking work on libuv's thread pool.
///
/// Returns `AsyncTask<BlockingTask<T>>` which can be returned directly from
/// `#[napi]` functions - it becomes `Promise<T>` on the JS side.
///
/// # Arguments
/// - `tag`: Profiling tag for this work (appears in flamegraphs)
/// - `cancel_token`: Token for cooperative cancellation
/// - `work`: Closure that performs the blocking work
///
/// # Example
/// ```ignore
/// #[napi]
/// fn heavy_computation(signal: Option<AbortSignal>) -> AsyncTask<impl Task<...>> {
///     let ct = CancelToken::new(None, signal);
///     blocking_task("heavy_computation", ct, |ct| {
///         for i in 0..1000 {
///             ct.heartbeat()?; // Check for cancellation
///             // ... do work ...
///         }
///         Ok(result)
///     })
/// }
/// ```
pub fn blocking<T, F>(
	tag: &'static str,
	cancel_token: impl Into<CancelToken>,
	work: F,
) -> AsyncTask<Blocking<T>>
where
	F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
	T: ToNapiValue + TypeName + Send + 'static,
{
	AsyncTask::new(Blocking { tag, cancel_token: cancel_token.into(), work: Some(Box::new(work)) })
}

// ─────────────────────────────────────────────────────────────────────────────
// Async Task - Tokio runtime integration
// ─────────────────────────────────────────────────────────────────────────────

/// Run an async task on Tokio's runtime with profiling.
///
/// Use this for operations that need to `.await` (async I/O, `select!`, etc.).
/// For CPU-bound blocking work, use [`blocking_task`] instead.
///
/// # Arguments
/// - `env`: N-API environment (needed for `spawn_future`)
/// - `tag`: Profiling tag for this work
/// - `work`: Async closure that performs the work
///
/// # Example
/// ```ignore
/// #[napi]
/// fn run_async_io<'e>(env: &'e Env) -> Result<PromiseRaw<'e, String>> {
///     async_task(env, "async_io", async move {
///         let data = fetch_data().await?;
///         Ok(data)
///     })
/// }
/// ```
pub fn future<'env, T, Fut>(
	env: &'env Env,
	tag: &'static str,
	work: Fut,
) -> Result<PromiseRaw<'env, T>>
where
	Fut: Future<Output = Result<T>> + Send + 'static,
	T: ToNapiValue + Send + 'static,
{
	env.spawn_future(async move {
		let _guard = profile_region(tag);
		work.await
	})
}

#[cfg(test)]
mod tests {
	use napi::{Result, Task};

	use super::*;

	/// Constructs a `Blocking<()>` directly (bypassing `AsyncTask`) so we can
	/// invoke [`Task::compute`] and observe how it treats a panicking work
	/// closure. Regression harness for
	/// <https://github.com/can1357/oh-my-pi/issues/4020>.
	fn blocking_task_with_panic() -> Blocking<()> {
		Blocking {
			tag:          "test_panic",
			cancel_token: CancelToken::default(),
			work:         Some(Box::new(|_| -> Result<()> {
				panic!("injected panic inside blocking work");
			})),
		}
	}

	/// A panic in a `task::blocking` closure MUST NOT unwind out of
	/// `Task::compute`. napi-rs's async-work `execute` is a plain
	/// `extern "C" fn`; letting an unwind cross that boundary is a forced
	/// process abort under stabilized C-unwind rules. The correct behavior is
	/// to convert the panic into a `napi::Error`.
	#[test]
	fn compute_converts_panic_to_error() {
		let mut task = blocking_task_with_panic();
		let result = task.compute();
		let err = result.expect_err("panicking work must surface as Err, not unwind out of compute");
		assert_eq!(err.status, Status::GenericFailure);
		assert!(
			err.reason.starts_with("panic in blocking task 'test_panic':"),
			"napi Error reason must identify the panicking task by tag: {}",
			err.reason,
		);
		assert!(
			err.reason.contains("injected panic inside blocking work"),
			"panic message must be preserved in the napi Error reason: {}",
			err.reason,
		);
	}

	/// A subsequent `compute` call MUST return the "work already consumed"
	/// error rather than double-taking the `FnOnce`. Guards against a fix
	/// that accidentally leaves the closure untouched on the panic path.
	#[test]
	fn compute_consumes_work_even_when_it_panics() {
		let mut task = blocking_task_with_panic();
		let _first = task.compute();
		let err = task.compute().expect_err("second compute call must Err");
		assert!(
			err.reason.contains("work already consumed"),
			"second call must report work-already-consumed: {}",
			err.reason,
		);
	}

	/// Non-panicking work MUST resolve through `compute` unchanged. Guards
	/// against a fix that accidentally intercepts normal `Err(napi::Error)`
	/// returns or mangles the `Ok` payload.
	#[test]
	fn compute_still_forwards_ok_and_err_from_work() {
		let mut ok = Blocking {
			tag:          "test_ok",
			cancel_token: CancelToken::default(),
			work:         Some(Box::new(|_| Ok(42_u32))),
		};
		assert_eq!(ok.compute().expect("ok work must not error"), 42_u32);

		let mut err_task = Blocking::<()> {
			tag:          "test_err",
			cancel_token: CancelToken::default(),
			work:         Some(Box::new(|_| {
				Err(Error::new(Status::InvalidArg, "explicit error".to_owned()))
			})),
		};
		let err = err_task.compute().expect_err("explicit Err must propagate");
		assert_eq!(err.status, Status::InvalidArg);
		assert_eq!(err.reason, "explicit error");
	}

	/// The recoverable-scope flag MUST be raised only while `compute` is on
	/// the stack and MUST drop back to zero whether the work returned or
	/// panicked, so the native crash hook classifies subsequent unrelated
	/// panics correctly.
	#[test]
	fn recoverable_scope_flag_tracks_compute_lifetime() {
		assert!(!is_recoverable_scope_active(), "no compute frame at rest");

		let mut ok = Blocking::<bool> {
			tag:          "test_scope_ok",
			cancel_token: CancelToken::default(),
			work:         Some(Box::new(|_| Ok(is_recoverable_scope_active()))),
		};
		assert!(
			ok.compute().expect("ok work must not error"),
			"scope flag must be raised inside compute",
		);
		assert!(!is_recoverable_scope_active(), "scope flag must clear on return");

		let mut panicky = blocking_task_with_panic();
		let _ = panicky.compute();
		assert!(
			!is_recoverable_scope_active(),
			"scope flag must clear even when work panicked",
		);
	}
}
