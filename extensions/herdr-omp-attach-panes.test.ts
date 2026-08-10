// Deterministic Bun tests for the herdr-omp-attach-panes extension.
// Lives OUTSIDE ~/.omp/agent/extensions so it is never auto-loaded by omp.
// Run: bun test herdr-omp-attach-panes.test.ts
// All RPC/fs/timers are fakes (dependency injection); no Herdr server needed.
// Covers the pure path derivation (parent session file from the child session
// file the lifecycle payload carries, attach runtime dir/socket/token paths),
// the exact split command/args/env (only ATTACH_SOCKET_PATH +
// ATTACH_TOKEN_FILE_PATH, never the token), the stacked right-column layout,
// terminal-status and client-exit close paths (ownership-verified), the
// session-switch reset with same-id rehydration safety, and the root-UI
// install gate incl. HERDR_OMP_VIBE_PANES=0.

import { test, expect, describe, vi } from "bun:test";
import path from "node:path";
// Static import keeps the repo self-contained and directly testable: the test
// loads the repo-local extension copy, not the installed ~/.omp one.
import ext, {
  AttachPaneController,
  installAttachPaneController,
  isEnabled,
  isValidVibeId,
  isVibeDescription,
  isTerminalStatus,
  quoteShellArg,
  buildAttachCommand,
  deriveAttachPaths,
  SOURCE,
  LABEL_PREFIX,
  DEFAULT_RATIO,
  STACK_RATIO,
  DEFAULT_ATTACH_BIN,
  ATTACH_SOCKET_PATH_ENV,
  ATTACH_TOKEN_FILE_PATH_ENV,
  ATTACH_RUNTIME_DIR_NAME,
  ATTACH_SOCKET_FILE,
  ATTACH_TOKEN_FILE,
} from "./herdr-omp-attach-panes";

// ─────────────────────────────────────────────────────────────────────────────
// Fakes
// ─────────────────────────────────────────────────────────────────────────────

class FakeRpc {
  constructor() {
    this.calls = [];
    this.fail = new Set();
    this.responses = {
      "pane.split": () => {
        this.splitCount += 1;
        return { pane: { pane_id: `p-${this.splitCount}`, workspace_id: "w-1", tab_id: "t-1" } };
      },
      "pane.get": params => ({ pane: { pane_id: params.pane_id, label: `${LABEL_PREFIX}${params.pane_id}`, agent: null, workspace_id: "w-1", tab_id: "t-1" } }),
      "pane.rename": () => ({ changed: true }),
      "pane.report_metadata": () => ({}),
      "pane.send_text": () => ({}),
      "pane.send_keys": () => ({}),
      "pane.close": () => ({}),
      "pane.process_info": params => ({
        process_info: { pane_id: params.pane_id, foreground_processes: [{ name: "zsh", argv: ["-zsh"] }] },
      }),
    };
    this.splitCount = 0;
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (this.fail.has(method)) throw new Error(`fake rpc fail: ${method}`);
    const handler = this.responses[method];
    if (!handler) throw new Error(`fake rpc: no handler for ${method}`);
    return handler(params);
  }

  byMethod(method) {
    return this.calls.filter(call => call.method === method);
  }
}

class FakeFs {
  constructor() {
    this.dirs = new Set();
    this.statCalls = [];
  }

  async stat(file) {
    this.statCalls.push(file);
    if (!this.dirs.has(file)) {
      const err = new Error(`ENOENT: no such file or directory, stat '${file}'`);
      err.code = "ENOENT";
      throw err;
    }
    return { isDirectory: () => true };
  }
}

function env(overrides = {}) {
  return { herdrEnabled: true, socketPath: "/tmp/herdr.sock", rootPaneId: "root-1", optOut: false, ...overrides };
}

/** Env shape read by the default export (root-UI gate tests). */
const SMOKE_ENV = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "w18:p1", HERDR_OMP_VIBE_PANES: undefined };

function makePi() {
  const subscriptions = [];
  const listeners = new Map();
  return {
    pi: {
      logger: { error() {}, warn() {}, debug() {} },
      events: {
        on(channel, handler) {
          subscriptions.push([channel, handler]);
        },
      },
      on(event, handler) {
        subscriptions.push([event, handler]);
        const list = listeners.get(event) ?? [];
        list.push(handler);
        listeners.set(event, list);
      },
      emit(event, payload, ctx) {
        for (const handler of listeners.get(event) ?? []) handler(payload, ctx);
      },
    },
    subscriptions,
  };
}

function makeController(overrides = {}) {
  const rpc = overrides.rpc ?? new FakeRpc();
  const fs = overrides.fs ?? new FakeFs();
  const controller = new AttachPaneController({
    rpc,
    fs,
    env: overrides.env ?? env(),
    debounceMs: overrides.debounceMs ?? 0,
    cwd: "/proj",
    log: overrides.log ?? { error() {}, warn() {}, debug() {} },
    attachBin: overrides.attachBin ?? DEFAULT_ATTACH_BIN,
    // Exit polling is opt-in: tests drive checkClientExit() directly unless
    // the poll cadence itself is under test.
    exitPollMs: overrides.exitPollMs ?? 0,
  });
  return { controller, rpc, fs };
}

// Session layout mirrors the real omp on-disk shape: parent session file
// `<dir>.jsonl`, artifacts dir `<dir>/`, child worker file `<dir>/<id>.jsonl`,
// attach runtime dir `<dir>/attach` with socket + token files.
const SESSION_BASE = "/proj-sessions";
const childFile = id => `${SESSION_BASE}/${id}/${id}.jsonl`;
const parentFile = id => `${SESSION_BASE}/${id}.jsonl`;
const runtimeDir = id => `${SESSION_BASE}/${id}/${ATTACH_RUNTIME_DIR_NAME}`;
const socketPath = id => `${runtimeDir(id)}/${ATTACH_SOCKET_FILE}`;
const tokenFile = id => `${runtimeDir(id)}/${ATTACH_TOKEN_FILE}`;

/** Spawn a vibe worker whose attach runtime dir exists on disk. */
function start(h, id, description = "vibe fast session") {
  h.fs.dirs.add(runtimeDir(id));
  h.controller.handleLifecycle({ id, description, status: "started", sessionFile: childFile(id) });
}

function settle(h) {
  return h.controller.flushPending();
}

/** pane.get responses that map pane ids back to the owning worker ids. */
function ownedPaneGet(mapping) {
  return params => ({
    pane: {
      pane_id: params.pane_id,
      label: `${LABEL_PREFIX}${mapping[params.pane_id] ?? params.pane_id}`,
      agent: null,
      workspace_id: "w-1",
      tab_id: "t-1",
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("deriveAttachPaths", () => {
  test("derives the parent session file and attach runtime paths from the child session file", () => {
    const paths = deriveAttachPaths(childFile("9001"), "9001");
    expect(paths).toEqual({
      parentSessionFile: parentFile("9001"),
      parentSessionDir: `${SESSION_BASE}/9001`,
      runtimeDir: runtimeDir("9001"),
      socketPath: socketPath("9001"),
      tokenFile: tokenFile("9001"),
    });
    expect(paths.socketPath).toEndWith(`/${ATTACH_SOCKET_FILE}`);
    expect(paths.tokenFile).toEndWith(`/${ATTACH_TOKEN_FILE}`);
  });

  test("returns null when the parent session file is unavailable", () => {
    expect(deriveAttachPaths(undefined, "9001")).toBeNull();
    expect(deriveAttachPaths(null, "9001")).toBeNull();
    expect(deriveAttachPaths("/x/no-suffix", "9001")).toBeNull();
    expect(deriveAttachPaths("relative/9001.jsonl", "9001")).toBeNull(); // must be absolute
    expect(deriveAttachPaths("/x/other.jsonl", "9001")).toBeNull(); // basename does not match the worker id
    expect(deriveAttachPaths(childFile("9001"), "bad id!")).toBeNull();
  });
});

describe("buildAttachCommand / quoteShellArg", () => {
  test("command is <bin> attach <id> --session-file <quoted parent session file>", () => {
    expect(buildAttachCommand("omp", "9001", parentFile("9001"))).toBe(`omp attach 9001 --session-file '${parentFile("9001")}'`);
    // Custom bin prefixes pass through verbatim.
    expect(buildAttachCommand("bun run /x/attach-client.ts", "9001", parentFile("9001"))).toBe(
      `bun run /x/attach-client.ts attach 9001 --session-file '${parentFile("9001")}'`,
    );
    // Empty bin falls back to the default.
    expect(buildAttachCommand("", "9001", parentFile("9001"))).toBe(`omp attach 9001 --session-file '${parentFile("9001")}'`);
    // Never any secret material in the command.
    expect(buildAttachCommand("omp", "9001", parentFile("9001"))).not.toContain("token");
  });

  test("quoteShellArg always single-quotes and escapes embedded single quotes", () => {
    expect(quoteShellArg("/path/with space/x.jsonl")).toBe("'/path/with space/x.jsonl'");
    expect(quoteShellArg("it's.jsonl")).toBe("'it'\\''s.jsonl'");
    expect(quoteShellArg("")).toBe("''");
  });

  test("isTerminalStatus / isVibeDescription / isValidVibeId helpers", () => {
    expect(isTerminalStatus("completed")).toBe(true);
    expect(isTerminalStatus("failed")).toBe(true);
    expect(isTerminalStatus("aborted")).toBe(true);
    expect(isTerminalStatus("running")).toBe(false);
    expect(isTerminalStatus("starting")).toBe(false);
    expect(isVibeDescription("vibe fast session")).toBe(true);
    expect(isVibeDescription("vibe good session")).toBe(true);
    expect(isVibeDescription("task subagent")).toBe(false);
    expect(isValidVibeId("9001")).toBe(true);
    expect(isValidVibeId("bad id!")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Filtering
// ─────────────────────────────────────────────────────────────────────────────

describe("filtering", () => {
  test("only vibe fast/good descriptions get attach panes", async () => {
    const h = makeController();
    start(h, "9001", "task subagent");
    start(h, "9002", "vibe turbo session");
    start(h, "9003", "vibe fast session");
    start(h, "9004", "vibe good session");
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(2);
  });

  test("malformed or missing ids are ignored", async () => {
    const h = makeController();
    start(h, "bad id!");
    start(h, "");
    h.controller.handleLifecycle({ id: 12345, description: "vibe fast session", status: "started", sessionFile: childFile("12345") });
    h.controller.handleLifecycle({ id: "9005" }); // missing description
    h.controller.handleLifecycle({ description: "vibe fast session", status: "started" }); // missing id
    h.controller.handleLifecycle(null);
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spawn
// ─────────────────────────────────────────────────────────────────────────────

describe("spawn", () => {
  test("first spawn splits root/right with only the two attach path env vars and the interactive client command", async () => {
    const h = makeController();
    start(h, "9001");
    await settle(h);
    const splits = h.rpc.byMethod("pane.split");
    expect(splits).toHaveLength(1);
    expect(splits[0].params).toMatchObject({
      target_pane_id: "root-1",
      direction: "right",
      focus: false,
      cwd: "/proj",
    });
    expect(splits[0].params.ratio).toBe(DEFAULT_RATIO);
    // Environment carries ONLY the two PATH variables — paths, never the token.
    expect(Object.keys(splits[0].params.env).sort()).toEqual([ATTACH_SOCKET_PATH_ENV, ATTACH_TOKEN_FILE_PATH_ENV].sort());
    expect(splits[0].params.env).toEqual({
      [ATTACH_SOCKET_PATH_ENV]: socketPath("9001"),
      [ATTACH_TOKEN_FILE_PATH_ENV]: tokenFile("9001"),
    });
    // The token VALUE (the 0600 file's capability) must never appear anywhere.
    expect(JSON.stringify(splits[0].params)).not.toContain("0123456789abcdef");
    const renames = h.rpc.byMethod("pane.rename");
    expect(renames[0].params).toMatchObject({ pane_id: "p-1", label: `${LABEL_PREFIX}9001` });
    const meta = h.rpc.byMethod("pane.report_metadata");
    expect(meta[0].params.source).toBe(SOURCE);
    expect(meta[0].params.title).toBe("attach 9001");
    const texts = h.rpc.byMethod("pane.send_text");
    expect(texts).toHaveLength(1);
    expect(texts[0].params.text).toBe(`omp attach 9001 --session-file '${parentFile("9001")}'`);
    expect(h.rpc.byMethod("pane.send_keys")[0].params.keys).toEqual(["ENTER"]);
  });

  test("missing parent session file skips the worker with a warning and no pane", async () => {
    const warns = [];
    const h = makeController({ log: { error() {}, warn(...args) { warns.push(args.join(" ")); }, debug() {} } });
    // A vibe worker whose parent session has no session file: the started
    // lifecycle payload carries no sessionFile at all.
    h.controller.handleLifecycle({ id: "9005", description: "vibe fast session", status: "started" });
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual([]);
    expect(warns.join("\n")).toContain("without a usable parent session file");
  });

  test("missing attach runtime dir (tmp fallback base dir) skips the worker with a warning", async () => {
    const warns = [];
    const h = makeController({ log: { error() {}, warn(...args) { warns.push(args.join(" ")); }, debug() {} } });
    // sessionFile present, but its parent dir has no attach runtime dir on
    // disk — the no-session-parent tmp fallback case. No pane is created.
    h.controller.handleLifecycle({ id: "9006", description: "vibe good session", status: "started", sessionFile: childFile("9006") });
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual([]);
    expect(warns.join("\n")).toContain("attach runtime dir missing");
  });

  test("a second started for the same live worker never creates a second pane", async () => {
    const h = makeController();
    start(h, "9007");
    await settle(h);
    start(h, "9007"); // vibe_send follow-up / revived worker
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(1);
    expect(h.controller.tracked()).toEqual(["9007"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layout
// ─────────────────────────────────────────────────────────────────────────────

describe("layout", () => {
  test("second spawn stacks down at 0.5 below the newest owned pane; third below that", async () => {
    const h = makeController();
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9001", "p-2": "9002" });
    start(h, "9001");
    await settle(h);
    start(h, "9002");
    await settle(h);
    let splits = h.rpc.byMethod("pane.split");
    expect(splits).toHaveLength(2);
    expect(splits[0].params).toMatchObject({ target_pane_id: "root-1", direction: "right", ratio: DEFAULT_RATIO });
    expect(splits[1].params).toMatchObject({ target_pane_id: "p-1", direction: "down", ratio: STACK_RATIO });

    // A third pane stacks below the newest owned pane (p-2).
    start(h, "9003");
    await settle(h);
    splits = h.rpc.byMethod("pane.split");
    expect(splits).toHaveLength(3);
    expect(splits[2].params).toMatchObject({ target_pane_id: "p-2", direction: "down", ratio: STACK_RATIO });
  });

  test("ownership failure falls back to root/right instead of splitting an unowned pane", async () => {
    const h = makeController();
    h.rpc.responses["pane.get"] = () => ({
      pane: { pane_id: "p-1", label: "someone-elses-pane", agent: null, workspace_id: "w-1", tab_id: "t-1" },
    });
    start(h, "9001");
    await settle(h);
    start(h, "9002");
    await settle(h);
    const splits = h.rpc.byMethod("pane.split");
    expect(splits).toHaveLength(2);
    expect(splits[1].params).toMatchObject({ target_pane_id: "root-1", direction: "right", ratio: DEFAULT_RATIO });
    expect(splits[1].params.direction).not.toBe("down");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal status
// ─────────────────────────────────────────────────────────────────────────────

describe("terminal", () => {
  test("terminal lifecycle status does not close the interactive pane (worker stays continuable)", async () => {
    const h = makeController();
    start(h, "9001");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9001" });
    // Terminal states are accepted without the vibe description.
    h.controller.handleLifecycle({ id: "9001", status: "completed" });
    await settle(h);
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9001"]);
    // A follow-up turn reuses the same pane (same worker id, never a second pane).
    h.controller.handleLifecycle({
      id: "9001",
      description: "vibe fast session",
      status: "started",
      sessionFile: childFile("9001"),
    });
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(1);
    expect(h.controller.tracked()).toEqual(["9001"]);
  });

  test("terminal progress status does not close the interactive pane", async () => {
    const h = makeController();
    start(h, "9003");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9003" });
    h.controller.handleProgress({ progress: { id: "9003", status: "completed" } });
    await settle(h);
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9003"]);
  });

  test("a removed worker closes the pane through the client-exit poll, not the terminal event", async () => {
    const h = makeController();
    start(h, "9004");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9004" });
    // Client running: process_info shows the attach binary; the poll arms the latch.
    h.rpc.responses["pane.process_info"] = () => ({
      process_info: { pane_id: "p-1", foreground_processes: [{ name: "omp", argv: ["/proj/dist/omp", "attach", "9004"] }] },
    });
    await h.controller.checkClientExit("9004");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    // Removal (kill): the terminal lifecycle event fires but must NOT close.
    h.controller.handleLifecycle({ id: "9004", status: "aborted" });
    await settle(h);
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9004"]);
    // Client exited: process_info shows only the shell; the owned pane closes.
    h.rpc.responses["pane.process_info"] = () => ({
      process_info: { pane_id: "p-1", foreground_processes: [{ name: "zsh", argv: ["-zsh"] }] },
    });
    await h.controller.checkClientExit("9004");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(1);
    expect(h.controller.tracked()).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client exit (belt and braces)
// ─────────────────────────────────────────────────────────────────────────────

describe("client exit", () => {
  test("an owned pane whose attach client exited (explicit marker) is closed", async () => {
    const h = makeController();
    start(h, "9053");
    await settle(h);
    h.rpc.responses["pane.get"] = () => ({
      pane: { pane_id: "p-1", label: `${LABEL_PREFIX}9053`, agent: null, workspace_id: "w-1", tab_id: "t-1", exit_code: 0 },
    });
    await h.controller.checkClientExit("9053");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(1);
    expect(h.controller.tracked()).toEqual([]);
  });

  test("a live owned pane without exit markers is not closed", async () => {
    const h = makeController();
    start(h, "9054");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9054" });
    await h.controller.checkClientExit("9054");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9054"]);
  });

  test("pane.get failures never close a pane during client-exit checks", async () => {
    const h = makeController();
    start(h, "9051");
    await settle(h);
    h.rpc.fail.add("pane.get");
    await h.controller.checkClientExit("9051");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9051"]);
  });

  test("a gone pane is forgotten without closing anything (nothing left to close)", async () => {
    const h = makeController();
    start(h, "9052");
    await settle(h);
    h.rpc.responses["pane.get"] = () => ({});
    await h.controller.checkClientExit("9052");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual([]);
  });

  test("process_info: client boot is never treated as exit; exit after a seen client closes the owned pane", async () => {
    const h = makeController();
    start(h, "9055");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9055" });
    // Bare shell foreground before the client has ever appeared: NOT exited.
    h.rpc.responses["pane.process_info"] = () => ({
      process_info: { pane_id: "p-1", foreground_processes: [{ name: "zsh", argv: ["-zsh"] }] },
    });
    await h.controller.checkClientExit("9055");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9055"]);
    // Client now running: still not exited; latch arms.
    h.rpc.responses["pane.process_info"] = () => ({
      process_info: { pane_id: "p-1", foreground_processes: [{ name: "omp", argv: ["/proj/dist/omp", "attach", "9055"] }] },
    });
    await h.controller.checkClientExit("9055");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9055"]);
    // Client gone again: latch is armed, so the owned pane is closed.
    h.rpc.responses["pane.process_info"] = () => ({
      process_info: { pane_id: "p-1", foreground_processes: [{ name: "zsh", argv: ["-zsh"] }] },
    });
    await h.controller.checkClientExit("9055");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(1);
    expect(h.controller.tracked()).toEqual([]);
  });

  test("process_info RPC failures never close a pane during client-exit checks", async () => {
    const h = makeController();
    start(h, "9056");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9056" });
    h.rpc.fail.add("pane.process_info");
    await h.controller.checkClientExit("9056");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9056"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session switch
// ─────────────────────────────────────────────────────────────────────────────

describe("session switch", () => {
  test("forgetTracked closes owned prior panes and forgets all mappings", async () => {
    const h = makeController();
    start(h, "9100");
    start(h, "9101");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9100", "p-2": "9101" });
    await h.controller.forgetTracked();
    const closes = h.rpc.byMethod("pane.close");
    expect(closes).toHaveLength(2);
    expect(closes.map(call => call.params.pane_id).sort()).toEqual(["p-1", "p-2"]);
    expect(closes.map(call => call.params.pane_id)).not.toContain("root-1");
    expect(h.controller.tracked()).toEqual([]);
  });

  test("forgetTracked does not close panes whose ownership check fails and still forgets them", async () => {
    const h = makeController();
    start(h, "9102");
    await settle(h);
    h.rpc.responses["pane.get"] = () => ({
      pane: { pane_id: "p-1", label: "someone-elses-pane", agent: null, workspace_id: "w-1", tab_id: "t-1" },
    });
    await h.controller.forgetTracked();
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual([]); // ...but the mapping is forgotten
  });

  test("same id rehydrated after switch survives stale cleanup", async () => {
    const h = makeController();
    start(h, "9110");
    await settle(h);

    // Hold the old mapping's ownership check open: the switch cleanup is in
    // flight while the new session rehydrates a worker with the same id.
    let releaseOwnership;
    const gate = new Promise(resolve => {
      releaseOwnership = resolve;
    });
    h.rpc.responses["pane.get"] = () =>
      gate.then(() => ({
        pane: { pane_id: "p-1", label: `${LABEL_PREFIX}9110`, agent: null, workspace_id: "w-1", tab_id: "t-1" },
      }));

    const reset = h.controller.forgetTracked();
    await Promise.resolve();
    expect(h.controller.tracked()).toEqual(["9110"]); // cleanup still pending
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);

    start(h, "9110"); // fresh mapping for the same id
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(2); // p-1 (old) + p-2 (fresh)
    expect(h.controller.tracked()).toEqual(["9110"]);

    releaseOwnership();
    await reset;
    await settle(h);

    // Stale cleanup closed ONLY the old pane and left the fresh mapping alone.
    const closes = h.rpc.byMethod("pane.close");
    expect(closes).toHaveLength(1);
    expect(closes[0].params.pane_id).toBe("p-1");
    expect(h.controller.tracked()).toEqual(["9110"]);
  });

  test("forgetTracked with no tracked entries is a no-op", async () => {
    const h = makeController();
    await h.controller.forgetTracked();
    expect(h.rpc.calls).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown / failure resilience
// ─────────────────────────────────────────────────────────────────────────────

describe("shutdown", () => {
  test("session shutdown closes only owned panes", async () => {
    const h = makeController();
    start(h, "9050");
    start(h, "9051");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9050", "p-2": "9051" });
    h.controller.handleShutdown();
    await settle(h);
    const closes = h.rpc.byMethod("pane.close");
    expect(closes.map(call => call.params.pane_id).sort()).toEqual(["p-1", "p-2"]);
    expect(closes.map(call => call.params.pane_id)).not.toContain("root-1");
  });

  test("shutdown with no panes does nothing", async () => {
    const h = makeController();
    h.controller.handleShutdown();
    await settle(h);
    expect(h.rpc.calls).toHaveLength(0);
  });
});

describe("failure resilience", () => {
  test("split failure drops the mapping, never affects the worker, and a later started retries", async () => {
    const h = makeController();
    h.rpc.fail.add("pane.split");
    start(h, "9070");
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(1);
    expect(h.controller.tracked()).toEqual([]);
    h.rpc.fail.delete("pane.split");
    start(h, "9070");
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(2);
    expect(h.controller.tracked()).toEqual(["9070"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Enabling
// ─────────────────────────────────────────────────────────────────────────────

describe("enabling", () => {
  test("isEnabled requires herdr env, socket, root pane and not opt-out", () => {
    expect(isEnabled(env())).toBe(true);
    expect(isEnabled(env({ herdrEnabled: false }))).toBe(false);
    expect(isEnabled(env({ socketPath: undefined }))).toBe(false);
    expect(isEnabled(env({ rootPaneId: "" }))).toBe(false);
    expect(isEnabled(env({ optOut: true }))).toBe(false);
    expect(isEnabled({})).toBe(false);
    expect(isEnabled(null)).toBe(false);
  });

  test("install registers nothing when disabled and wires lifecycle/progress/shutdown when enabled", () => {
    const subscriptions = [];
    const fakePi = {
      events: { on(channel, handler) { subscriptions.push([channel, handler]); } },
      on(event, handler) { subscriptions.push([event, handler]); },
      logger: { error() {}, warn() {}, debug() {} },
    };
    const deps = { rpc: new FakeRpc(), fs: new FakeFs(), cwd: "/proj", debounceMs: 0 };
    expect(installAttachPaneController(fakePi, env({ optOut: true }), deps)).toBeNull();
    expect(subscriptions).toHaveLength(0);

    const controller = installAttachPaneController(fakePi, env(), deps);
    expect(controller).not.toBeNull();
    expect(subscriptions.map(entry => entry[0])).toEqual(["task:subagent:lifecycle", "task:subagent:progress", "session_shutdown"]);
  });

  test("subagent (hasUI false) never installs controller listeners", () => {
    const { pi, subscriptions } = makePi();
    ext(pi, SMOKE_ENV);
    pi.emit("session_start", {}, { hasUI: false });
    pi.emit("agent_start", {}, { hasUI: false });
    pi.emit("session_switch", {}, { hasUI: false });
    // Only the three activation listeners; no controller bus/tool listeners.
    expect(subscriptions.map(entry => entry[0])).toEqual(["session_start", "session_switch", "agent_start"]);
  });

  test("root UI session installs exactly once across activation events", () => {
    const { pi, subscriptions } = makePi();
    ext(pi, SMOKE_ENV);
    pi.emit("session_start", {}, { hasUI: true });
    pi.emit("agent_start", {}, { hasUI: true });
    pi.emit("session_switch", {}, { hasUI: true });
    const controllerSubs = subscriptions.filter(entry => !["session_start", "session_switch", "agent_start"].includes(entry[0]));
    expect(controllerSubs.map(entry => entry[0])).toEqual(["task:subagent:lifecycle", "task:subagent:progress", "session_shutdown"]);
  });

  test("HERDR_OMP_VIBE_PANES=0 installs no controller (drop-in opt-out)", () => {
    const { pi, subscriptions } = makePi();
    ext(pi, { ...SMOKE_ENV, HERDR_OMP_VIBE_PANES: "0" });
    pi.emit("session_start", {}, { hasUI: true });
    pi.emit("agent_start", {}, { hasUI: true });
    pi.emit("session_switch", {}, { hasUI: true });
    const controllerSubs = subscriptions.filter(entry => !["session_start", "session_switch", "agent_start"].includes(entry[0]));
    expect(controllerSubs).toHaveLength(0);
  });
});
