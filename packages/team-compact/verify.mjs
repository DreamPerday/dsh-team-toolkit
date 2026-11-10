/**
 * Offline verification for dsh-team-compact.
 *
 * Loads the real `index.js` against a minimal fake Cordis context: no DSH
 * runtime, no network, no session log. It covers target resolution, the
 * idle/busy guard, the Lead-only session-id rule, prune/summarize dispatch,
 * the scoped tool registration, and the `/compact-agent` command.
 *
 * Usage: node verify.mjs
 */
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

/** One fake Agent with its own scope services and tool registry. */
function fakeAgent(id, { status = "idle" } = {}) {
  const services = new Map();
  const tools = [];
  const agent = {
    id,
    status,
    session: { id, requestHeader: () => ({ config: { provider: "p", model: "m" } }) },
    ctx: {
      get: (name) => services.get(name),
      tools: { register: (definition) => (tools.push(definition), () => {}) },
    },
    services,
    tools,
  };
  return agent;
}

/** Build the fake Host context plus the team roster it exposes. */
function fakeHost({ members, teams, window } = {}) {
  const agents = members ?? [];
  const commandList = [];
  const listeners = new Map();
  const disposers = [];
  const roster = teams ?? {
    tryMembership: (agent) => agent.membership,
    listMembers: () => agents.filter((agent) => agent.membership !== undefined).map((agent) => ({
      id: agent.id,
      name: agent.membership.name,
      role: agent.membership.role,
    })),
  };
  const services = new Map([
    ["agentTeams", roster],
    [
      "tokenMeter",
      {
        measure: (session) => ({ totalTokens: agents.find((agent) => agent.session.id === session.id)?.tokens ?? 0 }),
      },
    ],
    [
      "llm",
      {
        resolveModelInfo: async () => (window === undefined ? {} : { context: { contextWindow: window } }),
      },
    ],
  ]);
  const ctx = {
    agents: {
      list: () => agents,
      get: (id) => agents.find((agent) => agent.id === id),
    },
    get: (name) => services.get(name),
    on: (name, listener) => listeners.set(name, listener),
    effect: (callback) => disposers.push(callback()),
    commands: { register: (definition) => (commandList.push(definition), () => {}) },
    logger: { warn: () => {} },
    emit: (name, payload) => listeners.get(name)?.(payload),
    commandList,
    disposers,
  };
  return ctx;
}

/** One pruner service whose pass reports a fixed saving. */
function prunerService(agent, { items = 2, chars = 9000 } = {}) {
  return {
    pruneSession: () => {
      agent.tokens = Math.max(0, (agent.tokens ?? 0) - 1000);
      return { pruned: Array.from({ length: items }, (_value, index) => ({ originalSeq: index })), charsRemoved: chars };
    },
  };
}

/** One compaction service that records its calls. */
function compactionService(agent, { shadowed = 4200, fail } = {}) {
  return {
    calls: 0,
    async compactNow() {
      this.calls += 1;
      if (fail !== undefined) throw fail;
      agent.tokens = 800;
      return { shadowedTokenCount: shadowed, shadowedSeqs: [1, 2, 3] };
    },
  };
}

// --- 1. apply registers one tool per Team member and one command -----------
{
  const lead = fakeAgent("s-lead");
  lead.membership = { role: "lead", name: "lead" };
  const mate = fakeAgent("s-mate");
  mate.membership = { role: "teammate", name: "reviewer" };
  const outsider = fakeAgent("s-sub");
  const ctx = fakeHost({ members: [lead, mate, outsider] });
  apply(ctx);
  check("command registered", ctx.commandList.length === 1, `got ${ctx.commandList.length}`);
  check("lead got the tool", lead.tools.length === 1, `got ${lead.tools.length}`);
  check("teammate got the tool", mate.tools.length === 1, `got ${mate.tools.length}`);
  check("non-team agent got nothing", outsider.tools.length === 0, `got ${outsider.tools.length}`);
  check("tool name", lead.tools[0]?.name === "compact_context", lead.tools[0]?.name);
  ctx.disposers.reverse().forEach((dispose) => dispose?.());
}

// --- 2. a new teammate receives the tool on agent/created -----------------
{
  const lead = fakeAgent("s-lead");
  lead.membership = { role: "lead", name: "lead" };
  const ctx = fakeHost({ members: [lead] });
  apply(ctx);
  const late = fakeAgent("s-late");
  late.membership = { role: "teammate", name: "late" };
  ctx.agents.list = () => [lead, late];
  ctx.emit("agent/created", { agent: late });
  check("late teammate got the tool", late.tools.length === 1, `got ${late.tools.length}`);
  ctx.disposers.reverse().forEach((dispose) => dispose?.());
}

// --- 3. prune mode calls the pruner and reports the measurement ------------
{
  const lead = fakeAgent("s-lead");
  lead.membership = { role: "lead", name: "lead" };
  lead.tokens = 120000;
  lead.services.set("toolResultPruner", prunerService(lead));
  const ctx = fakeHost({ members: [lead] });
  apply(ctx);
  const tool = lead.tools[0];
  const value = await tool.execute({ mode: "prune" }, { agent: lead, signal: undefined });
  check("prune: before measured", value.before === 120000, String(value.before));
  check("prune: items reported", value.prunedItems === 2, String(value.prunedItems));
  check("prune: chars reported", value.prunedChars === 9000, String(value.prunedChars));
  check("prune: after re-measured", value.after === 119000, String(value.after));
  check("prune: no compaction", value.compactedTokens === undefined);
  ctx.disposers.reverse().forEach((dispose) => dispose?.());
}

// --- 4. compact mode calls compactNow and reports shadowed tokens ----------
{
  const lead = fakeAgent("s-lead");
  lead.membership = { role: "lead", name: "lead" };
  lead.tokens = 90000;
  const compaction = compactionService(lead);
  lead.services.set("compaction", compaction);
  const ctx = fakeHost({ members: [lead] });
  apply(ctx);
  const value = await lead.tools[0].execute({ mode: "compact" }, { agent: lead, signal: undefined });
  check("compact: called once", compaction.calls === 1, String(compaction.calls));
  check("compact: shadowed tokens", value.compactedTokens === 4200, String(value.compactedTokens));
  check("compact: after measured", value.after === 800, String(value.after));
  ctx.disposers.reverse().forEach((dispose) => dispose?.());
}

// --- 5. auto mode summarizes only when the estimate is near the window ----
{
  const lead = fakeAgent("s-lead");
  lead.membership = { role: "lead", name: "lead" };
  lead.tokens = 20000;
  lead.services.set("toolResultPruner", prunerService(lead, { items: 0, chars: 0 }));
  const compaction = compactionService(lead);
  lead.services.set("compaction", compaction);
  const ctx = fakeHost({ members: [lead], window: 200000 });
  apply(ctx);
  const value = await lead.tools[0].execute({ mode: "auto" }, { agent: lead, signal: undefined });
  check("auto: small context not summarized", compaction.calls === 0, String(compaction.calls));
  check("auto: window reported", value.window === 200000, String(value.window));
  ctx.disposers.reverse().forEach((dispose) => dispose?.());
}

// --- 6. a busy target is refused -----------------------------------------
{
  const lead = fakeAgent("s-lead");
  lead.membership = { role: "lead", name: "lead" };
  const mate = fakeAgent("s-mate", { status: "running" });
  mate.membership = { role: "teammate", name: "reviewer" };
  const ctx = fakeHost({ members: [lead, mate] });
  apply(ctx);
  let message = "";
  try {
    await lead.tools[0].execute({ target: "reviewer" }, { agent: lead, signal: undefined });
  } catch (error) {
    message = String(error?.message ?? error);
  }
  check("busy target refused", message.includes("running"), message);
  ctx.disposers.reverse().forEach((dispose) => dispose?.());
}

// --- 7. only the Lead may target an arbitrary session id ------------------
{
  const mate = fakeAgent("s-mate");
  mate.membership = { role: "teammate", name: "reviewer" };
  const ctx = fakeHost({ members: [mate] });
  apply(ctx);
  let message = "";
  try {
    await mate.tools[0].execute({ session: "s-other" }, { agent: mate, signal: undefined });
  } catch (error) {
    message = String(error?.message ?? error);
  }
  check("teammate cannot target a session id", message.includes("only the Team Lead"), message);
  ctx.disposers.reverse().forEach((dispose) => dispose?.());
}

// --- 8. the Lead can target a live session id ----------------------------
{
  const lead = fakeAgent("s-lead");
  lead.membership = { role: "lead", name: "lead" };
  const other = fakeAgent("s-other");
  other.tokens = 50000;
  other.services.set("toolResultPruner", prunerService(other));
  const ctx = fakeHost({ members: [lead, other] });
  apply(ctx);
  const value = await lead.tools[0].execute({ session: "s-other", mode: "prune" }, { agent: lead, signal: undefined });
  check("lead targets a session id", value.target === "s-other", value.target);
  check("session id: pruned", value.prunedItems === 2, String(value.prunedItems));
  ctx.disposers.reverse().forEach((dispose) => dispose?.());
}

// --- 9. a failed summary is reported, not thrown -------------------------
{
  const lead = fakeAgent("s-lead");
  lead.membership = { role: "lead", name: "lead" };
  lead.tokens = 300000;
  const error = Object.assign(new Error("manual compaction could not produce a smaller summary"), { code: "summary" });
  lead.services.set("compaction", compactionService(lead, { fail: error }));
  const ctx = fakeHost({ members: [lead] });
  apply(ctx);
  const value = await lead.tools[0].execute({ mode: "compact" }, { agent: lead, signal: undefined });
  check("summary failure reported", value.compactionError === "summary", String(value.compactionError));
  ctx.disposers.reverse().forEach((dispose) => dispose?.());
}

// --- 10. the human command wraps the same resolution ---------------------
{
  const lead = fakeAgent("s-lead");
  lead.membership = { role: "lead", name: "lead" };
  lead.tokens = 60000;
  lead.services.set("toolResultPruner", prunerService(lead));
  const ctx = fakeHost({ members: [lead] });
  apply(ctx);
  const command = ctx.commandList[0];
  const usage = await command.handler({ agent: lead, rawInput: "", signal: undefined });
  check("command usage on empty input", usage.kind === "error" && usage.text.includes("Usage"), usage.text);
  const ok = await command.handler({ agent: lead, rawInput: "self prune", signal: undefined });
  check("command success", ok.kind === "success", JSON.stringify(ok));
  check("command reports tokens", ok.text.includes("60000"), ok.text);
  const bad = await command.handler({ agent: lead, rawInput: "ghost", signal: undefined });
  check("command unknown member", bad.kind === "error", JSON.stringify(bad));
  ctx.disposers.reverse().forEach((dispose) => dispose?.());
}

if (failures.length > 0) {
  console.error(`FAILED ${failures.length} check(s), passed ${passed}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`OK: ${passed} checks passed`);
}
