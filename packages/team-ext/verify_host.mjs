/**
 * Host-half verification for the P0 team cache/prefix audit plugin.
 *
 * Unlike `verify.mjs` (pure record reduction), this test loads the real `index.js`
 * against a minimal fake Cordis context: it exercises config validation, role
 * resolution, buffered writes, the flush timer, dispose-time flush, and the
 * "one broken path must not throw" rule. It never touches the DSH runtime.
 *
 * Usage: node verify_host.mjs
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { apply } from "./index.js";

let passed = 0;
/** @type {string[]} */
const failures = [];

/**
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(detail === undefined ? label : `${label} — ${detail}`);
}

const LEAD = { id: "session-lead" };
const REVIEWER = { id: "session-reviewer" };
const SUB = { id: "session-sub" };

/** Build a fake Cordis context with the surface `index.js` actually uses. */
function fakeContext() {
  /** @type {Map<string, Function>} */
  const listeners = new Map();
  /** @type {Function[]} */
  const disposers = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Map<string, object>} */
  const agents = new Map([
    [LEAD.id, { session: LEAD }],
    [REVIEWER.id, { session: REVIEWER }],
    [SUB.id, { session: SUB }],
  ]);
  const teams = {
    tryMembership(agent) {
      if (agent.session.id === LEAD.id) return { role: "lead", name: "lead" };
      if (agent.session.id === REVIEWER.id) return { role: "teammate", name: "reviewer" };
      return undefined;
    },
  };
  const ctx = {
    agents: { get: (id) => agents.get(id) },
    get: (name) => (name === "agentTeams" ? teams : undefined),
    logger: { info: () => {}, warn: (message) => warnings.push(message) },
    on: (name, listener) => listeners.set(name, listener),
    effect: (callback) => disposers.push(callback()),
    emit: (session, event) => listeners.get("session/event")?.(session, event),
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose?.();
    },
    warnings,
  };
  return ctx;
}

/** Read every cache-events file in a directory as parsed records. */
function readRecords(directory) {
  /** @type {object[]} */
  const records = [];
  for (const name of readdirSync(directory)) {
    if (!name.startsWith("cache-events-") || !name.endsWith(".jsonl")) continue;
    for (const line of readFileSync(path.join(directory, name), "utf8").split("\n")) {
      if (line.trim().length > 0) records.push(JSON.parse(line));
    }
  }
  return records;
}

const workdir = mkdtempSync(path.join(tmpdir(), "team-ext-host-"));

try {
  // --- 1. records land on disk, with the Team role resolved per session -----
  {
    const logDir = path.join(workdir, "records");
    const ctx = fakeContext();
    apply(ctx, { logDir, flushMs: 100 });
    ctx.emit(LEAD, { type: "request/header", data: { reason: "initial", startsSeries: true, header: { tools: [] } } });
    ctx.emit(REVIEWER, {
      type: "assistant/message",
      data: { turn: 1, step: 1, message: { source: { provider: "p", model: "m" } }, usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 90 } },
    });
    ctx.emit(SUB, { type: "tool/call", data: { name: "read", callId: "c", arguments: {} } });
    ctx.dispose();
    const records = readRecords(logDir);
    check("host writes records", records.length === 3, `got ${records.length}`);
    check("host lead role", records[0].r === "lead", records[0]?.r);
    check("host teammate role", records[1].r === "teammate:reviewer", records[1]?.r);
    check("host sub role", records[2].r === "sub", records[2]?.r);
    check("host hit rate", records[1].hit === 0.9, `got ${records[1]?.hit}`);
    check("host no warnings", ctx.warnings.length === 0, ctx.warnings.join("; "));
  }

  // --- 2. dispose flushes the buffer even before the timer fires ------------
  {
    const logDir = path.join(workdir, "flush-on-dispose");
    const ctx = fakeContext();
    apply(ctx, { logDir, flushMs: 60000 });
    ctx.emit(LEAD, { type: "tool/call", data: { name: "read", callId: "c", arguments: {} } });
    check("buffer not yet on disk", readdirSync(workdir).includes("flush-on-dispose") === false);
    ctx.dispose();
    check("dispose flushes", readRecords(logDir).length === 1);
  }

  // --- 3. disabled config subscribes to nothing and writes nothing ----------
  {
    const logDir = path.join(workdir, "disabled");
    const ctx = fakeContext();
    apply(ctx, { logDir, enabled: false });
    ctx.emit(LEAD, { type: "tool/call", data: { name: "read", callId: "c", arguments: {} } });
    ctx.dispose();
    check("disabled writes nothing", readdirSync(workdir).includes("disabled") === false);
  }

  // --- 4. bad config fails loudly instead of silently doing nothing ---------
  {
    let message = "";
    try {
      apply(fakeContext(), { logDir: workdir, unknownKey: true });
    } catch (error) {
      message = String(error?.message ?? error);
    }
    check("unknown config key rejected", message.includes("unknown config key"), message);
    message = "";
    try {
      apply(fakeContext(), { flushMs: 5 });
    } catch (error) {
      message = String(error?.message ?? error);
    }
    check("out-of-range flushMs rejected", message.includes("flushMs"), message);
  }

  // --- 5. an unwritable path warns once and never throws -------------------
  {
    const blocker = path.join(workdir, "not-a-directory");
    writeFileSync(blocker, "x", "utf8");
    const ctx = fakeContext();
    let threw = false;
    try {
      apply(ctx, { logDir: path.join(blocker, "nested"), flushMs: 100 });
      ctx.emit(LEAD, { type: "tool/call", data: { name: "read", callId: "c", arguments: {} } });
      ctx.emit(LEAD, { type: "tool/call", data: { name: "read", callId: "d", arguments: {} } });
      ctx.dispose();
    } catch {
      threw = true;
    }
    check("unwritable path does not throw", threw === false);
    check("unwritable path warns once", ctx.warnings.length === 1, `got ${ctx.warnings.length}`);
    check("unwritable warning names the directory", String(ctx.warnings[0] ?? "").includes("cannot write"), ctx.warnings[0]);
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`FAILED ${failures.length} check(s), passed ${passed}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${passed} host checks passed`);
}
