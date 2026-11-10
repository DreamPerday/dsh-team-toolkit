/**
 * Apply the Agent Teams teammate-model-selection patch to the installed DSH Desktop.
 *
 * Two bundled packages are edited in place:
 *   - @deepseek-ai/dsh-experimental-agent-team      (durable member record + provisioning recovery)
 *   - @deepseek-ai/dsh-experimental-tool-agent-team (spawn_teammate schema + LLM route resolution)
 *
 * The script is idempotent: every anchor is asserted to be present exactly once, and the
 * run records the pre/post SHA-256 of both files under the app patch directory. Pristine
 * originals are kept in `<patchdir>/originals/`.
 *
 * Usage: DSH_APP_DIR=<...> node apply_patch.mjs [--check] [--app <dir>]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argApp = (() => {
	const index = process.argv.indexOf("--app");
	return index >= 0 ? process.argv[index + 1] : undefined;
})();
const APP = process.env.DSH_APP_DIR ?? argApp;
if (APP === undefined || APP.length === 0) {
	console.error("usage: DSH_APP_DIR=<DSH Desktop resources/app> node apply_patch.mjs   (or pass --app <dir>)");
	process.exit(2);
}
const TEAM = path.join(APP, "node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js");
const TOOL = path.join(APP, "node_modules/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js");
const PATCHDIR = process.env.DSH_PATCH_BACKUP_DIR ?? path.join(HERE, ".backups");
const MANIFEST = path.join(PATCHDIR, "manifest.json");
const CHECK_ONLY = process.argv.includes("--check");

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function fail(message) {
	throw new Error(message);
}

/** Reject a missing or duplicated anchor so a drift in the bundle fails loudly. */
function locate(text, needle) {
	const first = text.indexOf(needle);
	if (first < 0) fail(`anchor missing: ${JSON.stringify(needle.slice(0, 80))}`);
	if (text.indexOf(needle, first + 1) >= 0) fail(`anchor is not unique: ${JSON.stringify(needle.slice(0, 80))}`);
	return first;
}

function replaceOnce(text, needle, replacement) {
	const index = locate(text, needle);
	return text.slice(0, index) + replacement + text.slice(index + needle.length);
}

/** Leading whitespace of the line that contains `index`. */
function indentAt(text, index) {
	return text.slice(text.lastIndexOf("\n", index - 1) + 1, index);
}

/** Insert whole statement/property lines directly after the line containing `lineNeedle`. */
function insertLinesAfter(text, lineNeedle, lines) {
	const index = locate(text, lineNeedle);
	const lineEnd = text.indexOf("\n", index);
	if (lineEnd < 0) fail(`line has no terminator: ${JSON.stringify(lineNeedle.slice(0, 60))}`);
	const indent = indentAt(text, index);
	return text.slice(0, lineEnd + 1) + lines.map((line) => indent + line).join("\n") + "\n" + text.slice(lineEnd + 1);
}

const TEAM_HELPER = `/**
* Normalize one optional teammate LLM route override.
* @param value - caller-supplied provider, model, and optional reasoning effort.
* @returns a detached route, or undefined for the inherited Lead route.
*/
function teammateAgentOptions(value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TeamError("agentOptions must be an object", "TEAM_INVALID_ARGUMENT");
	const provider = requiredText(typeof value.provider === "string" ? value.provider : "", "agentOptions.provider", 200);
	const model = requiredText(typeof value.model === "string" ? value.model : "", "agentOptions.model", 200);
	const effort = value.reasoningEffort === void 0 ? void 0 : requiredText(typeof value.reasoningEffort === "string" ? value.reasoningEffort : "", "agentOptions.reasoningEffort", 64);
	return {
		provider,
		model,
		...effort === void 0 ? {} : { reasoningEffort: effort }
	};
}`;

const TOOL_HELPER = `/**
* Convert model-facing route fields into one child AgentOptions override. An
* empty request keeps the historical inherited Lead route, so an older caller
* observes exactly the previous behavior.
* @param ctx - Team tool plugin context that may expose the optional LLM service.
* @param args - model-facing spawn_teammate arguments.
* @returns the detached child route, or undefined when the caller named none.
*/
async function resolveTeammateAgentOptions(ctx, args) {
	const routeGiven = args.provider !== void 0 || args.model !== void 0 || args.reasoning_effort !== void 0;
	if (!routeGiven) return void 0;
	if (args.provider === void 0 || args.model === void 0) throw new Error("spawn_teammate requires provider and model together; omit both to inherit the Lead route");
	if (args.provider.length === 0 || args.model.length === 0) throw new Error("spawn_teammate provider and model must be non-empty");
	const llm = ctx.get("llm");
	if (llm === void 0) throw new Error("cannot resolve the teammate LLM route because the llm service is unavailable");
	const providers = llm.listProviders().map((entry) => entry.id);
	if (!providers.includes(args.provider)) throw new Error(\`unknown LLM provider "\${args.provider}"; registered providers: \${providers.join(", ") || "(none)"}\`);
	await llm.resolveCallConfig({
		provider: args.provider,
		model: args.model,
		...args.reasoning_effort === void 0 ? {} : { reasoningEffort: args.reasoning_effort }
	});
	return {
		provider: args.provider,
		model: args.model,
		...args.reasoning_effort === void 0 ? {} : { reasoningEffort: args.reasoning_effort }
	};
}`;

function patchTeam(source) {
	let text = source;
	// Normalize a spread that a previous script revision wrote without explicit parentheses.
	text = text.replace(/\.\.\.agentOptions === void 0 \? \{\} : \{ agentOptions \}(?!\))/g, "...(agentOptions === void 0 ? {} : { agentOptions })");
	if (!text.includes("teamMemberAgentOptionsSchema")) {
		text = text.replace(
			"const teamMemberSnapshotSchema = z$1.object({",
			[
				"const teamMemberAgentOptionsSchema = z$1.object({",
				"\tprovider: z$1.string().min(1),",
				"\tmodel: z$1.string().min(1),",
				"\treasoningEffort: z$1.string().min(1).optional()",
				"}).strict();",
				"const teamMemberSnapshotSchema = z$1.object({"
			].join("\n")
		);
		const memberStart = locate(text, "const teamMemberSnapshotSchema = z$1.object({");
		const errorIndex = text.indexOf("error: z$1.string().optional()", memberStart);
		if (errorIndex < 0) fail("member snapshot error field missing");
		const memberIndent = indentAt(text, errorIndex);
		text = text.slice(0, errorIndex) + memberIndent + "agentOptions: teamMemberAgentOptionsSchema.optional(),\n" + text.slice(errorIndex);
	}
	if (!text.includes("function teammateAgentOptions(value)")) {
		const requiredStart = locate(text, "function requiredText(value, field, maxLength) {");
		const requiredReturn = text.indexOf("return text;", requiredStart);
		const requiredClose = requiredReturn < 0 ? -1 : text.indexOf("\n}", requiredReturn);
		if (requiredReturn < 0 || requiredClose < 0) fail("requiredText body missing");
		const insertAt = requiredClose + 2;
		text = text.slice(0, insertAt) + "\n" + TEAM_HELPER + text.slice(insertAt);
	}
	if (!text.includes("const agentOptions = teammateAgentOptions(request.agentOptions);")) {
		text = insertLinesAfter(text, `const description = requiredText(request.description, "description", 200);`, ["const agentOptions = teammateAgentOptions(request.agentOptions);"]);
	}
	if (!text.includes("...(agentOptions === void 0 ? {} : { agentOptions }),\n\t\t\tcontext: request.context,")) {
		text = insertLinesAfter(text, `provider: requiredText(request.provider, "provider", 200),`, ["...(agentOptions === void 0 ? {} : { agentOptions }),"]);
	}
	if (!/parent: root,\n\s*\.\.\.\(agentOptions === void 0 \? \{\} : \{ agentOptions \}\)/u.test(text)) {
		const prompt = locate(text, "prompt: request.prompt,");
		const parentIndex = text.indexOf("parent: root", prompt);
		if (parentIndex < 0) fail("startActivation parent field missing");
		const parentLineEnd = text.indexOf("\n", parentIndex);
		if (text.slice(parentIndex, parentLineEnd) !== "parent: root") fail("startActivation parent layout drifted");
		const parentIndent = indentAt(text, parentIndex);
		text = text.slice(0, parentIndex) + "parent: root,\n" + parentIndent + "...(agentOptions === void 0 ? {} : { agentOptions })" + text.slice(parentLineEnd);
	}
	if (!text.includes("member.agentOptions === void 0 || (descriptor.agentProvider === member.agentOptions.provider")) {
		text = replaceOnce(
			text,
			"descriptor.provider === member.provider && acceptedInitialPrompt",
			"descriptor.provider === member.provider && (member.agentOptions === void 0 || (descriptor.agentProvider === member.agentOptions.provider && descriptor.agentModel === member.agentOptions.model)) && acceptedInitialPrompt"
		);
		text = replaceOnce(
			text,
			`else failure = "persisted child Session does not match the provisioned continuation";`,
			`else failure = member.agentOptions !== void 0 && descriptor !== void 0 && (descriptor.agentProvider !== member.agentOptions.provider || descriptor.agentModel !== member.agentOptions.model) ? \`persisted child Session LLM route does not match provisioned teammate "\${member.agentOptions.provider}/\${member.agentOptions.model}"\` : "persisted child Session does not match the provisioned continuation";`
		);
	}
	if (!text.includes("member.agentOptions === void 0 ? {} : { model: member.agentOptions.model }")) {
		text = replaceOnce(
			text,
			"...live?.options.model === void 0 ? {} : { model: live.options.model },",
			"...live?.options.model === void 0 ? member.agentOptions === void 0 ? {} : { model: member.agentOptions.model } : { model: live.options.model },"
		);
	}
	if (!text.includes("member.agentOptions?.model ?? root.options.model")) {
		text = replaceOnce(
			text,
			"const model = live?.options.model ?? root.options.model;",
			"const model = live?.options.model ?? member.agentOptions?.model ?? root.options.model;"
		);
	}
	const exportLine = "export { TeamError, TeamId, TeamMessageId, TeamService, TeamService as default, TeamTaskId };";
	if (!text.includes("TeamTaskId, teammateAgentOptions };")) {
		text = replaceOnce(text, exportLine, "export { TeamError, TeamId, TeamMessageId, TeamService, TeamService as default, TeamTaskId, teammateAgentOptions };");
	}
	return text;
}

function patchTool(source) {
	let text = source;
	if (!text.includes("async function resolveTeammateAgentOptions(ctx, args)")) {
		const waitLine = `const ACTIVE_WAIT_STATUSES = new Set(["running", "provisioning"]);`;
		const waitIndex = locate(text, waitLine);
		const lineEnd = text.indexOf("\n", waitIndex);
		text = text.slice(0, lineEnd + 1) + "\n" + TOOL_HELPER + "\n" + text.slice(lineEnd + 1);
	}
	if (!text.includes("Optional provider/model/reasoning_effort pin the teammate")) {
		text = replaceOnce(
			text,
			`description: "Create one named, durable teammate. Only the Team Lead may call this tool.",`,
			`description: "Create one named, durable teammate. Only the Team Lead may call this tool. Optional provider/model/reasoning_effort pin the teammate to a different LLM route; omit them to inherit the Lead route.",`
		);
	}
	if (!text.includes("Adapter-owned reasoning effort")) {
		const descAnchor = locate(text, `description: "fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh."`);
		const contextKey = text.lastIndexOf("context: {", descAnchor);
		if (contextKey < 0) fail("spawn_teammate context parameter missing");
		const contextIndent = indentAt(text, contextKey);
		const contextClose = text.indexOf("\n" + contextIndent + "}", descAnchor);
		if (contextClose < 0) fail("spawn_teammate context parameter close missing");
		const afterContextClose = contextClose + 1 + contextIndent.length + 1;
		if (text[afterContextClose] !== "\n") fail("spawn_teammate parameters layout drifted after context");
		text = text.slice(0, afterContextClose) + "," + text.slice(afterContextClose);
		const parametersClose = text.indexOf("\n" + contextIndent.slice(0, -1) + "},", afterContextClose + 1);
		if (parametersClose < 0) fail("spawn_teammate parameters close missing");
		const field = contextIndent + "\t";
		const params = [
			`${contextIndent}provider: {`,
			`${field}type: "string",`,
			`${field}description: "LLM provider id for the teammate. Supply together with model; omit both to inherit the Lead route."`,
			`${contextIndent}},`,
			`${contextIndent}model: {`,
			`${field}type: "string",`,
			`${field}description: "Model id interpreted by provider. Supply together with provider."`,
			`${contextIndent}},`,
			`${contextIndent}reasoning_effort: {`,
			`${field}type: "string",`,
			`${field}description: "Adapter-owned reasoning effort for the teammate route; omit to use the selected model's default."`,
			`${contextIndent}}`,
			""
		].join("\n");
		text = text.slice(0, parametersClose + 1) + params + text.slice(parametersClose + 1);
	}
	if (!text.includes("const agentOptions = await resolveTeammateAgentOptions(ctx, args);")) {
		text = insertLinesAfter(text, `const context = args.context ?? "fresh";`, ["const agentOptions = await resolveTeammateAgentOptions(ctx, args);"]);
	}
	if (!text.includes("...(agentOptions === void 0 ? {} : { agentOptions }),\n\t\t\t\t\tsignal: exec.signal")) {
		text = insertLinesAfter(text, `provider: context === "fork" ? config.forkProvider : config.freshProvider,`, ["...(agentOptions === void 0 ? {} : { agentOptions }),"]);
	}
	return text;
}

function main() {
	if (!existsSync(TEAM) || !existsSync(TOOL)) fail("expected installed DSH packages were not found");
	mkdirSync(path.join(PATCHDIR, "originals"), { recursive: true });
	const teamBackup = path.join(PATCHDIR, "originals/agent-team.index.js");
	const toolBackup = path.join(PATCHDIR, "originals/tool-agent-team.index.js");
	const teamText = readFileSync(TEAM, "utf8");
	const toolText = readFileSync(TOOL, "utf8");
	if (CHECK_ONLY) {
		const applied = teamText.includes("teammateAgentOptions") && toolText.includes("resolveTeammateAgentOptions");
		console.log(JSON.stringify({ applied, team: digest(TEAM), tool: digest(TOOL) }, null, 2));
		return applied ? 0 : 1;
	}
	if (!existsSync(teamBackup)) writeFileSync(teamBackup, teamText);
	if (!existsSync(toolBackup)) writeFileSync(toolBackup, toolText);
	if (readFileSync(teamBackup, "utf8").includes("teammateAgentOptions")) fail("team backup is already patched; restore from a pristine copy first");
	if (readFileSync(toolBackup, "utf8").includes("resolveTeammateAgentOptions")) fail("tool backup is already patched; restore from a pristine copy first");
	writeFileSync(TEAM, patchTeam(teamText));
	writeFileSync(TOOL, patchTool(toolText));
	const manifest = {
		id: "agent-team-model-selection-20261108",
		applied_at: new Date().toISOString(),
		files: [
			{
				package: "@deepseek-ai/dsh-experimental-agent-team",
				path: "node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js",
				original_sha256: digest(teamBackup),
				patched_sha256: digest(TEAM)
			},
			{
				package: "@deepseek-ai/dsh-experimental-tool-agent-team",
				path: "node_modules/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js",
				original_sha256: digest(toolBackup),
				patched_sha256: digest(TOOL)
			}
		],
		behavior: {
			spawn_teammate: "optional provider + model + reasoning_effort select the child LLM route",
			omitted: "no route fields keeps the previous inherited-Lead-route behavior",
			persistence: "member event carries agentOptions; provisioning recovery compares descriptor agentProvider/agentModel",
			validation: "provider and model must be supplied together; provider must be registered; the adapter resolves model and reasoning effort",
			roster_display: "list_agents keeps showing the requested model for inactive or failed teammates instead of falling back to the Lead route"
		},
		note: "Installed bundles are patched in place; restart DSH Desktop or boot a fresh CLI process to load the change."
	};
	writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
	console.log(JSON.stringify({ status: "patched", manifest: MANIFEST }, null, 2));
	return 0;
}

process.exit(main());
