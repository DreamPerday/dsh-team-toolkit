/**
 * Fix: name reuse after removal shadowed the live member.
 *
 * `resolveActiveMember` and `removeTeammate` matched a member by name with the
 * first record in creation order. After a member is removed and recreated with
 * the same name, the first match is the removed tombstone, so every
 * `send_message` fails with `active teammate "<name>" not found` even though a
 * live active member with that name exists.
 *
 * v4 prefers an `active` record, then a non-removed one.
 *
 * Usage: DSH_APP_DIR=<...> node apply_fix_v4.mjs [--check]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
	console.error("usage: DSH_APP_DIR=<DSH Desktop resources/app> node apply_fix_v4.mjs   (or pass --app <dir>)");
	process.exit(2);
}
const TEAM = path.join(APP, "node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js");
const CHECK_ONLY = process.argv.includes("--check");
const MARK = "candidate.phase === \"active\") ?? state.members.find";

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function fail(message) {
	throw new Error(`team-member-remove-v4: ${message}`);
}
function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first < 0) fail(`anchor not found: ${label}`);
	if (text.indexOf(find, first + find.length) >= 0) fail(`anchor is ambiguous: ${label}`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

const RESOLVE_OLD = [
	"\tconst member = state.members.find((candidate) => candidate.name === name);",
	"\tif (member === void 0 || member.phase !== \"active\") throw new TeamError(`active teammate \"${name}\" not found`, \"TEAM_MEMBER_NOT_FOUND\");"
].join("\n");
const RESOLVE_NEW = [
	"\tconst member = state.members.find((candidate) => candidate.name === name && candidate.phase === \"active\");",
	"\tif (member === void 0) throw new TeamError(`active teammate \"${name}\" not found`, \"TEAM_MEMBER_NOT_FOUND\");"
].join("\n");

const REMOVE_OLD = [
	"\t\tconst root = membership.root;",
	"\t\tconst target = this.journal.state(root).members.find((candidate) => candidate.name === name);"
].join("\n");
const REMOVE_NEW = [
	"\t\tconst root = membership.root;",
	"\t\tconst state = this.journal.state(root);",
	"\t\tconst target = state.members.find((candidate) => candidate.name === name && candidate.phase === \"active\") ?? state.members.find((candidate) => candidate.name === name && candidate.phase !== \"removed\");"
].join("\n");

const text = readFileSync(TEAM, "utf8");
if (text.includes(MARK)) {
	console.log(JSON.stringify({ applied: true, team: digest(TEAM) }, null, 2));
	process.exit(0);
}
let next = replaceOnce(text, RESOLVE_OLD, RESOLVE_NEW, "resolveActiveMember lookup");
next = replaceOnce(next, REMOVE_OLD, REMOVE_NEW, "removeTeammate lookup");
if (CHECK_ONLY) {
	console.log(JSON.stringify({ applied: false, team: digest(TEAM) }, null, 2));
	process.exit(1);
}
writeFileSync(TEAM, next);
console.log(JSON.stringify({ status: "patched", team: digest(TEAM) }, null, 2));
