/**
 * Targeted verification for the Agent Teams teammate-model-selection patch.
 *
 * Layers:
 *  1. Both patched bundles import cleanly (syntax + dependency resolution).
 *  2. The exported route normalizer enforces the provider/model contract.
 *  3. The real spawn_teammate tool definition exposes the new fields and forwards
 *     a validated route as child agentOptions, while omitting it preserves the old request.
 *  4. Durable/provisioning call sites are gated on the stored route (static anchors).
 *
 * Run with the bundled Node from the app directory context:
 *   node verify.mjs
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const argApp = (() => {
	const index = process.argv.indexOf("--app");
	return index >= 0 ? process.argv[index + 1] : undefined;
})();
const APP = process.env.DSH_APP_DIR ?? argApp;
if (APP === undefined || APP.length === 0) {
	console.error("usage: DSH_APP_DIR=<DSH Desktop resources/app> node verify.mjs   (or pass --app <dir>)");
	process.exit(2);
}
const TEAM_FILE = `${APP}\\node_modules\\@deepseek-ai\\dsh-experimental-agent-team\\lib\\index.js`;
const TOOL_FILE = `${APP}\\node_modules\\@deepseek-ai\\dsh-experimental-tool-agent-team\\lib\\index.js`;

const results = [];
function check(name, fn) {
	try {
		fn();
		results.push({ name, status: "pass" });
	} catch (error) {
		results.push({ name, status: "fail", error: error instanceof Error ? error.message : String(error) });
	}
}

const teamModule = await import(pathToFileURL(TEAM_FILE).href);
const toolModule = await import(pathToFileURL(TOOL_FILE).href);

check("team bundle imports", () => assert.equal(typeof teamModule.TeamService, "function"));
check("tool bundle imports", () => assert.equal(typeof toolModule.apply, "function"));
check("route normalizer is exported", () => assert.equal(typeof teamModule.teammateAgentOptions, "function"));

const normalize = teamModule.teammateAgentOptions;
check("omitted route keeps legacy behavior", () => assert.equal(normalize(undefined), undefined));
check("full route is detached and normalized", () => {
	assert.deepEqual(normalize({ provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "high" }), {
		provider: "openai",
		model: "gpt-6.1-sol",
		reasoningEffort: "high"
	});
});
check("blank provider is rejected", () => assert.throws(() => normalize({ provider: " ", model: "m" }), /agentOptions.provider must be non-empty/));
check("blank model is rejected", () => assert.throws(() => normalize({ provider: "openai", model: "" }), /agentOptions.model must be non-empty/));
check("non-object route is rejected", () => assert.throws(() => normalize("openai/gpt"), /agentOptions must be an object/));

// ---- Tool-layer behavior against a mocked Cordis scope ----------------------
const registered = new Map();
const calls = { resolveCallConfig: [], spawn: [] };
const fakeLlm = {
	listProviders: () => [{ id: "openai" }, { id: "cc-switch-open-code-go" }],
	resolveCallConfig: async (config) => {
		calls.resolveCallConfig.push(config);
		if (config.reasoningEffort === "impossible") throw new Error('model "gpt-6.1-sol" does not support reasoning effort "impossible"');
		return config;
	}
};
const fakeAgent = { id: "agent-root" };
const scoped = {
	systemPrompt: {
		section: () => () => {},
		context: () => () => {},
		getSectionOrder: () => 0,
		getContextOrder: () => 0
	},
	tools: {
		register: (definition) => {
			registered.set(definition.name, definition);
			return () => registered.delete(definition.name);
		}
	}
};
fakeAgent.ctx = scoped;
const pluginCtx = {
	agents: { list: () => [fakeAgent] },
	agentTeams: {
		tryMembership: () => ({ role: "lead", name: "lead" }),
		membership: () => ({ role: "lead", name: "lead", root: fakeAgent, id: "agent-root" }),
		spawnTeammate: async (_agent, request) => {
			calls.spawn.push(request);
			return {
				member: {
					id: "child-1",
					name: request.name,
					role: "teammate",
					status: "running",
					description: request.description,
					provider: request.provider,
					context: request.context,
					...(request.agentOptions === undefined ? {} : { model: request.agentOptions.model }),
					diagnostics: []
				}
			};
		}
	},
	get: (name) => (name === "llm" ? fakeLlm : undefined),
	on: () => () => {},
	effect: () => () => {},
	logger: { info: () => {}, error: () => {} }
};
toolModule.apply(pluginCtx, {});
const spawnTool = registered.get("spawn_teammate");
check("spawn_teammate registers", () => assert.ok(spawnTool));

const execute = async (args) => spawnTool.execute({ name: "probe", description: "route probe", prompt: "hello", ...args }, { agent: fakeAgent, signal: new AbortController().signal });

const parameters = spawnTool.parameters?.properties ?? {};
check("schema exposes provider", () => assert.ok(parameters.provider, "provider parameter missing"));
check("schema exposes model", () => assert.ok(parameters.model, "model parameter missing"));
check("schema exposes reasoning_effort", () => assert.ok(parameters.reasoning_effort, "reasoning_effort parameter missing"));
check("schema keeps the legacy required fields", () => assert.deepEqual(spawnTool.parameters.required, ["name", "description", "prompt"]));
check("route fields stay optional", () => assert.equal(parameters.provider.required, undefined));

const routed = await execute({ provider: "openai", model: "gpt-6.1-sol", reasoning_effort: "high" });
check("routed spawn forwards agentOptions", () => {
	const request = calls.spawn.at(-1);
	assert.deepEqual(request.agentOptions, { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "high" });
	assert.equal(routed.member.model, "gpt-6.1-sol");
});
check("routed spawn preflights the adapter route", () => {
	assert.deepEqual(calls.resolveCallConfig.at(-1), { provider: "openai", model: "gpt-6.1-sol", reasoningEffort: "high" });
});

await execute({});
check("legacy spawn omits agentOptions", () => {
	const request = calls.spawn.at(-1);
	assert.equal(Object.hasOwn(request, "agentOptions"), false, "legacy request must not gain agentOptions");
	assert.equal(request.provider, "spawn");
	assert.equal(request.context, "fresh");
});

await assert.rejects(execute({ provider: "openai" }), /requires provider and model together/);
await assert.rejects(execute({ provider: "unknown", model: "m" }), /unknown LLM provider "unknown"/);
await assert.rejects(execute({ provider: "openai", model: "gpt-6.1-sol", reasoning_effort: "impossible" }), /does not support reasoning effort/);
check("invalid routes fail before creating a child", () => assert.equal(calls.spawn.length, 2));

// ---- Static anchors for the durable record and recovery --------------------
const teamSource = readFileSync(TEAM_FILE, "utf8");
const toolSource = readFileSync(TOOL_FILE, "utf8");
check("member snapshot accepts an optional route", () => {
	assert.match(teamSource, /agentOptions: teamMemberAgentOptionsSchema\.optional\(\)/);
	assert.match(teamSource, /version: z\$1\.literal\(2\)/, "member event version must stay backward compatible");
});
check("spawn persists the route on the member", () => assert.match(teamSource, /member = \{\n[\s\S]*?\.\.\.\(agentOptions === void 0 \? \{\} : \{ agentOptions \}\),/));
check("startActivation receives the route", () => assert.match(teamSource, /parent: root,\n\s*\.\.\.\(agentOptions === void 0 \? \{\} : \{ agentOptions \}\)/));
check("recovery compares descriptor route", () => {
	assert.match(teamSource, /descriptor\.agentProvider === member\.agentOptions\.provider && descriptor\.agentModel === member\.agentOptions\.model/);
	assert.match(teamSource, /persisted child Session LLM route does not match provisioned teammate/);
});
check("failed/inactive view keeps the requested model", () => assert.match(teamSource, /member\.agentOptions === void 0 \? \{\} : \{ model: member\.agentOptions\.model \}/));
check("team roster falls back to the requested model, not the Lead route", () => assert.match(teamSource, /const model = live\?\.options\.model \?\? member\.agentOptions\?\.model \?\? root\.options\.model;/));
check("startActivation spread keeps explicit parentheses", () => assert.match(teamSource, /\.\.\.\(agentOptions === void 0 \? \{\} : \{ agentOptions \}\)/));
check("tool description documents the route override", () => assert.match(toolSource, /Optional provider\/model\/reasoning_effort pin the teammate/));

const summary = {
	status: results.every((entry) => entry.status === "pass") ? "pass" : "fail",
	checks: results.length,
	results
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.status === "pass" ? 0 : 1);
