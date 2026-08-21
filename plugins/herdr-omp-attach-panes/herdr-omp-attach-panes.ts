// herdr-omp-attach-panes.ts — interactive Herdr panes for omp Vibe workers.
//
// Installed BESIDE the managed integration herdr-omp-agent-state.ts; that file
// and config.yml are never touched. Auto-loaded by omp from this extensions
// dir. The passive mirror herdr-omp-vibe-panes.ts was removed; this interactive
// adapter is its replacement.
//
// Design:
//   - Interactive attach: one Herdr pane per in-process Vibe worker, running
//     the real `omp attach` client (a PTY TUI) against the fork's local
//     worker-attach substrate. This replaces the passive transcript mirror as
//     the live worker surface: the pane shows live worker output and accepts
//     typed follow-up input that the attach server routes into the worker's
//     turn queue.
//   - Trigger: omp's task-subagent lifecycle channel (task:subagent:lifecycle),
//     filtered strictly by id + description "vibe fast session"/"vibe good
//     session" — exactly like the passive mirror. Progress comes from
//     task:subagent:progress, correlated by payload.progress.id; a terminal
//     progress status does NOT close the pane (the worker stays registered/
//     continuable for follow-ups) — the pane closes only when the attach
//     client exits or on session shutdown.
//   - Endpoint sourcing: the started lifecycle payload may carry EXPLICIT
//     attach endpoint metadata (`attachSocket` / `attachTokenFile` — paths
//     only, never the token) emitted by the vibe runtime for every worker.
//     When present they are authoritative (the worker may have no parent
//     session file, e.g. the tmp fallback base dir). Otherwise the payload's
//     `sessionFile` is used — for a Vibe worker this is the CHILD session
//     file `<parentSessionDir>/<workerId>.jsonl` (executor.ts builds it as
//     path.join(artifactsDir, `${id}.jsonl`) and the vibe runtime sets
//     artifactsDir = parentSessionFile minus ".jsonl"). The parent session
//     directory is therefore path.dirname(payload.sessionFile), verified by
//     the basename match `${workerId}.jsonl`; the reconstructed parent
//     session file is `<dir>.jsonl` and the attach runtime dir is
//     `<dir>/attach` (vibe-bridge.ts ATTACH_RUNTIME_DIR_NAME), holding
//     `attach.sock` and `attach.token` (attach/server.ts). When neither
//     source yields paths, or the derived runtime dir does not exist on
//     disk, the worker is skipped with a logged warning — no pane is created.
//   - Command/env: the split env carries ONLY the two PATH variables
//     `ATTACH_SOCKET_PATH` and `ATTACH_TOKEN_FILE_PATH` (paths, never the
//     token/capability — the client reads the 0600 token file itself); the
//     split cwd is the project cwd (HERDR_OMP_VIBE_PANES_CWD override, so a
//     relative HERDR_OMP_ATTACH_BIN resolves there). The pane then runs
//     `<HERDR_OMP_ATTACH_BIN, default: the running omp CLI> attach
//     <workerId> --session-file <quoted parentSessionFile>`.
//   - Layout: the first pane splits the root pane right at the configured
//     ratio; each later pane splits the most recently created live owned pane
//     DOWN at 0.5 (a stacked right column). When no owned target exists or
//     ownership verification fails, it falls back to root/right. Unrelated
//     panes are never resized.
//   - Close/teardown: the owned pane is closed when the attach client exits —
//     the client exits when the worker is removed (vibe kill / mode exit /
//     unrecoverable failure). The client-exit poll detects the gone client
//     (pane.process_info foreground no longer contains the attach binary)
//     and closes only owned panes (tracked returned pane id, expected label
//     `herdr-attach-<workerId>`, same workspace/tab). Worker turn completion
//     never closes the pane: the worker stays registered/continuable and the
//     client stays connected for follow-ups. Session shutdown closes only
//     owned panes.
//   - Session switch: the root session_switch handler invokes forgetTracked()
//     BEFORE ensureInstalled(ctx); it forgets every prior-session mapping and
//     closes only owned prior panes, so no pane survives into the switched
//     session and stale async cleanup can never close a freshly rehydrated
//     same-id mapping (identity-guarded teardown).
//   - All RPC goes over the Herdr JSON-line socket (same protocol as the
//     managed integration); async event actions are serialized on one queue;
//     socket/Herdr failures are logged and never affect the worker.
//
// Opt-out: HERDR_OMP_VIBE_PANES=0 (default on; name kept for drop-in
// compatibility with the passive mirror). Other env:
//   HERDR_OMP_VIBE_PANES_CWD         project cwd for the split pane
//   HERDR_OMP_VIBE_PANES_RATIO       first split ratio (default 0.4)
//   HERDR_OMP_VIBE_PANES_DEBOUNCE_MS delay before the first client-exit
//                                     check (default 150)
//   HERDR_OMP_ATTACH_BIN             attach client command prefix (default:
//                                     the running omp CLI — runtime + .ts/.js
//                                     entry under source/npm launches, the
//                                     compiled omp executable, else "omp";
//                                     passed verbatim)
//
// Deterministic tests (dependency-injected) live in
// ~/Projects/omp-workspace/herdr-omp-attach-panes.test.ts.

import net from "node:net";
import fs from "node:fs/promises";
import path from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const SOURCE = "herdr:omp:attach";
export const LABEL_PREFIX = "herdr-attach-";
export const VIBE_DESCRIPTIONS: Record<string, true> = {
  "vibe fast session": true,
  "vibe good session": true,
};
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const DEFAULT_RATIO = 0.4;
/** Downward split ratio for stacked panes (second and later). */
export const STACK_RATIO = 0.5;
export const DEFAULT_DEBOUNCE_MS = 150;
export const DEFAULT_ATTACH_BIN = "omp";
/** Interval between client-exit checks while a pane is open (ms). */
export const ATTACH_EXIT_POLL_MS = 2000;

/** Session-file suffix; the parent artifacts dir is the file minus this. */
export const JSONL_SUFFIX = ".jsonl";
/** Attach runtime dir basename inside the session artifacts directory. */
export const ATTACH_RUNTIME_DIR_NAME = "attach";
/** Socket/token basenames inside the attach runtime dir (attach/server.ts). */
export const ATTACH_SOCKET_FILE = "attach.sock";
export const ATTACH_TOKEN_FILE = "attach.token";
/** Env var names carried in the split env (paths, never the token value). */
export const ATTACH_SOCKET_PATH_ENV = "ATTACH_SOCKET_PATH";
export const ATTACH_TOKEN_FILE_PATH_ENV = "ATTACH_TOKEN_FILE_PATH";

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

export function isVibeDescription(description) {
  return typeof description === "string" && VIBE_DESCRIPTIONS[description] === true;
}

export function isValidVibeId(id) {
  return typeof id === "string" && ID_RE.test(id);
}

export function isEnabled(env) {
  return Boolean(
    env &&
      env.herdrEnabled === true &&
      typeof env.socketPath === "string" &&
      env.socketPath.length > 0 &&
      typeof env.rootPaneId === "string" &&
      env.rootPaneId.length > 0 &&
      env.optOut !== true,
  );
}

/** True for terminal worker statuses (completed | failed | aborted). */
export function isTerminalStatus(status) {
  return status === "completed" || status === "failed" || status === "aborted";
}

function describeError(e) {
  if (e && typeof e === "object") {
    const code = e.code ?? e.error?.code;
    const message = e.message ?? e.error?.message;
    const joined = [code, message].filter(Boolean).join(": ");
    return joined || "herdr rpc error";
  }
  return String(e);
}

/**
 * Single-quote a shell argument. Always quotes (deterministic): safe for
 * paths containing spaces or quotes; the pane command is the only carrier of
 * the session-file path (the split env carries ONLY the two attach PATH
 * variables per the contract).
 */
export function quoteShellArg(value) {
  const s = typeof value === "string" ? value : "";
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The exact command typed into the attach pane. The bin is a verbatim
 * command prefix (default "omp"); the worker id is ID_RE-safe; the parent
 * session file is always single-quoted.
 */
export function buildAttachCommand(bin, workerId, parentSessionFile) {
  return `${bin || DEFAULT_ATTACH_BIN} attach ${workerId} --session-file ${quoteShellArg(parentSessionFile)}`;
}

/**
 * Attach command using the lifecycle payload's EXPLICIT endpoint paths
 * (fallback-parent workers have no session file to derive from). The client
 * reads the 0600 token file itself; only paths cross the command line.
 */
export function buildAttachCommandWithEndpoints(bin, workerId, socketPath, tokenFile) {
  return `${bin || DEFAULT_ATTACH_BIN} attach ${workerId} --socket ${quoteShellArg(socketPath)} --token-file ${quoteShellArg(tokenFile)}`;
}

/** Basenames of Bun/Node runtimes: without a CLI entry they cannot route `attach`. */
const RUNTIME_EXEC_NAMES: Record<string, true> = {
  bun: true,
  bunx: true,
  node: true,
  "bun.exe": true,
  "node.exe": true,
};

/**
 * Resolve the attach client command prefix. The explicit `attachBin` wins
 * and is passed verbatim. Otherwise the running CLI is used, mirroring
 * src/task/omp-command.ts: under a source/npm launch (the argv entry ends
 * `.ts`/`.js`) the prefix is the runtime (`execPath`) plus the CLI entry,
 * each shell-quoted, so `attach` routes to the subcommand; a compiled
 * non-runtime executable (e.g. a fork omp binary with the attach substrate)
 * is used verbatim. Only a bare Bun/Node runtime with no CLI entry — or
 * nothing at all — falls back to the bare `DEFAULT_ATTACH_BIN` ("omp").
 */
export function resolveAttachBin(attachBin, execPath = process.execPath, argvEntry = process.argv[1]) {
  if (typeof attachBin === "string" && attachBin.length > 0) return attachBin;
  if (
    typeof execPath === "string" &&
    execPath.length > 0 &&
    typeof argvEntry === "string" &&
    (argvEntry.endsWith(".ts") || argvEntry.endsWith(".js"))
  ) {
    return `${quoteShellArg(execPath)} ${quoteShellArg(argvEntry)}`;
  }
  if (
    typeof execPath === "string" &&
    execPath.length > 0 &&
    RUNTIME_EXEC_NAMES[path.basename(execPath.replaceAll(path.win32.sep, path.posix.sep))] !== true
  ) {
    return quoteShellArg(execPath);
  }
  return DEFAULT_ATTACH_BIN;
}

/**
 * Derive the attach runtime paths from a started lifecycle payload's
 * `sessionFile` (the worker's CHILD session file). For Vibe workers the
 * executor writes it as `<parentSessionDir>/<workerId>.jsonl`, so the parent
 * session directory is dirname(sessionFile) — verified by the basename match
 * — and the parent session file is `<dir>.jsonl` (same reconstruction
 * session-manager.ts resolveBreadcrumbToInteractiveRoot uses). The attach
 * runtime dir is `<dir>/attach` (vibe-bridge.ts ATTACH_RUNTIME_DIR_NAME),
 * holding `attach.sock` and `attach.token` (attach/server.ts).
 *
 * Returns null (caller logs + skips the worker) when the session file is
 * missing, does not end in ".jsonl", or its basename does not match the
 * worker id (not a Vibe child file — parentSessionFile unavailable).
 */
export function deriveAttachPaths(sessionFile, workerId) {
  if (typeof sessionFile !== "string" || !sessionFile.endsWith(JSONL_SUFFIX)) return null;
  if (!path.isAbsolute(sessionFile)) return null;
  if (!isValidVibeId(workerId)) return null;
  if (path.basename(sessionFile) !== `${workerId}${JSONL_SUFFIX}`) return null;
  const parentSessionDir = path.dirname(path.resolve(sessionFile));
  if (!parentSessionDir || parentSessionDir === "." || parentSessionDir === "/") return null;
  const parentSessionFile = `${parentSessionDir}${JSONL_SUFFIX}`;
  const runtimeDir = path.join(parentSessionDir, ATTACH_RUNTIME_DIR_NAME);
  return {
    parentSessionFile,
    parentSessionDir,
    runtimeDir,
    socketPath: path.join(runtimeDir, ATTACH_SOCKET_FILE),
    tokenFile: path.join(runtimeDir, ATTACH_TOKEN_FILE),
    explicit: false,
  };
}

/**
 * Build the attach paths from the lifecycle payload's EXPLICIT endpoint
 * metadata (`attachSocket` / `attachTokenFile` — paths only, never the
 * capability token). These are authoritative for workers whose parent
 * session has no persisted JSONL (tmp fallback runtime dir), where the
 * session-file derivation above cannot apply. The parent session file stays
 * null when the payload carried none.
 */
export function deriveExplicitAttachPaths(attachSocket, attachTokenFile) {
  if (typeof attachSocket !== "string" || attachSocket.length === 0) return null;
  if (typeof attachTokenFile !== "string" || attachTokenFile.length === 0) return null;
  if (!path.isAbsolute(attachSocket) || !path.isAbsolute(attachTokenFile)) return null;
  return {
    parentSessionFile: null,
    parentSessionDir: null,
    runtimeDir: null,
    socketPath: attachSocket,
    tokenFile: attachTokenFile,
    explicit: true,
  };
}

/** Prefer the explicit endpoint metadata; fall back to session-file derivation. */
export function resolveAttachEndpoint(payload, workerId) {
  if (payload && typeof payload === "object") {
    const explicit = deriveExplicitAttachPaths(payload.attachSocket, payload.attachTokenFile);
    if (explicit) return explicit;
  }
  return deriveAttachPaths(payload && typeof payload === "object" ? payload.sessionFile : undefined, workerId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket transport (real) — JSON-line RPC over the Herdr socket
// ─────────────────────────────────────────────────────────────────────────────

export function createSocketRpc(socketPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 1500;
  let seq = 0;
  return {
    request(method, params) {
      const { promise, resolve, reject } = Promise.withResolvers();
      const id = `${SOURCE}:${Date.now()}:${(seq += 1)}:${Math.random().toString(36).slice(2)}`;
      const socket = net.createConnection(socketPath);
      let buffer = "";
      let settled = false;
      const timer = setTimeout(() => finish(undefined, new Error(`herdr rpc timeout: ${method}`)), timeoutMs);
      timer.unref?.();
      function finish(result, error) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error);
        else resolve(result);
      }
      socket.setNoDelay?.();
      socket.on("error", err => finish(undefined, err instanceof Error ? err : new Error(String(err))));
      socket.on("connect", () => {
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      socket.on("data", chunk => {
        buffer += chunk.toString("utf8");
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg && msg.id === id) {
            if (msg.error !== undefined) finish(undefined, new Error(describeError(msg.error)));
            else finish(msg.result ?? null, undefined);
          }
        }
      });
      socket.on("end", () => finish(undefined, new Error(`herdr socket closed: ${method}`)));
      return promise;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Attach controller (dependency-injected: rpc, fs, env, timers)
// ─────────────────────────────────────────────────────────────────────────────

export class AttachPaneController {
  constructor(options) {
    this.#rpc = options.rpc;
    this.#fs = options.fs;
    this.#env = options.env;
    this.#log = options.log ?? { error() {}, warn() {}, debug() {} };
    this.#cwd = options.cwd ?? process.cwd();
    this.#ratio = Number.isFinite(options.ratio) && options.ratio > 0 && options.ratio < 1 ? options.ratio : DEFAULT_RATIO;
    this.#debounceMs = Number.isFinite(options.debounceMs) && options.debounceMs >= 0 ? options.debounceMs : DEFAULT_DEBOUNCE_MS;
    // Explicit attach bin wins; otherwise the running CLI (runtime + the
    // .ts/.js entry under source/npm launches, or the compiled omp binary);
    // bare "omp" applies only for a bare runtime or when nothing is set.
    this.#attachBin = resolveAttachBin(options.attachBin);
    // Client-exit polling is opt-in: tests drive checkClientExit() directly.
    this.#exitPollMs = Number.isFinite(options.exitPollMs) && options.exitPollMs > 0 ? options.exitPollMs : 0;
  }

  #rpc;
  #fs;
  #env;
  #log;
  #cwd;
  #ratio;
  #debounceMs;
  #attachBin;
  #exitPollMs;
  #attaches = new Map();
  #tail = Promise.resolve();

  #enqueue(fn) {
    this.#tail = this.#tail.then(fn, fn);
    return this.#tail;
  }

  #scheduleTimer(entry, fn, ms) {
    if (entry.closed) return;
    if (ms <= 0) {
      fn();
      return;
    }
    const timer = setTimeout(() => {
      entry.timers.delete(timer);
      if (entry.closed) return;
      try {
        fn();
      } catch (err) {
        this.#log.error?.("herdr-omp-attach-panes: timer handler failed", String(err));
      }
    }, ms);
    timer.unref?.();
    entry.timers.add(timer);
  }

  #clearEntryTimers(entry) {
    for (const timer of entry.timers) clearTimeout(timer);
    entry.timers.clear();
  }

  /** Tracked worker ids (tests). */
  tracked() {
    return [...this.#attaches.keys()];
  }

  /**
   * Session-switch reset: forget every tracked mapping so no attach pane from
   * the prior root session survives into the switched session. Owned panes
   * are closed; mappings whose ownership check fails are left untouched (no
   * unrelated pane is ever closed) and simply forgotten. In-flight spawns (no
   * pane yet) are marked closed so their queued split self-aborts; stale
   * async cleanup can never close a freshly rehydrated same-id mapping
   * (identity-guarded teardown).
   */
  async forgetTracked() {
    const entries = [...this.#attaches.values()];
    for (const entry of entries) {
      entry.closed = true;
      this.#clearEntryTimers(entry);
    }
    for (const entry of entries) {
      if (!entry.paneId) continue; // in-flight spawn self-aborts on the closed flag
      try {
        const owned = await this.#verifyOwnership(entry);
        if (!owned) {
          this.#log.warn?.("herdr-omp-attach-panes: session-switch ownership check failed; not closing pane", entry.paneId);
          continue;
        }
        await this.#teardownAttach(entry);
      } catch (err) {
        this.#log.error?.("herdr-omp-attach-panes: session-switch cleanup failed", String(err));
      }
    }
    // Forget everything this reset captured; identity-guarded so a same-id
    // mapping rehydrated mid-reset survives.
    for (const entry of entries) {
      if (this.#attaches.get(entry.vibeId) === entry) this.#attaches.delete(entry.vibeId);
    }
  }

  /**
   * Drain the action queue. Deterministic test seam: with debounceMs 0 every
   * event enqueues synchronously, so awaiting the tail after each event fully
   * settles it.
   */
  async flushPending() {
    for (let i = 0; i < 4; i += 1) {
      const tail = this.#tail;
      this.#tail = Promise.resolve();
      if (tail) await tail.catch(() => {});
    }
  }

  // ── Lifecycle (task:subagent:lifecycle) ────────────────────────────────────

  handleLifecycle(payload) {
    try {
      if (!payload || typeof payload !== "object") return;
      const { id, description, status } = payload;
      if (!isValidVibeId(id)) {
        this.#log.warn?.("herdr-omp-attach-panes: ignoring vibe lifecycle with invalid id", String(id));
        return;
      }
      if (status === "started") {
        // Started still requires the exact vibe session description.
        if (!isVibeDescription(description)) return;
        this.#onStarted(id, payload);
      } else if (isTerminalStatus(status)) {
        // Terminal states are accepted for any valid tracked id, even when
        // the description is absent or has changed.
        if (this.#attaches.has(id)) this.#onTerminal(id, status);
      }
    } catch (err) {
      this.#log.error?.("herdr-omp-attach-panes: lifecycle handler failed", String(err));
    }
  }

  #onStarted(id, payload) {
    const paths = resolveAttachEndpoint(payload, id);
    if (!paths) {
      // Neither explicit endpoint metadata nor a usable parent session file:
      // the worker is skipped (no pane) — the attach substrate cannot be
      // located without one of them.
      this.#log.warn?.("herdr-omp-attach-panes: skipping vibe worker without attach endpoint metadata or a usable parent session file", id);
      return;
    }
    const existing = this.#attaches.get(id);
    if (existing) {
      if (existing.closed) {
        // Fresh rehydration after a reset: drop the stale closed mapping and
        // spawn a brand-new pane.
        this.#attaches.delete(id);
      } else {
        // Same-pane reuse (vibe_send follow-up or a revived worker): the
        // attach client already runs in the pane and reconnects on its own;
        // never create a second pane.
        return;
      }
    }
    const entry = {
      vibeId: id,
      paneId: null,
      workspaceId: null,
      tabId: null,
      label: `${LABEL_PREFIX}${id}`,
      parentSessionFile: paths.parentSessionFile,
      runtimeDir: paths.runtimeDir,
      socketPath: paths.socketPath,
      tokenFile: paths.tokenFile,
      explicit: paths.explicit,
      status: "starting",
      closed: false,
      sawClient: false,
      pollCount: 0,
      timers: new Set(),
    };
    this.#attaches.set(id, entry);
    this.#enqueue(() => this.#spawnAttach(entry));
  }

  /**
   * Worker turn status is NOT a pane-close signal for the interactive attach
   * pane: a worker completes a turn and stays registered/continuable, and the
   * attach client stays connected across follow-ups. The pane is closed only
   * when the attach client exits, which happens when the worker is removed
   * (vibe kill / mode exit / unrecoverable failure) — detected by the
   * client-exit poll (#isPaneExited + ownership verification). Kept as a
   * no-op hook so lifecycle/progress terminal events remain harmless.
   */
  #onTerminal(_id, _status) {
    // Intentionally does not close the pane; see the doc comment above.
  }

  // ── Worker progress (task:subagent:progress, correlated by progress.id) ────

  handleProgress(payload) {
    try {
      if (!payload || typeof payload !== "object") return;
      const progress = payload.progress;
      if (!progress || typeof progress !== "object") return;
      const id = progress.id;
      if (!isValidVibeId(id)) return;
      const entry = this.#attaches.get(id);
      if (!entry || entry.closed) return;
      // Terminal turn status never closes the interactive pane (see
      // #onTerminal); the client-exit poll owns the close path.
      void progress.status;
    } catch (err) {
      this.#log.error?.("herdr-omp-attach-panes: progress handler failed", String(err));
    }
  }

  // ── Session shutdown ───────────────────────────────────────────────────────

  handleShutdown() {
    try {
      const entries = [...this.#attaches.values()];
      // Closed-first guard (same as forgetTracked): an in-flight spawn whose
      // split resolves after shutdown self-aborts on the closed flag instead
      // of creating a pane for a dead session.
      for (const entry of entries) {
        entry.closed = true;
        this.#clearEntryTimers(entry);
      }
      for (const entry of entries) {
        if (!entry.paneId) continue; // in-flight spawn self-aborts on the closed flag
        this.#enqueue(async () => {
          try {
            const owned = await this.#verifyOwnership(entry);
            if (!owned) {
              this.#log.warn?.("herdr-omp-attach-panes: shutdown ownership check failed; not closing pane", entry.paneId);
              return;
            }
            await this.#teardownAttach(entry);
          } catch (err) {
            this.#log.error?.("herdr-omp-attach-panes: shutdown cleanup failed", String(err));
          }
        });
      }
      // Forget everything this shutdown captured; identity-guarded so a
      // mapping rehydrated mid-shutdown survives.
      for (const entry of entries) {
        if (this.#attaches.get(entry.vibeId) === entry) this.#attaches.delete(entry.vibeId);
      }
    } catch (err) {
      this.#log.error?.("herdr-omp-attach-panes: shutdown handler failed", String(err));
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  async #spawnAttach(entry) {
    if (entry.closed) return; // session-switch reset / terminal raced the split
    try {
      // The attach substrate must actually exist before we open a pane for
      // it: the runtime dir is created by the vibe attach server at spawn
      // time, so a missing dir means the payload's session file was NOT the
      // parent's child (e.g. the tmp fallback base dir of a no-session
      // parent) — skip rather than point a pane at a nonexistent socket.
      // Explicit endpoint metadata (payload attachSocket/attachTokenFile)
      // bypasses this check: those paths are authoritative and the client
      // reports a clear error if the socket is gone.
      if (entry.runtimeDir !== null) {
        try {
          await this.#fs.stat(entry.runtimeDir);
        } catch (err) {
          this.#log.warn?.("herdr-omp-attach-panes: attach runtime dir missing; skipping worker", entry.vibeId, String(err));
          if (this.#attaches.get(entry.vibeId) === entry) this.#attaches.delete(entry.vibeId);
          return;
        }
      }
      if (entry.closed) return;
      const target = await this.#pickSplitTarget(entry);
      const result = await this.#rpc.request("pane.split", {
        target_pane_id: target.paneId,
        direction: target.direction,
        ratio: target.ratio,
        cwd: this.#cwd,
        env: {
          [ATTACH_SOCKET_PATH_ENV]: entry.socketPath,
          [ATTACH_TOKEN_FILE_PATH_ENV]: entry.tokenFile,
        },
        focus: false,
      });
      const pane = result?.pane && typeof result.pane === "object" ? result.pane : result;
      if (!pane || typeof pane.pane_id !== "string" || pane.pane_id.length === 0) {
        throw new Error(`pane.split returned no pane_id (result: ${describeError(result)})`);
      }
      entry.paneId = pane.pane_id;
      if (entry.closed) {
        // Reset/terminal raced the split: close the pane we just created so
        // it never orphans.
        try {
          await this.#rpc.request("pane.close", { pane_id: entry.paneId });
        } catch {
          // best effort
        }
        return;
      }
      if (typeof pane.workspace_id === "string") entry.workspaceId = pane.workspace_id;
      if (typeof pane.tab_id === "string") entry.tabId = pane.tab_id;

      await this.#rpc.request("pane.rename", { pane_id: entry.paneId, label: entry.label });
      await this.#rpc.request("pane.report_metadata", {
        pane_id: entry.paneId,
        source: SOURCE,
        title: `attach ${entry.vibeId}`,
        display_agent: "attach",
        applies_to_source: SOURCE,
        state_labels: { working: "working", idle: "idle", blocked: "blocked" },
      });
      await this.#startClient(entry);
      this.#scheduleExitPoll(entry);
    } catch (err) {
      this.#log.error?.("herdr-omp-attach-panes: attach pane spawn failed", String(err));
      // Only drop the mapping if it still belongs to this entry: a stale
      // spawn must never delete a freshly rehydrated same-id mapping.
      if (this.#attaches.get(entry.vibeId) === entry) this.#attaches.delete(entry.vibeId);
      if (entry.paneId) {
        try {
          await this.#rpc.request("pane.close", { pane_id: entry.paneId });
        } catch {
          // best effort
        }
      }
    }
  }

  /**
   * Stacked right-column layout: the first pane splits the root pane right at
   * the configured ratio; each later pane splits the most recently created
   * live owned pane DOWN at STACK_RATIO. When no owned target exists or
   * ownership verification fails, fall back to root/right. Unrelated panes
   * are never resized.
   */
  async #pickSplitTarget(entry) {
    const candidates = [...this.#attaches.values()].filter(
      candidate => candidate !== entry && candidate.paneId && !candidate.closed,
    );
    for (let i = candidates.length - 1; i >= 0; i -= 1) {
      const candidate = candidates[i];
      const owned = await this.#verifyOwnership(candidate);
      if (owned) {
        return { paneId: candidate.paneId, direction: "down", ratio: STACK_RATIO };
      }
      this.#log.warn?.("herdr-omp-attach-panes: stacked target ownership check failed; not splitting that pane", candidate.paneId);
    }
    return { paneId: this.#env.rootPaneId, direction: "right", ratio: this.#ratio };
  }

  async #startClient(entry) {
    try {
      const command = entry.explicit
        ? buildAttachCommandWithEndpoints(this.#attachBin, entry.vibeId, entry.socketPath, entry.tokenFile)
        : buildAttachCommand(this.#attachBin, entry.vibeId, entry.parentSessionFile);
      await this.#rpc.request("pane.send_text", { pane_id: entry.paneId, text: command });
      await this.#rpc.request("pane.send_keys", { pane_id: entry.paneId, keys: ["ENTER"] });
    } catch (err) {
      // Client start is best-effort; the pane + paths are still valid and the
      // exit poll will reclaim the pane if the client never comes up.
      this.#log.warn?.("herdr-omp-attach-panes: attach client start failed", String(err));
    }
  }

  /**
   * Schedule the belt-and-braces client-exit check: the first check runs
   * after debounceMs (HERDR_OMP_VIBE_PANES_DEBOUNCE_MS), then every
   * exitPollMs. Polling is disabled when exitPollMs is 0 (test default);
   * tests drive checkClientExit() directly.
   */
  #scheduleExitPoll(entry) {
    if (entry.closed || !entry.paneId || this.#exitPollMs <= 0) return;
    const delay = entry.pollCount === 0 ? Math.min(this.#debounceMs, this.#exitPollMs) : this.#exitPollMs;
    entry.pollCount += 1;
    this.#scheduleTimer(entry, () => {
      try {
        // checkClientExit enqueues the check on the shared action queue.
        this.checkClientExit(entry.vibeId).catch(err => {
          this.#log.error?.("herdr-omp-attach-panes: exit poll failed", String(err));
        });
      } catch (err) {
        this.#log.error?.("herdr-omp-attach-panes: exit poll enqueue failed", String(err));
      }
      this.#scheduleExitPoll(entry);
    }, delay);
  }

  /**
   * Public deterministic seam: run one client-exit check for a tracked
   * worker. When the attach pane is gone entirely (pane.get returns no pane
   * or a different pane_id) the stale mapping is forgotten — there is nothing
   * of ours left to close. When the pane still exists, is still owned, and
   * carries an explicit exit marker (the attach client process exited while
   * the pane remained), the owned pane is closed. pane.get failures are
   * logged and never close anything: a socket hiccup must not kill a pane,
   * and terminal status will reclaim it anyway.
   */
  checkClientExit(id) {
    const entry = this.#attaches.get(id);
    if (!entry || entry.closed || !entry.paneId) return Promise.resolve();
    return this.#enqueue(async () => {
      if (entry.closed) return;
      try {
        const exited = await this.#isPaneExited(entry);
        if (!exited) return;
        const owned = await this.#verifyOwnership(entry);
        if (!owned) {
          // The tracked pane is gone (or replaced): nothing of ours to close;
          // drop the stale mapping identity-guarded so the exit poll stops.
          this.#log.warn?.("herdr-omp-attach-panes: attach pane gone; forgetting stale mapping", entry.paneId);
          if (this.#attaches.get(entry.vibeId) === entry) this.#attaches.delete(entry.vibeId);
          return;
        }
        this.#log.warn?.("herdr-omp-attach-panes: attach client exited; closing owned pane", entry.paneId);
        await this.#closeAttach(entry);
      } catch (err) {
        this.#log.error?.("herdr-omp-attach-panes: client-exit check failed", String(err));
      }
    });
  }

  /**
   * True when the attach client is no longer the pane's live process. Two
   * independent signals, either sufficient:
   *   - pane.get: the tracked pane is gone (different/missing pane_id) or an
   *     explicit exit marker is present (exit_code, process null/non-running,
   *     state exited/closed). The herdr 0.8.0 pane.get response carries none
   *     of the marker fields, so this alone cannot detect a live exit;
   *   - pane.process_info: the pane's foreground process group no longer
   *     contains the attach client while it did on an earlier check
   *     (saw-client latch). A process_info query NEVER counts as exited
   *     before the client was observed running, so a slow client boot cannot
   *     close the pane prematurely. An RPC error is logged and never counts.
   */
  async #isPaneExited(entry) {
    try {
      const result = await this.#rpc.request("pane.get", { pane_id: entry.paneId });
      const pane = result?.pane && typeof result.pane === "object" ? result.pane : result;
      if (!pane || typeof pane.pane_id !== "string" || pane.pane_id !== entry.paneId) return true;
      if (typeof pane.exit_code === "number") return true;
      if (pane.process === null) return true;
      if (pane.process && typeof pane.process === "object" && pane.process.running === false) return true;
      if (pane.state === "exited" || pane.state === "closed") return true;
    } catch (err) {
      this.#log.warn?.("herdr-omp-attach-panes: pane.get failed during client-exit check", String(err));
      return false;
    }
    // pane.get reports the pane alive; verify the client process itself.
    try {
      const result = await this.#rpc.request("pane.process_info", { pane_id: entry.paneId });
      const info = result?.process_info && typeof result.process_info === "object" ? result.process_info : result;
      const foreground = Array.isArray(info?.foreground_processes) ? info.foreground_processes : [];
      if (foreground.length === 0) return false; // unknown; never close on an empty view
      const hasClient = foreground.some(proc => {
        if (!proc || typeof proc !== "object") return false;
        const argv = Array.isArray(proc.argv) ? proc.argv.join(" ") : "";
        return argv.includes("attach") || argv.includes(this.#attachBin);
      });
      if (hasClient) {
        entry.sawClient = true;
        return false;
      }
      return entry.sawClient === true;
    } catch (err) {
      this.#log.warn?.("herdr-omp-attach-panes: pane.process_info failed during client-exit check", String(err));
      return false;
    }
  }

  async #verifyOwnership(entry) {
    try {
      const result = await this.#rpc.request("pane.get", { pane_id: entry.paneId });
      const pane = result?.pane && typeof result.pane === "object" ? result.pane : result;
      if (!pane) return false;
      if (pane.pane_id !== entry.paneId) return false;
      if (typeof pane.label !== "string" || pane.label !== entry.label) return false;
      // No agent rejection here: the attach pane's live foreground process IS
      // our own `omp attach` client, which herdr detects as an omp agent. The
      // label + workspace + tab checks uniquely identify our pane; the agent
      // field instead signals client liveness (see #isPaneExited).
      if (entry.workspaceId && pane.workspace_id && pane.workspace_id !== entry.workspaceId) return false;
      if (entry.tabId && pane.tab_id && pane.tab_id !== entry.tabId) return false;
      return true;
    } catch (err) {
      this.#log.warn?.("herdr-omp-attach-panes: pane.get failed during ownership check", String(err));
      return false;
    }
  }

  async #closeAttach(entry) {
    if (entry.closed) return;
    entry.closed = true;
    await this.#teardownAttach(entry);
  }

  /**
   * Close an already-closed entry's owned pane and drop its mapping.
   * Identity-guarded: when the same worker id has since been rehydrated into
   * a fresh mapping (session-switch race), a stale teardown closes only its
   * own tracked pane id and never removes the new mapping.
   */
  async #teardownAttach(entry) {
    this.#clearEntryTimers(entry);
    try {
      await this.#rpc.request("pane.close", { pane_id: entry.paneId });
    } catch (err) {
      this.#log.warn?.("herdr-omp-attach-panes: pane.close failed", String(err));
    }
    if (this.#attaches.get(entry.vibeId) === entry) {
      this.#attaches.delete(entry.vibeId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Bind a controller to the omp extension API. Returns the controller, or null
 * when disabled or when the API surface is missing. Never throws.
 */
export function installAttachPaneController(pi, env, deps) {
  if (!isEnabled(env)) return null;
  const controller = new AttachPaneController({ ...deps, env });
  const bus = pi?.events;
  if (!bus || typeof bus.on !== "function") return null;
  bus.on("task:subagent:lifecycle", payload => {
    try {
      controller.handleLifecycle(payload);
    } catch {
      // never affect the worker
    }
  });
  bus.on("task:subagent:progress", payload => {
    try {
      controller.handleProgress(payload);
    } catch {
      // never affect the worker
    }
  });
  const on = typeof pi.on === "function" ? pi.on.bind(pi) : null;
  if (on) {
    on("session_shutdown", () => {
      try {
        controller.handleShutdown();
      } catch {
        // never affect the worker
      }
    });
  }
  return controller;
}

export function readEnv(processEnv = process.env) {
  return {
    herdrEnabled: processEnv.HERDR_ENV === "1",
    socketPath: processEnv.HERDR_SOCKET_PATH,
    rootPaneId: processEnv.HERDR_PANE_ID,
    optOut: processEnv.HERDR_OMP_VIBE_PANES === "0",
  };
}

/**
 * Root-UI-gated entry point: the controller is installed once, and only for
 * the root UI session — on session_start / session_switch / agent_start with
 * ctx?.hasUI === true (same activation gate as the managed
 * herdr-omp-agent-state.ts). Subagents (hasUI false) never install.
 * installAttachPaneController remains the low-level DI helper used by tests.
 */
export default function (pi, processEnv = process.env) {
  const env = readEnv(processEnv);
  const log = pi?.logger ?? { error: console.error, warn: console.warn, debug: console.debug };
  const rawDebounce = Number(processEnv.HERDR_OMP_VIBE_PANES_DEBOUNCE_MS);
  const rawRatio = Number(processEnv.HERDR_OMP_VIBE_PANES_RATIO);
  const rawBin = processEnv.HERDR_OMP_ATTACH_BIN;
  const deps = {
    rpc: createSocketRpc(env.socketPath),
    fs,
    log,
    cwd: processEnv.HERDR_OMP_VIBE_PANES_CWD ?? process.cwd(),
    debounceMs: Number.isFinite(rawDebounce) ? rawDebounce : DEFAULT_DEBOUNCE_MS,
    ratio: Number.isFinite(rawRatio) ? rawRatio : DEFAULT_RATIO,
    // Never substitute DEFAULT_ATTACH_BIN here: when the env var is unset, the
    // controller constructor falls back to the running executable instead.
    attachBin: typeof rawBin === "string" && rawBin.length > 0 ? rawBin : undefined,
    exitPollMs: ATTACH_EXIT_POLL_MS,
  };
  const on = typeof pi?.on === "function" ? pi.on.bind(pi) : null;
  if (!on) return null;

  let controller = null;
  const ensureInstalled = ctx => {
    if (ctx?.hasUI !== true) return;
    if (controller) return;
    controller = installAttachPaneController(pi, env, deps);
  };
  on("session_start", (_event, ctx) => ensureInstalled(ctx));
  on("session_switch", async (_event, ctx) => {
    // Reset prior-session panes BEFORE (re)installing: mappings from the
    // previous root session must not survive into the switched session.
    // Install remains once — ensureInstalled early-returns when a controller
    // exists.
    if (controller) {
      try {
        await controller.forgetTracked();
      } catch (err) {
        log.error?.("herdr-omp-attach-panes: session-switch reset failed", String(err));
      }
    }
    ensureInstalled(ctx);
  });
  on("agent_start", (_event, ctx) => ensureInstalled(ctx));
  return null;
}
