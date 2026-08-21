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

import { test, expect, describe, beforeAll, beforeEach, afterAll, afterEach, vi } from "bun:test";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import fsSync from "node:fs";
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
  resolveAttachBin,
  deriveAttachPaths,
  createSocketRpc,
  readEnv,
  SOURCE,
  LABEL_PREFIX,
  DEFAULT_RATIO,
  STACK_RATIO,
  DEFAULT_ATTACH_BIN,
  DEFAULT_DEBOUNCE_MS,
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
    this.filePaths = new Set();
    this.statCalls = [];
  }

  async stat(file) {
    this.statCalls.push(file);
    if (!this.dirs.has(file) && !this.filePaths.has(file)) {
      const err = new Error(`ENOENT: no such file or directory, stat '${file}'`);
      err.code = "ENOENT";
      throw err;
    }
    return { isDirectory: () => !this.filePaths.has(file) };
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
          // The events bus is the dispatchable surface: installAttachPaneController
          // subscribes lifecycle/progress through pi.events.on, so those handlers
          // must be reachable from emit() for production-wiring tests.
          const list = listeners.get(channel) ?? [];
          list.push(handler);
          listeners.set(channel, list);
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
    ratio: overrides.ratio,
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
      explicit: false,
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

  test("explicit endpoint metadata (attachSocket/attachTokenFile) spawns the pane without a session file", async () => {
    const h = makeController();
    // A no-session-parent worker (tmp fallback base dir): the started payload
    // carries NO sessionFile, only the explicit attach endpoint paths. The
    // runtime-dir existence check is bypassed (paths are authoritative).
    h.controller.handleLifecycle({
      id: "9007",
      description: "vibe good session",
      status: "started",
      attachSocket: "/tmp/omp-attach-x/attach.sock",
      attachTokenFile: "/tmp/omp-attach-x/attach.token",
    });
    await settle(h);
    const splits = h.rpc.byMethod("pane.split");
    expect(splits).toHaveLength(1);
    expect(splits[0].params.env).toEqual({
      [ATTACH_SOCKET_PATH_ENV]: "/tmp/omp-attach-x/attach.sock",
      [ATTACH_TOKEN_FILE_PATH_ENV]: "/tmp/omp-attach-x/attach.token",
    });
    const texts = h.rpc.byMethod("pane.send_text");
    expect(texts).toHaveLength(1);
    expect(texts[0].params.text).toBe(
      `omp attach 9007 --socket '/tmp/omp-attach-x/attach.sock' --token-file '/tmp/omp-attach-x/attach.token'`,
    );
    // The derived command must NOT reference a session file that does not exist.
    expect(texts[0].params.text).not.toContain("--session-file");
  });

  test("explicit endpoint metadata wins over session-file derivation when both are present", async () => {
    const h = makeController();
    h.controller.handleLifecycle({
      id: "9008",
      description: "vibe fast session",
      status: "started",
      sessionFile: childFile("9008"),
      attachSocket: "/tmp/omp-attach-y/attach.sock",
      attachTokenFile: "/tmp/omp-attach-y/attach.token",
    });
    await settle(h);
    const texts = h.rpc.byMethod("pane.send_text");
    expect(texts).toHaveLength(1);
    expect(texts[0].params.text).toBe(
      `omp attach 9008 --socket '/tmp/omp-attach-y/attach.sock' --token-file '/tmp/omp-attach-y/attach.token'`,
    );
  });

  test("invalid explicit endpoint metadata falls back to session-file derivation", async () => {
    const h = makeController();
    h.fs.dirs.add(runtimeDir("9009"));
    // attachTokenFile missing: the explicit source is invalid, so the
    // session-file derivation applies (runtime dir exists on disk).
    h.controller.handleLifecycle({
      id: "9009",
      description: "vibe fast session",
      status: "started",
      sessionFile: childFile("9009"),
      attachSocket: "/tmp/omp-attach-z/attach.sock",
    });
    await settle(h);
    const texts = h.rpc.byMethod("pane.send_text");
    expect(texts).toHaveLength(1);
    expect(texts[0].params.text).toBe(`omp attach 9009 --session-file '${parentFile("9009")}'`);
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
    expect(warns.join("\n")).toContain("without attach endpoint metadata or a usable parent session file");
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

// ─────────────────────────────────────────────────────────────────────────────
// resolveAttachBin (production attach-bin fallback)
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveAttachBin", () => {
  test("explicit non-empty attachBin wins", () => {
    expect(resolveAttachBin("bun run /x/client.ts", "/proc/x", "/proj/cli.ts")).toBe("bun run /x/client.ts");
  });

  test("source/npm launch: runtime + .ts/.js entry become one shell-quoted prefix", () => {
    expect(resolveAttachBin(undefined, "/usr/local/bin/bun", "/proj/cli.ts")).toBe("'/usr/local/bin/bun' '/proj/cli.ts'");
    expect(resolveAttachBin(undefined, "/opt/homebrew/bin/node", "/proj/dist/cli.js")).toBe("'/opt/homebrew/bin/node' '/proj/dist/cli.js'");
    // Paths containing spaces/quotes stay safe inside the single-quoted prefix.
    expect(resolveAttachBin(undefined, "/my bun/bin/bun", "/my dir/cli.ts")).toBe("'/my bun/bin/bun' '/my dir/cli.ts'");
  });

  test("omitted, empty, null, or non-string bin resolves to the compiled executable (injectable execPath)", () => {
    expect(resolveAttachBin(undefined, "/fork/dist/omp", null)).toBe("'/fork/dist/omp'");
    expect(resolveAttachBin("", "/fork/dist/omp", null)).toBe("'/fork/dist/omp'");
    expect(resolveAttachBin(null, "/fork/dist/omp", null)).toBe("'/fork/dist/omp'");
    expect(resolveAttachBin(42, "/fork/dist/omp", null)).toBe("'/fork/dist/omp'");
  });

  test("compiled executable with spaces or single quotes is shell-quoted", () => {
    expect(resolveAttachBin(undefined, "/my omp/bin/omp", null)).toBe("'/my omp/bin/omp'");
    expect(resolveAttachBin(undefined, "/path/with'quote/omp", null)).toBe("'/path/with'\\''quote/omp'");
  });

  test("a bare Bun/Node runtime with no CLI entry cannot route attach: DEFAULT_ATTACH_BIN applies", () => {
    expect(resolveAttachBin(undefined, "/usr/local/bin/bun", null)).toBe(DEFAULT_ATTACH_BIN);
    expect(resolveAttachBin(undefined, "/usr/local/bin/bun", "")).toBe(DEFAULT_ATTACH_BIN);
    expect(resolveAttachBin(undefined, "/opt/homebrew/bin/node", null)).toBe(DEFAULT_ATTACH_BIN);
    expect(resolveAttachBin(undefined, "C:\\bun\\bun.exe", null)).toBe(DEFAULT_ATTACH_BIN);
  });

  test("only when both the executable and entry are unavailable does DEFAULT_ATTACH_BIN apply", () => {
    expect(resolveAttachBin(undefined, "", null)).toBe(DEFAULT_ATTACH_BIN);
    expect(resolveAttachBin("", "", null)).toBe(DEFAULT_ATTACH_BIN);
    expect(resolveAttachBin(undefined, null, null)).toBe(DEFAULT_ATTACH_BIN);
  });

  test("the controller constructor applies the same fallback to the running executable", async () => {
    const fs = new FakeFs();
    fs.dirs.add(runtimeDir("9001"));
    const rpc = new FakeRpc();
    const controller = new AttachPaneController({
      rpc,
      fs,
      env: env(),
      debounceMs: 0,
      cwd: "/proj",
      attachBin: undefined, // the production wiring layer must not inject "omp" here
    });
    controller.handleLifecycle({ id: "9001", description: "vibe fast session", status: "started", sessionFile: childFile("9001") });
    await controller.flushPending();
    const texts = rpc.byMethod("pane.send_text");
    expect(texts).toHaveLength(1);
    // Under a source/npm launch (bun test argv[1] is this .ts file) the pane
    // command carries the runtime + CLI entry, each shell-quoted, so `attach`
    // routes to the subcommand instead of `bun attach`.
    expect(texts[0].params.text).toBe(
      `${quoteShellArg(process.execPath)} ${quoteShellArg(process.argv[1])} attach 9001 --session-file '${parentFile("9001")}'`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Constructor parsing & readEnv
// ─────────────────────────────────────────────────────────────────────────────

describe("constructor parsing & readEnv", () => {
  test("ratio accepts only (0,1); anything else falls back to DEFAULT_RATIO", async () => {
    let i = 0;
    for (const ratio of [0.5, 0.99, 0.01]) {
      const h = makeController({ ratio });
      start(h, `r${(i += 1)}`);
      await settle(h);
      expect(h.rpc.byMethod("pane.split")[0].params.ratio).toBe(ratio);
    }
    i = 0;
    for (const bad of [1, 0, -1, 2, NaN, undefined, "0.5"]) {
      const h = makeController({ ratio: bad });
      start(h, `b${(i += 1)}`);
      await settle(h);
      expect(h.rpc.byMethod("pane.split")[0].params.ratio).toBe(DEFAULT_RATIO);
    }
  });

  test("readEnv maps raw env fields and the exact opt-out value", () => {
    expect(readEnv({})).toEqual({ herdrEnabled: false, socketPath: undefined, rootPaneId: undefined, optOut: false });
    expect(
      readEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "r", HERDR_OMP_VIBE_PANES: "0" }),
    ).toEqual({ herdrEnabled: true, socketPath: "/s", rootPaneId: "r", optOut: true });
    // Non-"0" opt-out values leave the extension enabled; non-"1" HERDR_ENV disables.
    expect(readEnv({ HERDR_ENV: "true", HERDR_OMP_VIBE_PANES: "1" })).toEqual({
      herdrEnabled: false,
      socketPath: undefined,
      rootPaneId: undefined,
      optOut: false,
    });
    // Empty strings stay visible to the caller (isEnabled applies the length checks).
    expect(readEnv({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "", HERDR_PANE_ID: "" })).toEqual({
      herdrEnabled: true,
      socketPath: "",
      rootPaneId: "",
      optOut: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path & id boundaries
// ─────────────────────────────────────────────────────────────────────────────

describe("path & id boundaries", () => {
  test("root-directory and trailing-slash session files are rejected", () => {
    expect(deriveAttachPaths("/9001.jsonl", "9001")).toBeNull(); // parent dir is /
    expect(deriveAttachPaths("//9001.jsonl", "9001")).toBeNull();
    expect(deriveAttachPaths("/x/9001.jsonl/", "9001")).toBeNull(); // trailing slash breaks the suffix
    expect(deriveAttachPaths("/x/9001.jsonl/..", "9001")).toBeNull();
  });

  test("hyphen/underscore/uppercase ids are accepted; 64 chars yes, 65 no", () => {
    expect(isValidVibeId("a-b_C-1")).toBe(true);
    expect(isValidVibeId("A")).toBe(true);
    expect(isValidVibeId("a".repeat(64))).toBe(true);
    expect(isValidVibeId("a".repeat(65))).toBe(false);
    expect(isValidVibeId("")).toBe(false);
  });

  test("traversal and shell-shaped ids are rejected", () => {
    for (const id of ["..", "../x", "a/b", ".", "a b", "a;b", "a$(x)", "`x`", "a'b"]) {
      expect(isValidVibeId(id)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Spawn failure paths
// ─────────────────────────────────────────────────────────────────────────────

describe("spawn failure paths", () => {
  test("split returning no pane_id drops the mapping without closing anything", async () => {
    const h = makeController();
    h.rpc.responses["pane.split"] = () => ({ pane: {} });
    start(h, "9001");
    await settle(h);
    expect(h.controller.tracked()).toEqual([]);
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
  });

  test("rename failure drops the mapping and best-effort closes the created pane", async () => {
    const h = makeController();
    h.rpc.fail.add("pane.rename");
    start(h, "9001");
    await settle(h);
    expect(h.controller.tracked()).toEqual([]);
    expect(h.rpc.byMethod("pane.close")).toHaveLength(1);
    expect(h.rpc.byMethod("pane.close")[0].params.pane_id).toBe("p-1");
  });

  test("metadata failure drops the mapping and best-effort closes the created pane", async () => {
    const h = makeController();
    h.rpc.fail.add("pane.report_metadata");
    start(h, "9001");
    await settle(h);
    expect(h.controller.tracked()).toEqual([]);
    expect(h.rpc.byMethod("pane.close")).toHaveLength(1);
  });

  test("send_text failure warns and keeps the pane tracked (exit poll reclaims later)", async () => {
    const warns = [];
    const h = makeController({ log: { error() {}, warn(...args) { warns.push(args.join(" ")); }, debug() {} } });
    h.rpc.fail.add("pane.send_text");
    start(h, "9001");
    await settle(h);
    expect(h.controller.tracked()).toEqual(["9001"]);
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(warns.join("\n")).toContain("attach client start failed");
  });

  test("send_keys failure warns and keeps the pane tracked", async () => {
    const warns = [];
    const h = makeController({ log: { error() {}, warn(...args) { warns.push(args.join(" ")); }, debug() {} } });
    h.rpc.fail.add("pane.send_keys");
    start(h, "9001");
    await settle(h);
    expect(h.controller.tracked()).toEqual(["9001"]);
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(warns.join("\n")).toContain("attach client start failed");
  });

  test("runtime path that is a file (stat succeeds, not a directory) still creates the pane deterministically", async () => {
    const h = makeController();
    h.fs.filePaths.add(runtimeDir("9001"));
    start(h, "9001");
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(1);
    expect(h.controller.tracked()).toEqual(["9001"]);
  });

  test("runtime dir present but socket/token files missing still creates the pane; empty foreground never closes it", async () => {
    const h = makeController();
    start(h, "9001"); // FakeFs knows only the dir; no socket/token files exist
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(1);
    expect(h.controller.tracked()).toEqual(["9001"]);
    // Empty foreground process list is "unknown" — never treated as exit.
    h.rpc.responses["pane.process_info"] = () => ({
      process_info: { pane_id: "p-1", foreground_processes: [] },
    });
    await h.controller.checkClientExit("9001");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9001"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ownership & layout adversaries
// ─────────────────────────────────────────────────────────────────────────────

describe("ownership & layout adversaries", () => {
  test("workspace mismatch on the stacked target falls back to root/right", async () => {
    const h = makeController();
    h.rpc.responses["pane.get"] = () => ({
      pane: { pane_id: "p-1", label: `${LABEL_PREFIX}9001`, agent: null, workspace_id: "w-other", tab_id: "t-1" },
    });
    start(h, "9001");
    await settle(h);
    start(h, "9002");
    await settle(h);
    const splits = h.rpc.byMethod("pane.split");
    expect(splits[1].params).toMatchObject({ target_pane_id: "root-1", direction: "right", ratio: DEFAULT_RATIO });
  });

  test("tab mismatch on the stacked target falls back to root/right", async () => {
    const h = makeController();
    h.rpc.responses["pane.get"] = () => ({
      pane: { pane_id: "p-1", label: `${LABEL_PREFIX}9001`, agent: null, workspace_id: "w-1", tab_id: "t-other" },
    });
    start(h, "9001");
    await settle(h);
    start(h, "9002");
    await settle(h);
    const splits = h.rpc.byMethod("pane.split");
    expect(splits[1].params).toMatchObject({ target_pane_id: "root-1", direction: "right", ratio: DEFAULT_RATIO });
  });

  test("agent field on an otherwise owned pane does not reject ownership (it signals client liveness)", async () => {
    const h = makeController();
    // The attach pane's own foreground IS our `omp attach` client, which herdr
    // reports as an agent — the agent field must never reject ownership.
    h.rpc.responses["pane.get"] = params => ({
      pane: {
        pane_id: params.pane_id,
        label: `${LABEL_PREFIX}${params.pane_id === "p-1" ? "9001" : "9002"}`,
        agent: { id: "omp", name: "omp" },
        workspace_id: "w-1",
        tab_id: "t-1",
      },
    });
    start(h, "9001");
    await settle(h);
    start(h, "9002"); // second worker must stack DOWN onto the agent-owning pane
    await settle(h);
    const splits = h.rpc.byMethod("pane.split");
    expect(splits[1].params).toMatchObject({ target_pane_id: "p-1", direction: "down", ratio: STACK_RATIO });
    // Ownership also passes teardown: the owned pane is closed.
    await h.controller.forgetTracked();
    expect(h.rpc.byMethod("pane.close").map(call => call.params.pane_id).sort()).toEqual(["p-1", "p-2"]);
  });

  test("candidate pane.get failure falls back to root/right", async () => {
    const h = makeController();
    h.rpc.responses["pane.get"] = () => {
      throw new Error("fake rpc fail: pane.get");
    };
    start(h, "9001");
    await settle(h);
    start(h, "9002");
    await settle(h);
    const splits = h.rpc.byMethod("pane.split");
    expect(splits[1].params).toMatchObject({ target_pane_id: "root-1", direction: "right", ratio: DEFAULT_RATIO });
  });

  test("candidate pane that returned a different pane_id is not owned", async () => {
    const h = makeController();
    h.rpc.responses["pane.get"] = () => ({
      pane: { pane_id: "other-pane", label: `${LABEL_PREFIX}9001`, agent: null, workspace_id: "w-1", tab_id: "t-1" },
    });
    start(h, "9001");
    await settle(h);
    start(h, "9002");
    await settle(h);
    const splits = h.rpc.byMethod("pane.split");
    expect(splits[1].params).toMatchObject({ target_pane_id: "root-1", direction: "right" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Exit-detection markers
// ─────────────────────────────────────────────────────────────────────────────

describe("exit detection markers", () => {
  const ownedWith = extra => ({
    pane: { pane_id: "p-1", label: `${LABEL_PREFIX}9001`, agent: null, workspace_id: "w-1", tab_id: "t-1", ...extra },
  });

  for (const [name, extra] of [
    ["exit_code", { exit_code: 0 }],
    ["process:null", { process: null }],
    ["process.running:false", { process: { running: false } }],
    ["state:exited", { state: "exited" }],
    ["state:closed", { state: "closed" }],
  ]) {
    test(`${name} closes the owned pane`, async () => {
      const h = makeController();
      start(h, "9001");
      await settle(h);
      h.rpc.responses["pane.get"] = () => ownedWith(extra);
      await h.controller.checkClientExit("9001");
      expect(h.rpc.byMethod("pane.close")).toHaveLength(1);
      expect(h.controller.tracked()).toEqual([]);
    });
  }

  test("a tracked pane whose id changed is exited AND then forgotten without closing anything", async () => {
    const h = makeController();
    start(h, "9001");
    await settle(h);
    h.rpc.responses["pane.get"] = () => ({ pane: { pane_id: "replaced", label: `${LABEL_PREFIX}9001` } });
    await h.controller.checkClientExit("9001");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual([]);
  });

  test("an empty foreground process list never counts as exited, even after the client was seen", async () => {
    const h = makeController();
    start(h, "9001");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9001" });
    h.rpc.responses["pane.process_info"] = () => ({
      process_info: { pane_id: "p-1", foreground_processes: [{ name: "omp", argv: ["omp", "attach", "9001"] }] },
    });
    await h.controller.checkClientExit("9001");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    // Client disappears AND the foreground view empties: still unknown, no close.
    h.rpc.responses["pane.process_info"] = () => ({ process_info: { pane_id: "p-1", foreground_processes: [] } });
    await h.controller.checkClientExit("9001");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9001"]);
  });

  test("any argv element containing 'attach' counts as the client (substring rule)", async () => {
    const h = makeController();
    start(h, "9001");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9001" });
    h.rpc.responses["pane.process_info"] = () => ({
      process_info: { pane_id: "p-1", foreground_processes: [{ name: "reattach", argv: ["/usr/bin/reattach"] }] },
    });
    await h.controller.checkClientExit("9001");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9001"]);
  });

  test("attach-bin-only argv matches without the literal word 'attach'", async () => {
    const h = makeController({ attachBin: "/proj/dist/omp" });
    start(h, "9001");
    await settle(h);
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9001" });
    h.rpc.responses["pane.process_info"] = () => ({
      process_info: { pane_id: "p-1", foreground_processes: [{ name: "omp", argv: ["/proj/dist/omp"] }] },
    });
    await h.controller.checkClientExit("9001");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual(["9001"]);
    // Client gone: latch armed, owned pane closes.
    h.rpc.responses["pane.process_info"] = () => ({
      process_info: { pane_id: "p-1", foreground_processes: [{ name: "zsh", argv: ["-zsh"] }] },
    });
    await h.controller.checkClientExit("9001");
    expect(h.rpc.byMethod("pane.close")).toHaveLength(1);
  });

  test("untracked ids and pane-less in-flight entries are no-ops", async () => {
    const h = makeController();
    await h.controller.checkClientExit("never-tracked");
    expect(h.rpc.calls).toHaveLength(0);
    start(h, "9001");
    await settle(h);
    const before = h.rpc.byMethod("pane.get").length;
    // 9002's runtime dir is intentionally absent: its spawn will skip on stat,
    // so the entry carries no pane id for the whole window of this check.
    h.controller.handleLifecycle({ id: "9002", description: "vibe fast session", status: "started", sessionFile: childFile("9002") });
    await h.controller.checkClientExit("9002"); // paneId is null → no-op
    expect(h.rpc.byMethod("pane.get")).toHaveLength(before);
    await h.controller.flushPending();
    expect(h.controller.tracked()).toEqual(["9001"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client-exit poll scheduling (fake timers)
// ─────────────────────────────────────────────────────────────────────────────

describe("client-exit poll scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("first poll at min(debounceMs, exitPollMs), then every exitPollMs", async () => {
    const h = makeController({ debounceMs: 150, exitPollMs: 500 });
    start(h, "9001");
    await settle(h);
    expect(h.rpc.byMethod("pane.get")).toHaveLength(0);
    vi.advanceTimersByTime(149);
    await h.controller.flushPending();
    expect(h.rpc.byMethod("pane.get")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await h.controller.flushPending();
    expect(h.rpc.byMethod("pane.get")).toHaveLength(1);
    vi.advanceTimersByTime(500);
    await h.controller.flushPending();
    expect(h.rpc.byMethod("pane.get")).toHaveLength(2);
  });

  test("debounceMs 0 polls immediately at spawn completion, then every exitPollMs", async () => {
    const h = makeController({ debounceMs: 0, exitPollMs: 500 });
    start(h, "9001");
    await settle(h);
    expect(h.rpc.byMethod("pane.get")).toHaveLength(1); // first poll ran at ms 0
    vi.advanceTimersByTime(500);
    await h.controller.flushPending();
    expect(h.rpc.byMethod("pane.get")).toHaveLength(2);
  });

  test("invalid debounceMs falls back to DEFAULT_DEBOUNCE_MS for the first poll", async () => {
    const h = makeController({ debounceMs: -5, exitPollMs: 500 });
    start(h, "9001");
    await settle(h);
    vi.advanceTimersByTime(DEFAULT_DEBOUNCE_MS - 1);
    await h.controller.flushPending();
    expect(h.rpc.byMethod("pane.get")).toHaveLength(0);
    vi.advanceTimersByTime(1);
    await h.controller.flushPending();
    expect(h.rpc.byMethod("pane.get")).toHaveLength(1);
  });

  test("non-positive or NaN exitPollMs never schedules polls", async () => {
    for (const exitPollMs of [-1, 0, NaN]) {
      const h = makeController({ debounceMs: 0, exitPollMs });
      start(h, "9001");
      await settle(h);
      vi.advanceTimersByTime(5000);
      await h.controller.flushPending();
      expect(h.rpc.byMethod("pane.get")).toHaveLength(0);
    }
  });

  test("poll timers are cleared when the owned pane is torn down", async () => {
    const h = makeController({ debounceMs: 0, exitPollMs: 500 });
    start(h, "9001");
    await settle(h);
    expect(h.rpc.byMethod("pane.get")).toHaveLength(1);
    await h.controller.forgetTracked();
    await h.controller.flushPending();
    const afterTeardown = h.rpc.byMethod("pane.get").length;
    vi.advanceTimersByTime(10000);
    await h.controller.flushPending();
    expect(h.rpc.byMethod("pane.get")).toHaveLength(afterTeardown);
  });

  test("poll callback exceptions are logged and polling continues", async () => {
    const errors = [];
    const h = makeController({
      debounceMs: 0,
      exitPollMs: 500,
      log: { error(...args) { errors.push(args.join(" ")); }, warn() {}, debug() {} },
    });
    start(h, "9001");
    await settle(h);
    h.controller.checkClientExit = () => {
      throw new Error("boom");
    };
    vi.advanceTimersByTime(500);
    await h.controller.flushPending();
    expect(errors.join("\n")).toContain("exit poll enqueue failed");
    vi.advanceTimersByTime(500);
    await h.controller.flushPending();
    expect(errors.filter(line => line.includes("exit poll enqueue failed"))).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Shutdown / progress / races
// ─────────────────────────────────────────────────────────────────────────────

describe("shutdown / progress / races", () => {
  test("an in-flight spawn after shutdown self-aborts and never creates a live pane", async () => {
    const h = makeController();
    const { promise: splitGate, resolve: releaseSplit } = Promise.withResolvers();
    h.rpc.responses["pane.split"] = () => splitGate.then(() => ({ pane: { pane_id: "p-9", workspace_id: "w-1", tab_id: "t-1" } }));
    start(h, "9001");
    // Drain microtasks until the spawn reaches the gated split (bounded).
    for (let i = 0; i < 20 && h.rpc.byMethod("pane.split").length === 0; i += 1) {
      await Promise.resolve();
    }
    expect(h.rpc.byMethod("pane.split")).toHaveLength(1);
    h.controller.handleShutdown();
    // The mapping is forgotten synchronously; the spawn is still gated on the
    // split, so flushing now would deadlock on the pending action queue.
    expect(h.controller.tracked()).toEqual([]);
    releaseSplit();
    await h.controller.flushPending();
    // The split resolved AFTER shutdown: the pane is closed immediately and
    // never renamed/started, and the mapping is gone.
    expect(h.rpc.byMethod("pane.split")).toHaveLength(1);
    expect(h.rpc.byMethod("pane.close")).toHaveLength(1);
    expect(h.rpc.byMethod("pane.close")[0].params.pane_id).toBe("p-9");
    expect(h.rpc.byMethod("pane.rename")).toHaveLength(0);
    expect(h.rpc.byMethod("pane.send_text")).toHaveLength(0);
    expect(h.controller.tracked()).toEqual([]);
  });

  test("pane.close failure during shutdown is logged and the mapping is still forgotten", async () => {
    const warns = [];
    const h = makeController({ log: { error() {}, warn(...args) { warns.push(args.join(" ")); }, debug() {} } });
    h.rpc.responses["pane.get"] = ownedPaneGet({ "p-1": "9001" });
    h.rpc.fail.add("pane.close");
    start(h, "9001");
    await settle(h);
    h.controller.handleShutdown();
    await settle(h);
    expect(warns.join("\n")).toContain("pane.close failed");
    expect(h.controller.tracked()).toEqual([]);
  });

  test("non-terminal and malformed progress events are no-ops", async () => {
    const h = makeController();
    start(h, "9001");
    await settle(h);
    const before = h.rpc.calls.length;
    h.controller.handleProgress({ progress: { id: "9001", status: "running" } });
    h.controller.handleProgress({ progress: { id: "9001" } }); // missing status
    h.controller.handleProgress({ progress: { id: "untracked" } });
    h.controller.handleProgress({ progress: null });
    h.controller.handleProgress({ progress: { id: 12345 } });
    h.controller.handleProgress({ progress: { id: "bad id!" } });
    h.controller.handleProgress(null);
    h.controller.handleProgress({});
    await settle(h);
    expect(h.rpc.calls.length).toBe(before);
    expect(h.controller.tracked()).toEqual(["9001"]);
  });

  test("untracked and invalid terminal lifecycle events are no-ops", async () => {
    const warns = [];
    const h = makeController({ log: { error() {}, warn(...args) { warns.push(args.join(" ")); }, debug() {} } });
    const before = h.rpc.calls.length;
    h.controller.handleLifecycle({ id: "9999", status: "completed" });
    h.controller.handleLifecycle({ id: "bad id!", status: "aborted" });
    h.controller.handleLifecycle({ id: "9001", status: "completed", description: "task subagent" }); // untracked id
    await settle(h);
    expect(h.rpc.calls.length).toBe(before);
    expect(warns.join("\n")).toContain("invalid id");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Real JSON-line socket transport
// ─────────────────────────────────────────────────────────────────────────────

function startJsonLineServer(responses, socketPath) {
  const received = [];
  const server = net.createServer(socket => {
    let buffer = "";
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
        if (!msg || typeof msg.id !== "string") continue;
        received.push({ method: msg.method, params: msg.params });
        const handler = responses[msg.method];
        if (!handler) {
          socket.write(`${JSON.stringify({ id: msg.id, error: { message: `no handler for ${msg.method}` } })}\n`);
          continue;
        }
        const out = handler(msg, socket);
        if (out !== undefined) socket.write(`${JSON.stringify({ id: msg.id, ...out })}\n`);
      }
    });
  });
  return new Promise(resolve => server.listen(socketPath, () => resolve({ server, received })));
}

// Real-socket integration: arrival timing is driven by the platform network
// stack, which deterministic fake timers cannot control, so a bounded poll is
// the only way to observe the frame landing (deliberate rare exception to the
// no-real-timers rule).
async function waitFor(cond, timeoutMs = 1500) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await Bun.sleep(5);
  }
}

describe("real socket RPC (JSON-line transport)", () => {
  const SOCKET_PATH = path.join(os.tmpdir(), "hdr-rpc-test.sock");
  let server;
  let received;
  let rpc;

  beforeAll(async () => {
    fsSync.rmSync(SOCKET_PATH, { force: true });
    ({ server, received } = await startJsonLineServer(
      {
        "pane.get": () => ({ result: { pane: { pane_id: "p-1" } } }),
        "pane.ok": () => ({ result: { ok: true } }),
        "pane.b": () => ({ result: "B" }),
      },
      SOCKET_PATH,
    ));
  });

  afterAll(() => {
    server?.close();
    fsSync.rmSync(SOCKET_PATH, { force: true });
  });

  beforeEach(() => {
    rpc = createSocketRpc(SOCKET_PATH, { timeoutMs: 1500 });
  });

  test("resolves a result frame carrying the matching id", async () => {
    await expect(rpc.request("pane.ok", {})).resolves.toEqual({ ok: true });
  });

  test("fragmented writes reassemble into one frame", async () => {
    const { server: fragServer } = await startJsonLineServer(
      {
        "pane.frag": (msg, socket) => {
          const payload = JSON.stringify({ id: msg.id, result: { frag: true } });
          const mid = Math.floor(payload.length / 2);
          socket.write(payload.slice(0, mid));
          // Real socket I/O: the second half must land in a later TCP segment.
          // Fake timers cannot drive a net socket, so a genuine short delay is
          // the only way to exercise cross-chunk reassembly.
          setTimeout(() => socket.write(payload.slice(mid) + "\n"), 10);
          return undefined;
        },
      },
      path.join(os.tmpdir(), "hdr-rpc-frag.sock"),
    );
    try {
      const fragRpc = createSocketRpc(path.join(os.tmpdir(), "hdr-rpc-frag.sock"));
      await expect(fragRpc.request("pane.frag", {})).resolves.toEqual({ frag: true });
    } finally {
      fragServer.close();
      fsSync.rmSync(path.join(os.tmpdir(), "hdr-rpc-frag.sock"), { force: true });
    }
  });

  test("foreign-id and multiple frames in one chunk are routed correctly", async () => {
    const { server: multiServer } = await startJsonLineServer(
      {
        "pane.multi": (msg, socket) => {
          socket.write(`${JSON.stringify({ id: "foreign-1", result: "x" })}\n`);
          socket.write(`${JSON.stringify({ id: msg.id, result: "mine" })}\n`);
          return undefined;
        },
      },
      path.join(os.tmpdir(), "hdr-rpc-multi.sock"),
    );
    try {
      const multiRpc = createSocketRpc(path.join(os.tmpdir(), "hdr-rpc-multi.sock"));
      await expect(multiRpc.request("pane.multi", {})).resolves.toBe("mine");
    } finally {
      multiServer.close();
      fsSync.rmSync(path.join(os.tmpdir(), "hdr-rpc-multi.sock"), { force: true });
    }
  });

  test("malformed and blank lines are skipped", async () => {
    const { server: skipServer } = await startJsonLineServer(
      {
        "pane.skip": (msg, socket) => {
          socket.write("not-json\n\n{\"id\":\"other\",\"result\":1}\n");
          socket.write(`${JSON.stringify({ id: msg.id, result: "clean" })}\n`);
          return undefined;
        },
      },
      path.join(os.tmpdir(), "hdr-rpc-skip.sock"),
    );
    try {
      const skipRpc = createSocketRpc(path.join(os.tmpdir(), "hdr-rpc-skip.sock"));
      await expect(skipRpc.request("pane.skip", {})).resolves.toBe("clean");
    } finally {
      skipServer.close();
      fsSync.rmSync(path.join(os.tmpdir(), "hdr-rpc-skip.sock"), { force: true });
    }
  });

  test("structured and string errors reject with described messages", async () => {
    const { server: errServer } = await startJsonLineServer(
      {
        "pane.struct": () => ({ error: { code: "E_BOOM", message: "boom" } }),
        "pane.string": () => ({ error: "nope" }),
      },
      path.join(os.tmpdir(), "hdr-rpc-err.sock"),
    );
    try {
      const errRpc = createSocketRpc(path.join(os.tmpdir(), "hdr-rpc-err.sock"));
      await expect(errRpc.request("pane.struct", {})).rejects.toThrow("E_BOOM: boom");
      await expect(errRpc.request("pane.string", {})).rejects.toThrow("nope");
    } finally {
      errServer.close();
      fsSync.rmSync(path.join(os.tmpdir(), "hdr-rpc-err.sock"), { force: true });
    }
  });

  test("pre-connect failure rejects with the connection error", async () => {
    const missing = path.join(os.tmpdir(), `hdr-missing-${Date.now()}.sock`);
    const badRpc = createSocketRpc(missing, { timeoutMs: 300 });
    // Linux surfaces ECONNREFUSED; macOS surfaces ENOENT for a missing socket path.
    await expect(badRpc.request("pane.ok", {})).rejects.toThrow(/ECONNREFUSED|ENOENT|refused|no such file/i);
  });

  test("timeout rejects with the exact timeout message", async () => {
    const { server: tmoServer } = await startJsonLineServer(
      {
        "pane.silent": () => undefined, // never respond
      },
      path.join(os.tmpdir(), "hdr-rpc-tmo.sock"),
    );
    try {
      const tmoRpc = createSocketRpc(path.join(os.tmpdir(), "hdr-rpc-tmo.sock"), { timeoutMs: 50 });
      await expect(tmoRpc.request("pane.silent", {})).rejects.toThrow("herdr rpc timeout: pane.silent");
    } finally {
      tmoServer.close();
      fsSync.rmSync(path.join(os.tmpdir(), "hdr-rpc-tmo.sock"), { force: true });
    }
  });

  test("remote end rejects with the socket-closed message", async () => {
    const { server: endServer } = await startJsonLineServer(
      {
        "pane.end": (_msg, socket) => {
          socket.destroy();
          return undefined;
        },
      },
      path.join(os.tmpdir(), "hdr-rpc-end.sock"),
    );
    try {
      const endRpc = createSocketRpc(path.join(os.tmpdir(), "hdr-rpc-end.sock"), { timeoutMs: 500 });
      await expect(endRpc.request("pane.end", {})).rejects.toThrow("herdr socket closed: pane.end");
    } finally {
      endServer.close();
      fsSync.rmSync(path.join(os.tmpdir(), "hdr-rpc-end.sock"), { force: true });
    }
  });

  test("concurrent requests resolve independently by id", async () => {
    const [a, b] = await Promise.all([rpc.request("pane.ok", {}), rpc.request("pane.b", {})]);
    expect(a).toEqual({ ok: true });
    expect(b).toBe("B");
  });

  test("every request carries one newline-terminated JSON frame with id/method/params", async () => {
    await rpc.request("pane.ok", { x: 1 });
    const frames = received.filter(entry => entry.method === "pane.ok");
    const frame = frames.at(-1);
    expect(frame.params).toEqual({ x: 1 });
    for (const other of frames) {
      expect(typeof other.params).toBe("object");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Production wiring (default export through a real socket + real fs)
// ─────────────────────────────────────────────────────────────────────────────

describe("production wiring (default export)", () => {
  const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), "herdr-attach-prod-"));
  const SOCKET_PATH = path.join(os.tmpdir(), "hdr-prod.sock");
  const child = id => path.join(TMP, id, `${id}.jsonl`);
  const parent = id => path.join(TMP, `${id}.jsonl`);
  const runtime = id => path.join(TMP, id, "attach");

  const PROD_RESPONSES = {
    "pane.split": () => ({ result: { pane: { pane_id: "p-1", workspace_id: "w-1", tab_id: "t-1" } } }),
    "pane.rename": () => ({ result: { changed: true } }),
    "pane.report_metadata": () => ({ result: {} }),
    "pane.send_text": () => ({ result: {} }),
    "pane.send_keys": () => ({ result: {} }),
    "pane.close": () => ({ result: {} }),
  };

  let server;
  let received;

  beforeAll(async () => {
    fsSync.rmSync(SOCKET_PATH, { force: true });
    ({ server, received } = await startJsonLineServer(PROD_RESPONSES, SOCKET_PATH));
  });

  afterAll(() => {
    server?.close();
    fsSync.rmSync(SOCKET_PATH, { force: true });
    fsSync.rmSync(TMP, { recursive: true, force: true });
  });

  beforeEach(() => {
    fsSync.mkdirSync(runtime("9001"), { recursive: true });
    received.length = 0;
  });

  function driveWorker(envOverrides) {
    const { pi } = makePi();
    ext(pi, {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: SOCKET_PATH,
      HERDR_PANE_ID: "w18:p1",
      HERDR_OMP_VIBE_PANES: undefined,
      HERDR_OMP_VIBE_PANES_CWD: "/proj",
      ...envOverrides,
    });
    pi.emit("session_start", {}, { hasUI: true });
    pi.emit(
      "task:subagent:lifecycle",
      { id: "9001", description: "vibe fast session", status: "started", sessionFile: child("9001") },
      {},
    );
    return pi;
  }

  test("unset HERDR_OMP_ATTACH_BIN uses the running CLI (runtime + entry) in the pane command", async () => {
    driveWorker({});
    await waitFor(() => received.some(entry => entry.method === "pane.send_text"));
    const sendText = received.find(entry => entry.method === "pane.send_text");
    // Source/npm launch: the runtime plus the .ts/.js entry, shell-quoted, so
    // `attach` routes to the subcommand (never a bare `bun attach`).
    expect(sendText.params.text).toBe(
      `${quoteShellArg(process.execPath)} ${quoteShellArg(process.argv[1])} attach 9001 --session-file '${parent("9001")}'`,
    );
    expect(sendText.params.text.startsWith("omp attach")).toBe(false);
    expect(sendText.params.text.startsWith("bun attach")).toBe(false);
    // The split env still carries exactly the two path variables.
    const split = received.find(entry => entry.method === "pane.split");
    expect(Object.keys(split.params.env).sort()).toEqual([ATTACH_SOCKET_PATH_ENV, ATTACH_TOKEN_FILE_PATH_ENV].sort());
    expect(split.params.env[ATTACH_SOCKET_PATH_ENV]).toBe(path.join(runtime("9001"), ATTACH_SOCKET_FILE));
  });

  test("explicit HERDR_OMP_ATTACH_BIN passes through verbatim", async () => {
    driveWorker({ HERDR_OMP_ATTACH_BIN: "bun run /x/client.ts" });
    await waitFor(() => received.some(entry => entry.method === "pane.send_text"));
    const sendText = received.find(entry => entry.method === "pane.send_text");
    expect(sendText.params.text).toBe(`bun run /x/client.ts attach 9001 --session-file '${parent("9001")}'`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security
// ─────────────────────────────────────────────────────────────────────────────

describe("security", () => {
  test("no token or capability material ever leaves via RPC payloads, env, or logs", async () => {
    const warns = [];
    const errors = [];
    const h = makeController({
      log: { error(...args) { errors.push(args.join(" ")); }, warn(...args) { warns.push(args.join(" ")); }, debug() {} },
    });
    const TOKEN = "0123456789abcdefdeadbeef";
    // The token VALUE (the 0600 file's capability) is never read or emitted;
    // only the file PATH travels. Place the token-shaped string in the paths
    // and prove it never reaches the wire as a value.
    start(h, "9001");
    await settle(h);
    await h.controller.forgetTracked();
    const serialized = JSON.stringify(h.rpc.calls);
    expect(serialized).not.toContain(TOKEN);
    for (const call of h.rpc.calls) {
      if (call.params && typeof call.params.env === "object" && call.params.env !== null) {
        expect(Object.keys(call.params.env).sort()).toEqual([ATTACH_SOCKET_PATH_ENV, ATTACH_TOKEN_FILE_PATH_ENV].sort());
      }
    }
    expect([...warns, ...errors].join("\n")).not.toContain(TOKEN);
  });

  test("hostile session paths stay inside the single-quoted argument and never split the command", async () => {
    const h = makeController();
    const hostile = "/proj/with space/it's $(rm -rf /) `touch pwned`/9001.jsonl";
    h.fs.dirs.add(`${path.dirname(hostile)}/attach`);
    h.controller.handleLifecycle({ id: "9001", description: "vibe fast session", status: "started", sessionFile: hostile });
    await settle(h);
    const texts = h.rpc.byMethod("pane.send_text");
    expect(texts).toHaveLength(1);
    const cmd = texts[0].params.text;
    const quoted = cmd.slice(cmd.indexOf("--session-file ") + "--session-file ".length);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    expect(quoted).toContain("$(rm -rf /)");
    expect(quoted).toContain("`touch pwned`");
    // The embedded single quote is shell-escaped as '\'' inside the argument.
    expect(quoted).toContain("it'\\''s");
    // The metacharacters stay INSIDE the quoted argument (inert) — everything
    // after --session-file lives in the single-quoted region.
    expect(cmd).not.toMatch(/;\s/);
    expect(cmd.indexOf("$(")).toBeGreaterThan(cmd.indexOf("--session-file "));
  });

  test("worker ids can never escape the label or command contract", async () => {
    const h = makeController();
    h.controller.handleLifecycle({ id: "a$(touch /tmp/pwned)", description: "vibe fast session", status: "started", sessionFile: childFile("a$(touch /tmp/pwned)") });
    h.controller.handleLifecycle({ id: "x;rm -rf /", description: "vibe fast session", status: "started", sessionFile: childFile("x;rm -rf /") });
    await settle(h);
    expect(h.rpc.byMethod("pane.split")).toHaveLength(0);
    expect(h.rpc.byMethod("pane.send_text")).toHaveLength(0);
  });
});
