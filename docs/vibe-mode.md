# Vibe mode

Vibe mode turns the top-level interactive session into a **director** for persistent background worker sessions instead of letting it edit or execute commands itself. The director's active tools are reduced to `read`, optional parent-owned `todo`, and five worker-control tools (plus any tools granted via `vibe.directorTools`, see below). Workers do the searching, editing, running, and building; the director verifies their claims by reading touched files. When available, `todo` belongs only to the parent director.

## Enabling and disabling

Toggle it with the `/vibe` slash command:

```text
/vibe                 # enter vibe mode
/vibe fix the flaky test in packages/tui   # enter and submit a first directive
/vibe                 # run again to exit
```

- Entering activates a parent-session worker scope, installs the vibe tools, reduces the active toolset to `read`, optional parent-owned `todo`, and the vibe tools (plus any `vibe.directorTools` grants), and injects the director instructions.
- An inline prompt (`/vibe <prompt>`) enters the mode and submits that prompt as the first directive.
- Exiting restores the prior toolset, cancels in-flight worker turns, kills every worker session in the scope, and persists terminal lifecycle records. A worker never outlives an intentional mode exit.
- Vibe mode is mutually exclusive with both active **and paused** plan/goal modes; exit those modes first.
- Starting, forking, moving, or handing off the session is rejected while vibe mode is active.
- The status line shows a `Vibe` indicator while the mode is on.

`/vibe` is an interactive-TUI command. The mode and worker lifecycle events are persisted with the parent session. Resuming a session whose current mode is `vibe` rehydrates completed workers as idle/parked sessions with their child transcripts; a turn interrupted by process restart is not resumed automatically. Explicitly killed or mode-exit workers stay terminal.

## Director tool grants

By default the director's toolset is `read`, optional parent-owned `todo`, and the vibe tools — hands off the keyboard. When workers are unavailable (e.g. provider quota exhaustion) or an action is too small to delegate, `vibe.directorTools` (default `[]`) grants the director direct access to additional tools:

```sh
omp config set vibe.directorTools '["bash","write"]'
```

- Granted names must exist in the session registry; unknown names are ignored (validation happens at entry, not at set time).
- The prompt context lists only grants that are actually active, and the status line reports them on entry.
- The setting is session-snapshotted: it takes effect on the next `/vibe` entry of a fresh session (restart or resume).
- Exiting vibe mode restores the pre-vibe toolset exactly, grants included.
- Delegation remains the default; grants are an escape hatch, not a replacement for workers.

## The two worker tiers

Every worker is a real, keep-alive task-executor subagent with the normal coding tool surface and its own persisted child transcript. Choose a tier when spawning:

| Tier   | Bundled agent | Default role | Use for                                             |
| ------ | ------------- | ------------ | --------------------------------------------------- |
| `fast` | `sonic`       | `@smol`      | Mechanical execution, drafts, high-volume work      |
| `good` | `task`        | `@task`      | Design, judgment calls, and reviewing `fast` output |

The tier always selects the bundled `sonic` or `task` definition, not a same-named discovered custom agent. Model resolution otherwise matches task-agent routing: `task.agentModelOverrides.sonic` / `.task` wins over the bundled agent model, and role aliases resolve through `modelRoles`, with the parent active/default model as fallback.

## Worker-control tools

| Tool         | Input and behavior                                                                                                                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vibe_spawn` | `{ cli: "fast" \| "good", prompt, name? }`. Starts a blank worker with a complete, self-contained first brief. `name` is sanitized/capped at 48 characters; an id is generated when omitted.         |
| `vibe_send`  | `{ session, message }`. Steers a streaming turn at its next step; if a turn exists but cannot be steered, queues an automatic next turn; if idle/parked, starts the next turn immediately.           |
| `vibe_wait`  | `{ sessions?, timeout? }`. Waits for the first watched turn to settle (all in-flight workers when omitted), default 30 seconds. It acknowledges settled jobs so their result is not delivered twice. |
| `vibe_kill`  | `{ session }`. Cancels an in-flight turn, clears queued messages, releases the worker, and retains any initialized transcript at `history://<id>`.                                                   |
| `vibe_list`  | `{}`. Lists sessions in spawn order with tier, state, turn/queue counts, resolved model, and recent activity.                                                                                        |

Spawn and send return immediately. Each worker-turn result self-delivers into the director conversation through the async job manager; long response text is preview-capped there, with full output available at `agent://<id>`. Running `fast` and `good` workers on independent workstreams concurrently is the normal shape.

## Fork-only interactive Herdr panes

On a fork build with the attach substrate, each spawned worker also opens a live interactive pane in the herdr terminal: the production `omp attach <workerId>` client rendered as a **fullscreen alternate-screen TUI** — the pane borrows the alternate screen buffer on first paint, so the shell launch command disappears behind it and the terminal is restored cleanly on exit. The pane renders the worker's live transcript through the SAME shared transcript presenter the interactive mode uses (`modes/presentation/shared-transcript.ts`): real user/assistant/tool blocks with model tracking, delivered as semantic snapshot frames + live appends over the attach protocol.

- **Header/status.** A bold `attach <workerId>` header sits above the transcript; the composer's top border shows the worker state (`starting` / `running` / `idle` / `parked` / `revived` / `finished` / `error`, or the connection phase while connecting), the resolved model, the current summary, `tool:`, `queued:` count, `working…`, and `last:` result. A live line below the transcript shows the streaming tool/intent/text tail between committed messages.
- **Composer.** A focused editor composer is the sole focus target. Enter submits a prompt (a leased control intent); Shift/Ctrl+Enter inserts a newline (multiline drafts); Escape clears the draft. Ctrl-C on an empty draft **aborts the current turn** — the pane stays attached and the worker keeps running; Ctrl-D **detaches** — the pane's controller lease is released and the terminal restored, again without killing the worker. Owner-only session commands (leading `/`, e.g. `/new`, `/resume`, `/model`) are rejected in the pane with a status notice — they belong to the parent session.
- **Controller lease.** One pane client controls each worker: `view_open` acquires an atomic lease (reject-not-replace — a second pane is told the worker is controlled and exits). Disconnect holds the lease for a short grace so the same pane instance resumes it across reconnects (fresh snapshot epoch each time); explicit detach, grace expiry, worker removal, session switch, or shutdown releases it. Prompt frames carry the lease + generation + a monotonic command sequence, and the server caches bounded acknowledgements so a reconnect replays whether an accepted prompt ran — never executing it twice.
- **Transcript.** The server subscribes to the worker's live session BEFORE snapshotting, then streams the initial transcript (bounded, chunked entries) and live appends; a branch switch emits a reset + fresh snapshot. Long entries are bounded for the wire; the shared renderer truncates rows. Scrollable; sticks to the bottom unless scrolled up.
- **Follow-ups.** Rapidly typed prompts are queued client-side while the worker is unknown, the connection is reconnecting, or another prompt is in flight, then flushed in order into the worker's turn queue — the same queue `vibe_send` uses. Prompts and aborts never kill the worker.
- **Lifecycle.** The pane tracks the worker/client lifecycle: the attach client stays connected across turn completions and follow-ups (a completed turn does not close the pane); the pane closes when the client exits — worker removed via `vibe_kill` / mode exit, unrecoverable failure, or session/server shutdown — and reconnects on transport hiccups.
- **Endpoint sourcing.** The spawned worker's lifecycle payload carries explicit attach endpoint metadata (`attachSocket` / `attachTokenFile` — paths only, never the capability), used by the plugin for workers whose parent session has no persisted JSONL (tmp fallback base dir); the `--session-file` derivation remains as the fallback. The split env carries only `ATTACH_SOCKET_PATH` and `ATTACH_TOKEN_FILE_PATH` (paths, never the token — the client reads the 0600 token file itself).
- **Requirements.** The parent must run the fork binary (the attach server is vibe-runtime-scoped and boots at worker spawn), herdr must be running with `HERDR_ENV=1`, and the herdr-omp-attach-panes plugin (linked or drop-in) must be installed. `HERDR_OMP_ATTACH_BIN` overrides the client command; `HERDR_OMP_VIBE_PANES=0` opts out.

This is a fork feature: stock omp has no attach substrate, so its workers are steerable only through the director's `vibe_*` tools in the main TUI. The pane matches the OMO Slim interactive contract — a fullscreen shared-renderer transcript with a focused composer whose submissions land in the worker's turn queue — implemented on omp's own production attach substrate (the local attach server + `omp attach` client over the JSON-line socket with a 0600 capability token), with deliberate differences: worker panes are lease-controlled with reconnect replay, and owner-only session commands are rejected rather than forwarded.

## Scope and failure behavior

Worker ids are scoped to the owning agent and parent session; a worker from another scope is reported as unknown and cannot be controlled. Spawning requires the session async job manager. Spawn failures tear down the partial record; turn failures self-deliver as failed job results, while a recoverable keep-alive worker returns to `idle` for another `vibe_send`. A worker whose registered child session can no longer be resolved becomes `dead`.

## Workflow

1. Split the request into independent workstreams — one persistent worker per workstream so each accumulates useful conversation context.
2. Call `vibe_spawn` with a self-contained brief: files, constraints, and observable acceptance criteria. Workers start blank and never see the director's conversation.
3. Keep directing other workers while turns are in flight. Use `vibe_wait` only when blocked; a timed-out wait can be reissued.
4. Use `vibe_send` naturally for corrections and next steps. A mid-turn send steers when possible; otherwise it becomes the worker's next turn automatically.
5. When a result arrives, `read` touched files and inspect full output when the preview is insufficient. Reconcile verified work through the optional parent `todo`.
6. Route by difficulty: draft with `fast`, escalate to `good` when mechanical execution stalls or judgment is required.
7. Use `vibe_kill` for a finished/stuck worker. Exiting the mode kills the entire remaining scope.

The director remains responsible for the final outcome: worker completion means the turn settled, not that its claims are correct.
