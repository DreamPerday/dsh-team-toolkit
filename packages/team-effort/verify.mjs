/**
 * Offline verification for `dsh-team-effort`.
 *
 * The plugin bridges a live service, so the harness supplies a fake Cordis
 * Context, a fake `subagents` service with a prototype `startActivation`, and a
 * fake `llm` that answers model metadata. Every assertion is behavioral: what
 * the wrapped call actually receives, and what happens when the bridge is
 * disposed.
 *
 * Run: node verify.mjs
 */

import assert from "node:assert/strict";
import { apply, chooseEffort, resolveConfig, withEffort } from "./index.js";

const checks = [];
function check(label, condition, detail) {
  checks.push({ label, ok: Boolean(condition) });
  if (!condition) console.error(`FAIL: ${label}${detail === undefined ? "" : ` (${detail})`}`);
}

/** A fake subagents service: the method under test lives on the prototype. */
function fakeSubagents() {
  const calls = [];
  class FakeRuntime {
    async startActivation(spec) {
      calls.push(spec);
      return { childId: `child-${calls.length}`, name: `agent-${calls.length}`, result: Promise.resolve({}) };
    }
  }
  return { service: new FakeRuntime(), calls };
}

/** A fake LLM runtime answering one route's reasoning metadata. */
function fakeLlm(routes) {
  const asked = [];
  return {
    asked,
    async resolveModelInfo(provider, model) {
      asked.push(`${provider}/${model}`);
      const entry = routes[`${provider}/${model}`];
      if (entry === undefined) throw new Error(`unknown model ${provider}/${model}`);
      return entry;
    },
  };
}

/** A fake Cordis Context recording logger lines and running effects now. */
function fakeCtx({ subagents, llm } = {}) {
  const services = new Map();
  if (subagents !== undefined) services.set("subagents", subagents);
  if (llm !== undefined) services.set("llm", llm);
  const lines = [];
  const ctx = {
    subagents,
    get: (name) => services.get(name),
    logger: {
      info: (message) => lines.push(`info: ${message}`),
      warn: (message) => lines.push(`warn: ${message}`),
      error: (message) => lines.push(`error: ${message}`),
    },
    effect: (callback) => {
      const dispose = callback();
      return typeof dispose === "function" ? dispose : () => {};
    },
    lines,
  };
  return ctx;
}

/** ModelInfo as `llm.resolveModelInfo()` returns it: reasoning lives under `reasoning`. */
const REASONING = {
  reasoning: {
    efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }],
    defaultEffort: "medium",
  },
};

// --- configuration validation ---------------------------------------------
check("defaults resolve", resolveConfig({}).effort === "xhigh");
check("effort is trimmed", resolveConfig({ effort: "  xhigh  " }).effort === "xhigh");
check("unknown key rejected", (() => {
  try { resolveConfig({ nope: 1 }); return false; } catch { return true; }
})());
check("enabled requires an effort", (() => {
  try { resolveConfig({ enabled: true, effort: "   " }); return false; } catch { return true; }
})());
check("disabled still validates the default effort", resolveConfig({ enabled: false }).effort === "xhigh");
check("non-string effort rejected", (() => {
  try { resolveConfig({ effort: 3 }); return false; } catch { return true; }
})());

// --- effort selection ------------------------------------------------------
{
  const llm = fakeLlm({ "ztoken/gpt-6.2-sol": REASONING });
  const ctx = fakeCtx({ llm });
  const settings = resolveConfig({ effort: "xhigh" });
  const chosen = await chooseEffort(ctx, settings, "ztoken", "gpt-6.2-sol");
  check("configured effort is kept when advertised", chosen.effort === "xhigh", chosen.reason);
  check("model metadata was consulted", llm.asked.length === 1);
}
{
  const llm = fakeLlm({ "ztoken/gpt-6.2-sol": REASONING });
  const ctx = fakeCtx({ llm });
  const settings = resolveConfig({ effort: "none" });
  const chosen = await chooseEffort(ctx, settings, "ztoken", "gpt-6.2-sol");
  check("unadvertised effort falls back to the model default", chosen.effort === "medium", chosen.reason);
}
{
  const llm = fakeLlm({ "ztoken/gpt-6.2-sol": REASONING });
  const ctx = fakeCtx({ llm });
  const settings = resolveConfig({ effort: "none", fallbackToDefault: false });
  const chosen = await chooseEffort(ctx, settings, "ztoken", "gpt-6.2-sol");
  check("no fallback leaves the spec alone", chosen.effort === undefined, chosen.reason);
}
{
  const ctx = fakeCtx({ llm: fakeLlm({}) });
  const settings = resolveConfig({ effort: "xhigh" });
  const chosen = await chooseEffort(ctx, settings, "ztoken", "missing");
  check("unknown model is not stamped", chosen.effort === undefined, chosen.reason);
}
{
  const ctx = fakeCtx({});
  const settings = resolveConfig({ effort: "xhigh" });
  const chosen = await chooseEffort(ctx, settings, "ztoken", "gpt-6.2-sol");
  check("absent llm service is not stamped", chosen.effort === undefined, chosen.reason);
}
{
  const ctx = fakeCtx({});
  const settings = resolveConfig({ effort: "xhigh", trustWithoutValidation: true });
  const chosen = await chooseEffort(ctx, settings, "ztoken", "gpt-6.2-sol");
  check("trustWithoutValidation stamps anyway", chosen.effort === "xhigh", chosen.reason);
}
{
  const llm = fakeLlm({ "ztoken/no-reasoning": {} });
  const ctx = fakeCtx({ llm });
  const settings = resolveConfig({ effort: "xhigh" });
  const chosen = await chooseEffort(ctx, settings, "ztoken", "no-reasoning");
  check("model without reasoning metadata is untouched", chosen.effort === undefined, chosen.reason);
}

// --- spec rewriting --------------------------------------------------------
{
  const ctx = fakeCtx({ llm: fakeLlm({ "ztoken/gpt-6.2-sol": REASONING }) });
  const settings = resolveConfig({ effort: "xhigh" });
  const spec = { provider: "spawn", label: "x", delivery: "caller", signal: new AbortController().signal, agentOptions: { provider: "ztoken", model: "gpt-6.2-sol" } };
  const next = await withEffort(ctx, settings, spec);
  check("route switch gains the effort", next.agentOptions.reasoningEffort === "xhigh", JSON.stringify(next.agentOptions));
  check("the original spec object is not mutated", spec.agentOptions.reasoningEffort === undefined);
  check("other spec fields survive", next.provider === "spawn" && next.delivery === "caller");
}
{
  const ctx = fakeCtx({ llm: fakeLlm({}) });
  const settings = resolveConfig({ effort: "xhigh" });
  const spec = { provider: "spawn", agentOptions: { provider: "ztoken", model: "gpt-6.2-sol", reasoningEffort: "low" } };
  const next = await withEffort(ctx, settings, spec);
  check("an explicit caller effort is never overridden", next === spec);
}
{
  const ctx = fakeCtx({ llm: fakeLlm({}) });
  const settings = resolveConfig({ effort: "xhigh" });
  const inherited = { provider: "spawn", agentOptions: undefined };
  check("no agentOptions is left alone", (await withEffort(ctx, settings, inherited)) === inherited);
  const noRoute = { provider: "spawn", agentOptions: { model: "gpt-6.2-sol" } };
  check("a model without a provider is left alone", (await withEffort(ctx, settings, noRoute)) === noRoute);
}

// --- the bridge itself -----------------------------------------------------
{
  const { service, calls } = fakeSubagents();
  const llm = fakeLlm({ "ztoken/gpt-6.2-sol": REASONING });
  const ctx = fakeCtx({ subagents: service, llm });
  const dispose = apply(ctx, { effort: "xhigh" });
  const result = await service.startActivation({ provider: "spawn", label: "wf child 1", delivery: "caller", signal: new AbortController().signal, agentOptions: { provider: "ztoken", model: "gpt-6.2-sol" } });
  check("the wrapped call still returns the activation", result.childId === "child-1");
  check("the provider received the stamped effort", calls[0]?.agentOptions?.reasoningEffort === "xhigh", JSON.stringify(calls[0]?.agentOptions));
  check("a diagnostic line was logged once", ctx.lines.filter((line) => line.includes("stamped")).length === 1, ctx.lines.join(" | "));
  await service.startActivation({ provider: "spawn", label: "wf child 2", delivery: "caller", signal: new AbortController().signal, agentOptions: { provider: "ztoken", model: "gpt-6.2-sol" } });
  check("the same route logs only once", ctx.lines.filter((line) => line.includes("stamped")).length === 1, ctx.lines.join(" | "));
  check("both calls were stamped", calls[1]?.agentOptions?.reasoningEffort === "xhigh");
}

{
  const { service, calls } = fakeSubagents();
  const ctx = fakeCtx({ subagents: service, llm: fakeLlm({}) });
  const dispose = apply(ctx, { enabled: false, effort: "xhigh" });
  await service.startActivation({ provider: "spawn", agentOptions: { provider: "ztoken", model: "gpt-6.2-sol" } });
  check("disabled config leaves the call untouched", calls[0]?.agentOptions?.reasoningEffort === undefined);
  check("disabled config registers no restore callback", dispose === undefined);
}

{
  const prototypeMethod = Object.getOwnPropertyNames(Object.getPrototypeOf(fakeSubagents().service));
  check("startActivation is a prototype method in the fixture", prototypeMethod.includes("startActivation"));
  const { service } = fakeSubagents();
  const ctx = fakeCtx({ subagents: service, llm: fakeLlm({ "ztoken/gpt-6.2-sol": REASONING }) });
  const dispose = apply(ctx, { effort: "xhigh" });
  check("the bridge owns an own property", Object.hasOwn(service, "startActivation"));
  dispose();
  check("disposal removes the own property", !Object.hasOwn(service, "startActivation"));
  check("the prototype method is restored", typeof service.startActivation === "function");
  const before = await service.startActivation({ provider: "spawn", agentOptions: { provider: "ztoken", model: "gpt-6.2-sol" } });
  check("the restored method runs without the bridge", before.childId === "child-1");
}

{
  const { service } = fakeSubagents();
  const ctx = fakeCtx({ subagents: service, llm: fakeLlm({}) });
  apply(ctx, { effort: "xhigh" });
  const second = apply(ctx, { effort: "high" });
  check("a second bridge is refused instead of stacked", second === undefined);
  check("the refusal is logged", ctx.lines.some((line) => line.includes("already bridged")), ctx.lines.join(" | "));
}

{
  const ctx = fakeCtx({ subagents: undefined, llm: fakeLlm({}) });
  let threw = false;
  try { apply(ctx, { effort: "xhigh" }); } catch { threw = true; }
  check("a composition without subagents fails loud", threw);
}

// --- the plugin never invents model input ---------------------------------
{
  const { service } = fakeSubagents();
  const ctx = fakeCtx({ subagents: service, llm: fakeLlm({ "ztoken/gpt-6.2-sol": REASONING }) });
  apply(ctx, { effort: "xhigh" });
  await service.startActivation({ provider: "spawn", label: "plain", delivery: "caller", signal: new AbortController().signal });
  check("a delegation without a route is untouched", Object.keys(service === undefined ? {} : {}).length === 0);
}

const failed = checks.filter((entry) => !entry.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} of ${checks.length} checks failed`);
  process.exit(1);
}
console.log(`OK: ${checks.length} checks passed`);
void assert;
