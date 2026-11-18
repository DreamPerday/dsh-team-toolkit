/**
 * In-place patch: remove a teammate from the Team roster and purge its session.
 *
 * v2 adds: the removed member disappears from the agentTeam projection (so the
 * Web member panel drops it), and the teammate's saved session directory is
 * deleted from disk (best effort, `sessionDeleted` in the result).
 *
 * Usage:
 *   DSH_APP_DIR=<...> node apply_patch.mjs --check
 *   DSH_APP_DIR=<...> node apply_patch.mjs
 *
 * Idempotent and upgradeable: it applies every missing v1/v2 step and never
 * rewrites a step that is already present. Fails loudly before writing on an
 * ambiguous anchor.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

function fail(message) {
	throw new Error(`team-member-remove: ${message}`);
}

function digest(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first < 0) fail(`anchor not found: ${label}`);
	if (text.indexOf(find, first + find.length) >= 0) fail(`anchor is ambiguous: ${label}`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

function replaceAll(text, find, replacement, label, expected) {
	const count = text.split(find).length - 1;
	if (count !== expected) fail(`anchor count ${count} != ${expected}: ${label}`);
	return text.split(find).join(replacement);
}

const L = (...lines) => lines.join("\n");

const ENUM_OLD = L(
	"\tphase: z$1.enum([",
	"\t\t\"provisioning\",",
	"\t\t\"active\",",
	"\t\t\"failed\"",
	"\t]),"
);
const ENUM_NEW = L(
	"\tphase: z$1.enum([",
	"\t\t\"provisioning\",",
	"\t\t\"active\",",
	"\t\t\"failed\",",
	"\t\t\"removed\"",
	"\t]),"
);

const TRANSITION_OLD = L(
	"\t\t\tconst named = state.members.find((candidate) => candidate.name === member.name);",
	"\t\t\tif (named !== void 0 && named.id !== member.id) throw new Error(`teammate name \"${member.name}\" is reused by another member`);",
	"\t\t\tif (prior === void 0) {",
	"\t\t\t\tif (member.phase !== \"provisioning\") throw new Error(`teammate \"${member.name}\" must begin provisioning`);",
	"\t\t\t} else {",
	"\t\t\t\tif (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) throw new Error(`teammate \"${member.id}\" changed immutable identity fields`);",
	"\t\t\t\tif (prior.phase !== \"provisioning\" || member.phase === \"provisioning\") throw new Error(`teammate \"${member.name}\" has an invalid ${prior.phase} -> ${member.phase} transition`);",
	"\t\t\t}"
);
const TRANSITION_NEW = L(
	"\t\t\tconst named = state.members.find((candidate) => candidate.name === member.name && candidate.phase !== \"removed\");",
	"\t\t\tif (named !== void 0 && named.id !== member.id) throw new Error(`teammate name \"${member.name}\" is reused by another member`);",
	"\t\t\tif (prior === void 0) {",
	"\t\t\t\tif (member.phase !== \"provisioning\") throw new Error(`teammate \"${member.name}\" must begin provisioning`);",
	"\t\t\t} else {",
	"\t\t\t\tif (prior.name !== member.name || prior.provider !== member.provider || prior.context !== member.context) throw new Error(`teammate \"${member.id}\" changed immutable identity fields`);",
	"\t\t\t\tconst allowed = prior.phase === \"provisioning\" ? [\"active\", \"failed\", \"removed\"] : prior.phase === \"removed\" ? [] : [\"removed\"];",
	"\t\t\t\tif (!allowed.includes(member.phase)) throw new Error(`teammate \"${member.name}\" has an invalid ${prior.phase} -> ${member.phase} transition`);",
	"\t\t\t}"
);

const LIST_OLD = L(
	"\t\tfor (const member of state.members) {",
	"\t\t\tconst live = this.ctx.agents.get(member.id);",
	"\t\t\tconst model = live?.options.model ?? member.agentOptions?.model ?? root.options.model;"
);
const LIST_NEW = L(
	"\t\tfor (const member of state.members) {",
	"\t\t\tif (member.phase === \"removed\") continue;",
	"\t\t\tconst live = this.ctx.agents.get(member.id);",
	"\t\t\tconst model = live?.options.model ?? member.agentOptions?.model ?? root.options.model;"
);

const SPAWN_NAME_OLD = L(
	"\t\t\tif (state.members.some((member) => member.name === name)) throw new TeamError(`teammate name \"${name}\" was already used in this Team`, \"TEAM_MEMBER_NAME_TAKEN\");",
	"\t\t\tif (state.members.length >= this.maxMembers) throw new TeamError(`Team member limit ${this.maxMembers} reached`, \"TEAM_MEMBER_LIMIT\");"
);
const SPAWN_NAME_NEW = L(
	"\t\t\tif (state.members.some((member) => member.name === name && member.phase !== \"removed\")) throw new TeamError(`teammate name \"${name}\" was already used in this Team`, \"TEAM_MEMBER_NAME_TAKEN\");",
	"\t\t\tif (state.members.filter((member) => member.phase !== \"removed\").length >= this.maxMembers) throw new TeamError(`Team member limit ${this.maxMembers} reached`, \"TEAM_MEMBER_LIMIT\");"
);

const LIVE_CHILDREN_OLD =
	"\t\t\tif (root === void 0 || !this.journal.state(root).members.some((member) => member.id === agent.id)) continue;";
const LIVE_CHILDREN_NEW =
	"\t\t\tif (root === void 0 || !this.journal.state(root).members.some((member) => member.id === agent.id && member.phase !== \"removed\")) continue;";

const SETTLE_OLD = "\t\tif (await this.settleProvisioning(root, active) === \"failed\") {";
const SETTLE_NEW = L(
	"\t\tconst settledPhase = await this.settleProvisioning(root, active);",
	"\t\tif (settledPhase === \"removed\") throw new TeamError(`teammate \"${name}\" was removed while creation was in progress`, \"TEAM_PROVISIONING_CONFLICT\");",
	"\t\tif (settledPhase === \"failed\") {"
);

const PROJECTION_OLD = L(
	"\tfor (const member of state.members) members.push({",
	"\t\tid: member.id,",
	"\t\tname: member.name,",
	"\t\trole: \"teammate\",",
	"\t\tphase: member.phase,",
	"\t\t...member.error === void 0 ? {} : { error: member.error }",
	"\t});"
);
const PROJECTION_NEW = L(
	"\tfor (const member of state.members) {",
	"\t\tif (member.phase === \"removed\") continue;",
	"\t\tmembers.push({",
	"\t\t\tid: member.id,",
	"\t\t\tname: member.name,",
	"\t\t\trole: \"teammate\",",
	"\t\t\tphase: member.phase,",
	"\t\t\t...member.error === void 0 ? {} : { error: member.error }",
	"\t\t});",
	"\t}"
);

const PURGE_HELPER = L(
	"/** Delete the removed teammate's saved session directory, best effort. */",
	"async function purgeMemberSession(id) {",
	"	const fs = await import(\"node:fs/promises\");",
	"	const os = await import(\"node:os\");",
	"	const p = await import(\"node:path\");",
	"	const root = process.env.DSH_SESSIONS_DIR ?? p.join(os.homedir(), \".dsh\", \"sessions\");",
	"	const target = `session-${id}`;",
	"	let entries;",
	"	try {",
	"		entries = await fs.readdir(root, { withFileTypes: true });",
	"	} catch {",
	"		return false;",
	"	}",
	"	for (const entry of entries) {",
	"		if (!entry.isDirectory()) continue;",
	"		const candidate = p.join(root, entry.name, target);",
	"		try {",
	"			const stat = await fs.stat(candidate);",
	"			if (!stat.isDirectory()) continue;",
	"		} catch {",
	"			continue;",
	"		}",
	"		try {",
	"			await fs.rm(candidate, { recursive: true, force: true });",
	"			return true;",
	"		} catch {",
	"			return false;",
	"		}",
	"	}",
	"	return false;",
	"}"
);
const PURGE_ANCHOR = "/** Turn availability is independent of whether the Agent is loaded. */";

const ROSTER_INTERRUPT_OLD = L(
	"\t* @returns the target status sampled before cancellation.",
	"\t*/",
	"\tinterrupt(caller, targetName) {",
	"\t\tconst membership = this.membership(caller);",
	"\t\tif (membership.role !== \"lead\") throw new TeamError(\"only the Team Lead can interrupt teammates\", \"TEAM_LEAD_REQUIRED\");",
	"\t\tconst state = this.journal.state(membership.root);",
	"\t\tconst target = resolveActiveMember(membership.root, state, targetName);",
	"\t\tif (target.id === membership.root.id) throw new TeamError(\"the Team Lead cannot interrupt itself\", \"TEAM_INVALID_TARGET\");",
	"\t\tconst live = this.ctx.agents.get(target.id);",
	"\t\tif (live === void 0) return { previousStatus: \"inactive\" };",
	"\t\tconst previousStatus = availability(live);",
	"\t\tthis.ctx.subagents.interrupt(target.id, {",
	"\t\t\tkind: \"ancestor\",",
	"\t\t\tagent: caller",
	"\t\t});",
	"\t\treturn { previousStatus };",
	"\t}"
);
const ROSTER_TAIL_V1 = L(
	"\t\ttry {",
	"\t\t\tawait this.stopTeammates(root, [target.id]);",
	"\t\t} catch {}",
	"\t\treturn { previousStatus };",
	"\t}"
);
const ROSTER_TAIL_V2 = L(
	"\t\ttry {",
	"\t\t\tawait this.stopTeammates(root, [target.id]);",
	"\t\t} catch {}",
	"\t\tconst sessionDeleted = await purgeMemberSession(target.id);",
	"\t\treturn { previousStatus, sessionDeleted };",
	"\t}"
);
const ROSTER_REMOVE_METHOD = L(
	"\t/**",
	"\t* Remove one teammate from the Team roster and delete its saved session.",
	"\t* @param caller - exact live Lead Agent.",
	"\t* @param targetName - durable teammate name.",
	"\t* @returns the target status sampled before removal and whether its session was deleted.",
	"\t*/",
	"\tasync removeTeammate(caller, targetName) {",
	"\t\tconst membership = this.membership(caller);",
	"\t\tif (membership.role !== \"lead\") throw new TeamError(\"only the Team Lead can remove teammates\", \"TEAM_LEAD_REQUIRED\");",
	"\t\tconst name = this.memberName(targetName);",
	"\t\tconst root = membership.root;",
	"\t\tconst target = this.journal.state(root).members.find((candidate) => candidate.name === name);",
	"\t\tif (target === void 0) throw new TeamError(`teammate \"${name}\" was not found in this Team`, \"TEAM_MEMBER_NOT_FOUND\");",
	"\t\tif (target.phase === \"removed\") return { previousStatus: \"inactive\", sessionDeleted: false };",
	"\t\tconst live = this.ctx.agents.get(target.id);",
	"\t\tconst previousStatus = target.phase === \"provisioning\" ? \"provisioning\" : target.phase === \"failed\" ? \"failed\" : live === void 0 ? \"inactive\" : availability(live);",
	"\t\tif (live !== void 0) this.ctx.subagents.interrupt(target.id, {",
	"\t\t\tkind: \"ancestor\",",
	"\t\t\tagent: caller",
	"\t\t});",
	"\t\tawait this.journal.transact(root.id, async () => {",
	"\t\t\tconst current = this.journal.state(root).members.find((candidate) => candidate.id === target.id);",
	"\t\t\tif (current === void 0 || current.phase === \"removed\") return;",
	"\t\t\tawait this.journal.appendAndFlush(root, \"team/member\", {",
	"\t\t\t\tversion: 2,",
	"\t\t\t\tteamId: TeamId(root.id),",
	"\t\t\t\tmember: { ...current, phase: \"removed\" }",
	"\t\t\t});",
	"\t\t});",
	"\t\ttry {",
	"\t\t\tawait this.stopTeammates(root, [target.id]);",
	"\t\t} catch {}",
	"\t\tconst sessionDeleted = await purgeMemberSession(target.id);",
	"\t\treturn { previousStatus, sessionDeleted };",
	"\t}"
);

const SERVICE_INTERRUPT_OLD = L(
	"\tinterrupt(caller, targetName) {",
	"\t\treturn this.roster.interrupt(caller, targetName);",
	"\t}"
);
const SERVICE_REMOVE_METHOD = L(
	"\t/**",
	"\t* Remove one teammate from the Team roster and delete its saved session.",
	"\t* @param caller - exact live Lead Agent.",
	"\t* @param targetName - durable teammate name.",
	"\t* @returns the target status sampled before removal and whether its session was deleted.",
	"\t*/",
	"\tasync removeTeammate(caller, targetName) {",
	"\t\tif (this.lifecycle.disposed) throw new TeamError(\"Agent Teams service is disposing\", \"TEAM_DISPOSED\");",
	"\t\tconst membership = this.roster.membership(caller);",
	"\t\tconst result = await this.lifecycle.track(this.roster.removeTeammate(caller, targetName));",
	"\t\tthis.activity.notify(membership.id);",
	"\t\treturn result;",
	"\t}"
);

const POLICY_OLD =
	'Use the target returned by spawn_teammate or list_agents for send_message${interrupt ? " and interrupt_agent" : ""}, or as owner when assigning or filtering shared tasks.';
const POLICY_NEW =
	'Use the target returned by spawn_teammate or list_agents for send_message, remove_teammate${interrupt ? ", and interrupt_agent" : ""}, or as owner when assigning or filtering shared tasks.';

const INTERRUPT_SCHEMA_OLD = L(
	"const INTERRUPT_VALUE_SCHEMA = {",
	"\ttype: \"object\",",
	"\tadditionalProperties: false,",
	"\tproperties: { previousStatus: {",
	"\t\ttype: \"string\",",
	"\t\trequired: true,",
	"\t\tenum: [\"running\", \"inactive\"]",
	"\t} }",
	"};"
);
const REMOVE_SCHEMA_V2 = L(
	"const REMOVE_VALUE_SCHEMA = {",
	"\ttype: \"object\",",
	"\tadditionalProperties: false,",
	"\tproperties: {",
	"\t\tremoved: {",
	"\t\t\ttype: \"boolean\",",
	"\t\t\trequired: true,",
	"\t\t\tconst: true",
	"\t\t},",
	"\t\ttarget: {",
	"\t\t\ttype: \"string\",",
	"\t\t\trequired: true",
	"\t\t},",
	"\t\tpreviousStatus: {",
	"\t\t\ttype: \"string\",",
	"\t\t\trequired: true,",
	"\t\t\tenum: [\"running\", \"inactive\", \"provisioning\", \"failed\"]",
	"\t\t},",
	"\t\tsessionDeleted: {",
	"\t\t\ttype: \"boolean\",",
	"\t\t\trequired: true",
	"\t\t}",
	"\t}",
	"};"
);
const REMOVE_SCHEMA_V1 = L(
	"const REMOVE_VALUE_SCHEMA = {",
	"\ttype: \"object\",",
	"\tadditionalProperties: false,",
	"\tproperties: {",
	"\t\tremoved: {",
	"\t\t\ttype: \"boolean\",",
	"\t\t\trequired: true,",
	"\t\t\tconst: true",
	"\t\t},",
	"\t\ttarget: {",
	"\t\t\ttype: \"string\",",
	"\t\t\trequired: true",
	"\t\t},",
	"\t\tpreviousStatus: {",
	"\t\t\ttype: \"string\",",
	"\t\t\trequired: true,",
	"\t\t\tenum: [\"running\", \"inactive\", \"provisioning\", \"failed\"]",
	"\t\t}",
	"\t}",
	"};"
);

const INTERRUPT_TOOL_OLD = L(
	"\t\tif (config.interrupt) register(scoped.tools.register(defineTool({",
	"\t\t\tname: \"interrupt_agent\",",
	"\t\t\tdescription: \"Interrupt one teammate's current turn while preserving its pending inbox. Team Lead only.\",",
	"\t\t\tparameters: { target: {",
	"\t\t\t\ttype: \"string\",",
	"\t\t\t\trequired: true,",
	"\t\t\t\tdescription: \"Teammate target returned by spawn_teammate or list_agents.\"",
	"\t\t\t} },",
	"\t\t\toutput: jsonOutput(INTERRUPT_VALUE_SCHEMA),",
	"\t\t\texecute(args, exec) {",
	"\t\t\t\treturn Promise.resolve(ctx.agentTeams.interrupt(callingAgent(exec.agent, \"interrupt_agent\"), args.target));",
	"\t\t\t}",
	"\t\t})));"
);
const REMOVE_TOOL_V1 = L(
	"\t\tregister(scoped.tools.register(defineTool({",
	"\t\t\tname: \"remove_teammate\",",
	"\t\t\tdescription: \"Remove one teammate from the Team roster. Team Lead only. Its current turn is interrupted and its activation released; list_agents no longer shows it, its name becomes available to spawn again, and its saved conversation stays on disk.\",",
	"\t\t\tparameters: { target: {",
	"\t\t\t\ttype: \"string\",",
	"\t\t\t\trequired: true,",
	"\t\t\t\tdescription: \"Teammate target returned by spawn_teammate or list_agents.\"",
	"\t\t\t} },",
	"\t\t\toutput: jsonOutput(REMOVE_VALUE_SCHEMA),",
	"\t\t\tasync execute(args, exec) {",
	"\t\t\t\tconst result = await ctx.agentTeams.removeTeammate(callingAgent(exec.agent, \"remove_teammate\"), args.target);",
	"\t\t\t\treturn {",
	"\t\t\t\t\tremoved: true,",
	"\t\t\t\t\ttarget: args.target,",
	"\t\t\t\t\tpreviousStatus: result.previousStatus",
	"\t\t\t\t};",
	"\t\t\t}",
	"\t\t})));"
);
const REMOVE_TOOL_V2 = L(
	"\t\tregister(scoped.tools.register(defineTool({",
	"\t\t\tname: \"remove_teammate\",",
	"\t\t\tdescription: \"Remove one teammate from the Team roster and delete its saved conversation. Team Lead only. Its current turn is interrupted and its activation released; list_agents and the member panel no longer show it, its name and member slot are freed, and its session directory is deleted from disk.\",",
	"\t\t\tparameters: { target: {",
	"\t\t\t\ttype: \"string\",",
	"\t\t\t\trequired: true,",
	"\t\t\t\tdescription: \"Teammate target returned by spawn_teammate or list_agents.\"",
	"\t\t\t} },",
	"\t\t\toutput: jsonOutput(REMOVE_VALUE_SCHEMA),",
	"\t\t\tasync execute(args, exec) {",
	"\t\t\t\tconst result = await ctx.agentTeams.removeTeammate(callingAgent(exec.agent, \"remove_teammate\"), args.target);",
	"\t\t\t\treturn {",
	"\t\t\t\t\tremoved: true,",
	"\t\t\t\t\ttarget: args.target,",
	"\t\t\t\t\tpreviousStatus: result.previousStatus,",
	"\t\t\t\t\tsessionDeleted: result.sessionDeleted === true",
	"\t\t\t\t};",
	"\t\t\t}",
	"\t\t})));"
);

function patchTeam(source) {
	let text = source;
	if (!text.includes("\"failed\",\n\t\t\"removed\"")) text = replaceAll(text, ENUM_OLD, ENUM_NEW, "member phase enum", 2);
	if (!text.includes("const allowed = prior.phase === \"provisioning\"")) text = replaceOnce(text, TRANSITION_OLD, TRANSITION_NEW, "member transition rule");
	if (!text.includes("if (member.phase === \"removed\") continue;\n\t\t\tconst live")) text = replaceOnce(text, LIST_OLD, LIST_NEW, "roster list filter");
	if (!text.includes("member.name === name && member.phase !== \"removed\"")) text = replaceOnce(text, SPAWN_NAME_OLD, SPAWN_NAME_NEW, "spawn name and member-limit accounting");
	if (!text.includes("member.id === agent.id && member.phase !== \"removed\"")) text = replaceOnce(text, LIVE_CHILDREN_OLD, LIVE_CHILDREN_NEW, "live children projection");
	if (!text.includes("settledPhase === \"removed\"")) text = replaceOnce(text, SETTLE_OLD, SETTLE_NEW, "spawn settle guard");
	if (!text.includes("if (member.phase === \"removed\") continue;\n\t\tmembers.push({")) text = replaceOnce(text, PROJECTION_OLD, PROJECTION_NEW, "panel projection filter");
	if (!text.includes("async function purgeMemberSession(id)")) text = replaceOnce(text, PURGE_ANCHOR, PURGE_HELPER + "\n" + PURGE_ANCHOR, "session purge helper");
	if (text.includes(ROSTER_TAIL_V1)) text = replaceOnce(text, ROSTER_TAIL_V1, ROSTER_TAIL_V2, "roster removal tail upgrade");
	if (!text.includes("async removeTeammate(caller, targetName) {")) text = replaceOnce(text, ROSTER_INTERRUPT_OLD, ROSTER_INTERRUPT_OLD + "\n" + ROSTER_REMOVE_METHOD, "roster removeTeammate");
	if (!text.includes("this.roster.removeTeammate")) text = replaceOnce(text, SERVICE_INTERRUPT_OLD, SERVICE_INTERRUPT_OLD + "\n" + SERVICE_REMOVE_METHOD, "service removeTeammate");
	return text;
}

function patchTool(source) {
	let text = source;
	if (!text.includes("for send_message, remove_teammate")) text = replaceOnce(text, POLICY_OLD, POLICY_NEW, "team policy sentence");
	if (!text.includes("const REMOVE_VALUE_SCHEMA = {")) text = replaceOnce(text, INTERRUPT_SCHEMA_OLD, INTERRUPT_SCHEMA_OLD + "\n" + REMOVE_SCHEMA_V2, "remove value schema");
	else if (!text.includes("sessionDeleted: {") && text.includes(REMOVE_SCHEMA_V1)) text = replaceOnce(text, REMOVE_SCHEMA_V1, REMOVE_SCHEMA_V2, "remove value schema upgrade");
	if (!text.includes("name: \"remove_teammate\"")) text = replaceOnce(text, INTERRUPT_TOOL_OLD, INTERRUPT_TOOL_OLD + "\n" + REMOVE_TOOL_V2, "remove_teammate tool");
	else if (text.includes(REMOVE_TOOL_V1)) text = replaceOnce(text, REMOVE_TOOL_V1, REMOVE_TOOL_V2, "remove_teammate tool upgrade");
	return text;
}

function main() {
	if (!existsSync(TEAM) || !existsSync(TOOL)) fail("expected installed DSH packages were not found");
	const teamText = readFileSync(TEAM, "utf8");
	const toolText = readFileSync(TOOL, "utf8");
	const nextTeam = patchTeam(teamText);
	const nextTool = patchTool(toolText);
	const changed = nextTeam !== teamText || nextTool !== toolText;
	if (CHECK_ONLY) {
		console.log(JSON.stringify({ applied: !changed, team: digest(TEAM), tool: digest(TOOL) }, null, 2));
		return changed ? 1 : 0;
	}
	mkdirSync(path.join(PATCHDIR, "originals"), { recursive: true });
	const teamBackup = path.join(PATCHDIR, "originals/agent-team.index.js");
	const toolBackup = path.join(PATCHDIR, "originals/tool-agent-team.index.js");
	if (!existsSync(teamBackup)) writeFileSync(teamBackup, teamText);
	if (!existsSync(toolBackup)) writeFileSync(toolBackup, toolText);
	if (nextTeam !== teamText) writeFileSync(TEAM, nextTeam);
	if (nextTool !== toolText) writeFileSync(TOOL, nextTool);
	writeFileSync(MANIFEST, JSON.stringify({
		id: "team-member-remove-20261118",
		version: 2,
		applied_at: new Date().toISOString(),
		files: [
			{ package: "@deepseek-ai/dsh-experimental-agent-team", path: "node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js", original_sha256: digest(teamBackup), patched_sha256: digest(TEAM) },
			{ package: "@deepseek-ai/dsh-experimental-tool-agent-team", path: "node_modules/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js", original_sha256: digest(toolBackup), patched_sha256: digest(TOOL) }
		],
		behavior: {
			phase: "members gain a terminal `removed` phase; provisioning -> active|failed|removed, active|failed -> removed",
			roster: "removed members are hidden from list_agents and from the agentTeam projection (Web member panel)",
			service: "agentTeams.removeTeammate(caller, name) interrupts the live turn, releases the activation, appends the removal event, then deletes the saved session directory",
			tool: "Lead-only remove_teammate returns { removed: true, target, previousStatus, sessionDeleted }",
			session: "the teammate's sessions/<workspace>/session-<id> directory is removed (override root with DSH_SESSIONS_DIR)"
		},
		note: "Installed bundles are patched in place; restart DSH Desktop to load the change."
	}, null, 2) + "\n");
	console.log(JSON.stringify({ status: changed ? "patched" : "already-applied", manifest: MANIFEST }, null, 2));
	return 0;
}

process.exit(main());
