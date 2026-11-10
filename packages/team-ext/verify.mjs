/**
 * Offline verification for the P0 team cache/prefix audit recorder.
 *
 * Pure Node: it imports only `core.mjs`, so it needs no DSH runtime, no installed
 * plugin, and no network. It exercises the JSONL record schema that the Host half
 * will write, including the two failure modes that matter most in practice — a
 * provider that omits usage, and a low cache-hit streak that must warn exactly once.
 *
 * Usage: node verify.mjs
 */
import { createRecorder, SCHEMA_VERSION } from "./core.mjs";

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

/**
 * @param {Array<[object, object]>} events
 * @param {object} [options]
 */
function run(events, options = {}) {
  /** @type {object[]} */
  const records = [];
  const recorder = createRecorder({
    emit: (record) => records.push(record),
    roleOf: () => "lead",
    now: () => 1700000000000,
    ...options,
  });
  for (const [session, event] of events) recorder(session, event);
  return records;
}

const SESSION = { id: "session-1" };
const event = (type, data = {}) => [SESSION, { type, data }];

// --- 1. header: a new series is the only prefix-reset signal -----------------
{
  const records = run([event("request/header", {
    reason: "initial",
    startsSeries: true,
    header: { config: { provider: "p", model: "m" }, tools: [{ name: "a" }, { name: "b" }] },
  })]);
  check("header emits one record", records.length === 1, `got ${records.length}`);
  const [record] = records;
  check("header kind", record.k === "header");
  check("header series flag", record.series === true);
  check("header reason", record.reason === "initial");
  check("header tool count", record.tools === 2, `got ${record.tools}`);
  check("header provider", record.prov === "p");
  check("header schema version", record.v === SCHEMA_VERSION);
  check("header role", record.r === "lead");
}

// --- 2. usage: raw buckets plus an explicit denominator ---------------------
{
  const records = run([event("assistant/message", {
    turn: 3,
    step: 2,
    message: { source: { provider: "p", model: "m" } },
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 0 },
  })]);
  const [record] = records;
  check("req emits one record", records.length === 1, `got ${records.length}`);
  check("req kind", record.k === "req");
  check("req turn/step", record.turn === 3 && record.step === 2);
  check("req raw input", record.in === 1000);
  check("req raw output", record.out === 100);
  check("req raw cache read", record.cr === 9000);
  check("req denominator", record.denom === 10000, `got ${record.denom}`);
  check("req hit rate", record.hit === 0.9, `got ${record.hit}`);
  check("req not interrupted", record.interrupted === false);
}

// --- 3. a provider that omits usage still yields a comparable record ---------
{
  const records = run([event("assistant/message", { turn: 1, step: 1, message: { source: {} } })]);
  const [record] = records;
  check("nousage emits one record", records.length === 1, `got ${records.length}`);
  check("nousage fields null", record.in === null && record.out === null && record.hit === null);
  check("nousage denominator null", record.denom === null);
}

// --- 4. low-hit streak warns exactly once at the configured threshold -------
{
  const low = () => event("assistant/message", {
    turn: 1,
    step: 1,
    message: { source: { provider: "p", model: "m" } },
    usage: { inputTokens: 900, outputTokens: 10, cacheReadTokens: 100 },
  });
  const records = run([low(), low(), low(), low()]);
  const warnings = records.filter((record) => record.k === "warn");
  check("warn fires exactly once", warnings.length === 1, `got ${warnings.length}`);
  check("warn streak value", warnings[0]?.streak === 3, `got ${warnings[0]?.streak}`);
  check("warn hit value", warnings[0]?.hit === 0.1, `got ${warnings[0]?.hit}`);
}

// --- 5. a good request resets the streak ------------------------------------
{
  const low = () => event("assistant/message", {
    message: { source: {} },
    usage: { inputTokens: 900, cacheReadTokens: 100 },
  });
  const high = () => event("assistant/message", {
    message: { source: {} },
    usage: { inputTokens: 100, cacheReadTokens: 900 },
  });
  const records = run([low(), low(), high(), low(), low()]);
  check("good request resets streak", records.filter((record) => record.k === "warn").length === 0);
}

// --- 6. compaction: start/end/summary/prune are all rewrite evidence --------
{
  const records = run([
    event("compaction/start", { compactionId: "c1", turn: 4 }),
    event("compaction/summary", {
      compactionId: "c1",
      shadowedTokenCount: 120000,
      shadowedRange: { start: 12, end: 88 },
      provider: "p",
      model: "m",
      usage: { inputTokens: 5000, cacheReadTokens: 100000 },
    }),
    event("compaction/prune", { shadowedTokenCount: 3000, shadowedRange: { start: 7, end: 7 } }),
    event("compaction/end", { compactionId: "c1", turn: 4 }),
  ]);
  const kinds = records.map((record) => record.ty);
  check("compaction record count", records.length === 4, `got ${records.length}`);
  check("compaction order", kinds.join(",") === "start,summary,prune,end", kinds.join(","));
  const summary = records[1];
  check("summary shadowed tokens", summary.shadowed === 120000);
  check("summary range", summary.start === 12 && summary.end === 88);
  check("summary cached input", summary.cr === 100000);
  const prune = records[2];
  check("prune range", prune.start === 7 && prune.end === 7);
}

// --- 7. tool call/result sizes, including a cyclic argument object ----------
{
  const cyclic = { name: "loop" };
  cyclic.self = cyclic;
  const records = run([
    event("tool/call", { turn: 1, step: 1, callId: "call-1", name: "list_agents", arguments: { a: 1 } }),
    event("tool/result", {
      turn: 1,
      step: 1,
      message: { callId: "call-1", content: [{ type: "text", text: "x".repeat(12000) }, { type: "image" }] },
    }),
    event("tool/call", { turn: 1, step: 1, callId: "call-2", name: "bash", arguments: cyclic }),
  ]);
  check("tool record count", records.length === 3, `got ${records.length}`);
  check("call name", records[0].name === "list_agents");
  check("call arg size", records[0].args === 7, `got ${records[0].args}`);
  check("result chars", records[1].chars === 12000, `got ${records[1].chars}`);
  check("result block count", records[1].blocks === 2);
  check("result not error", records[1].err === false);
  check("cyclic args do not throw", records[2].args === 0, `got ${records[2].args}`);
}

// --- 8. tool results can be suppressed without losing call records ---------
{
  const records = run([
    event("tool/call", { name: "read", callId: "c", arguments: {} }),
    event("tool/result", { message: { callId: "c", content: [{ type: "text", text: "abc" }] } }),
  ], { recordToolResults: false });
  check("tool results suppressed", records.length === 1 && records[0].k === "tcall", `got ${records.length}`);
}

// --- 9. team board changes are recorded from the Lead session --------------
{
  const records = run([
    event("team/member", { version: 2, member: { name: "reviewer", phase: "active" } }),
    event("team/task", { version: 2, task: { id: "task-3", status: "in_progress", ownerName: "reviewer", revision: 2 } }),
  ]);
  check("team record count", records.length === 2, `got ${records.length}`);
  check("team member", records[0].name === "reviewer" && records[0].status === "active");
  check("team task", records[1].id === "task-3" && records[1].status === "in_progress");
  check("team task revision", records[1].rev === 2);
}

// --- 10. unknown and malformed events are ignored --------------------------
{
  const records = run([
    event("turn/start", { turn: 1 }),
    [SESSION, { type: "assistant/message" }],
    [{}, { type: "assistant/message", data: { usage: { inputTokens: 1 } } }],
    [SESSION, {}],
  ]);
  check("unknown events ignored", records.length === 1, `got ${records.length}`);
  check("missing session ignored", records[0].s === "session-1");
}

// --- 11. every record carries the schema version and a timestamp -----------
{
  const records = run([event("tool/call", { name: "read", callId: "c", arguments: {} })]);
  check("schema version present", records[0].v === SCHEMA_VERSION);
  check("timestamp injected", records[0].t === 1700000000000);
}

if (failures.length > 0) {
  console.error(`FAILED ${failures.length} check(s), passed ${passed}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${passed} checks passed`);
}
