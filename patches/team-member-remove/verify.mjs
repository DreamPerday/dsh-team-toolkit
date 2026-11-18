/**
 * Verification for the team-member-remove patch.
 *
 * Layers:
 *  1. Both patched bundles import cleanly.
 *  2. The TeamService exposes removeTeammate.
 *  3. The roster enforces the new terminal phase: schema enum, transition table,
 *     list filtering, name/slot reuse, live-children filtering, spawn settle guard.
 *  4. The tool bundle registers remove_teammate with its value schema and policy text.
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
const TEAM_FILE = `${APP}/node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js`;
const TOOL_FILE = `${APP}/node_modules/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js`;

const teamText = readFileSync(TEAM_FILE, "utf8");
const toolText = readFileSync(TOOL_FILE, "utf8");

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
check("TeamService.removeTeammate is exported", () => assert.equal(typeof teamModule.TeamService.prototype.removeTeammate, "function"));

check("persisted member schema accepts removed", () => {
	const enums = teamText.split('phase: z$1.enum([').length - 1;
	assert.equal(enums, 2, "expected both member phase enums");
	assert.equal(teamText.split('"removed"').length - 1 >= 4, true);
});
check("transition table is terminal", () => {
	assert.match(teamText, /const allowed = prior\.phase === "provisioning" \? \["active", "failed", "removed"\] : prior\.phase === "removed" \? \[\] : \["removed"\];/);
});
check("roster list hides removed members", () => {
	assert.match(teamText, /for \(const member of state\.members\) \{\n\t+if \(member\.phase === "removed"\) continue;/);
});
check("name reuse and member slots ignore removed members", () => {
	assert.match(teamText, /member\.name === name && member\.phase !== "removed"/);
	assert.match(teamText, /state\.members\.filter\(\(member\) => member\.phase !== "removed"\)\.length >= this\.maxMembers/);
});
check("live children projection ignores removed members", () => {
	assert.match(teamText, /member\.id === agent\.id && member\.phase !== "removed"/);
});
check("spawn settle guards a concurrent removal", () => {
	assert.match(teamText, /settledPhase === "removed"/);
});
check("roster removal appends the terminal phase", () => {
	assert.match(teamText, /member: \{ \.\.\.current, phase: "removed" \}/);
});
check("tool registers remove_teammate", () => {
	assert.match(toolText, /name: "remove_teammate"/);
	assert.match(toolText, /const REMOVE_VALUE_SCHEMA = \{/);
	assert.match(toolText, /removed: true,/);
});
check("team policy mentions remove_teammate", () => {
	assert.match(toolText, /for send_message, remove_teammate/);
});

const failed = results.filter((entry) => entry.status === "fail");
console.log(JSON.stringify({ passed: results.length - failed.length, failed: failed.length, results }, null, 2));
process.exit(failed.length === 0 ? 0 : 1);
