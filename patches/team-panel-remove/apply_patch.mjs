/**
 * In-place patch: add a manual "remove member" control to the Agent Teams panel.
 *
 * The panel lists the roster from the Lead Session's `agentTeam` projection.
 * The control runs the host command `/team-remove <name>` through the client
 * Remote command channel, which removes the member from the roster and deletes
 * its saved session (requires the team-member-remove patch on the host).
 *
 * Usage:
 *   DSH_APP_DIR=<...> node apply_patch.mjs --check
 *   DSH_APP_DIR=<...> node apply_patch.mjs
 *
 * Idempotent; fails loudly on an ambiguous anchor. Refresh the page afterwards.
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
const CLIENT = path.join(APP, "node_modules/@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js");
const PATCHDIR = process.env.DSH_PATCH_BACKUP_DIR ?? path.join(HERE, ".backups");
const CHECK_ONLY = process.argv.includes("--check");
const MARK = "removeTeammate(sessionId, memberName)";

function fail(message) {
	throw new Error(`team-panel-remove: ${message}`);
}
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first < 0) fail(`anchor not found: ${label}`);
	if (text.indexOf(find, first + find.length) >= 0) fail(`anchor is ambiguous: ${label}`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

const ACTIONS_OLD = `			const actions = { openTeammate(sessionId, childSessionId) {
				const parentSessionId = leadSessionId(sessionId);
				if ((sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0) return;
				if (childSessionId === parentSessionId) {
					ctx.uiWorkspace.openSession(parentSessionId);
					return;
				}
				ctx.uiWorkspace.openSession({
					parentSessionId,
					childSessionId,
					mode: "continuable"
				});
			} };`;
const ACTIONS_NEW = `			const actions = { openTeammate(sessionId, childSessionId) {
				const parentSessionId = leadSessionId(sessionId);
				if ((sessions.retainInfo(sessionId).getSnapshot().retainedBy.mainView ?? 0) === 0) return;
				if (childSessionId === parentSessionId) {
					ctx.uiWorkspace.openSession(parentSessionId);
					return;
				}
				ctx.uiWorkspace.openSession({
					parentSessionId,
					childSessionId,
					mode: "continuable"
				});
			}, removeTeammate(sessionId, memberName) {
				const remote = typeof ctx.get === "function" ? ctx.get("remote") : void 0;
				if (remote === void 0 || remote.commands === void 0) return Promise.reject(new Error("team removal is unavailable in this client"));
				return remote.commands.execute(leadSessionId(sessionId), \`/team-remove \${memberName}\`);
			} };`;

const PROPS_OLD = "function TeamAction({ sessionId, useSession, useSessions, useSessionStatus, openTeammate, t }) {";
const PROPS_NEW = "function TeamAction({ sessionId, useSession, useSessions, useSessionStatus, openTeammate, removeTeammate, t }) {";

const ROWS_OLD = `									children: team.members.map((member) => (0, react_jsx_runtime.jsx)(TeamMemberRow, {
										member,
										memberCount: team.members.length,
										sessionId,
										useSessions,
										useSessionStatus,
										openTeammate,
										onError: setError,
										t
									}, member.id))`;
const ROWS_NEW = `									children: team.members.map((member) => (0, react_jsx_runtime.jsxs)("div", {
										style: {
											position: "relative",
											minWidth: 0
										},
										children: [(0, react_jsx_runtime.jsx)(TeamMemberRow, {
											member,
											memberCount: team.members.length,
											sessionId,
											useSessions,
											useSessionStatus,
											openTeammate,
											onError: setError,
											t
										}, member.id), member.role !== "lead" && member.phase !== "removed" && (0, react_jsx_runtime.jsx)("span", {
											role: "button",
											tabIndex: 0,
											title: t("remove"),
											onClick: (event) => {
												event.stopPropagation();
												Promise.resolve(removeTeammate(sessionId, member.name)).catch((reason) => setError(String(reason)));
											},
											style: {
												position: "absolute",
												top: 4,
												right: 6,
												cursor: "pointer",
												opacity: 0.5,
												fontSize: 14,
												lineHeight: 1,
												padding: "2px 4px"
											},
											children: "×"
										})]
									}, member.id))`;

const ZH_OLD = '\t\t\topen: "打开成员会话",';
const ZH_NEW = '\t\t\topen: "打开成员会话",\n\t\t\tremove: "移除成员并删除会话",';
const EN_OLD = '\t\t\topen: "Open member conversation",';
const EN_NEW = '\t\t\topen: "Open member conversation",\n\t\t\tremove: "Remove member and delete conversation",';

function patch(source) {
	if (source.includes(MARK)) return source;
	let text = source;
	text = replaceOnce(text, ACTIONS_OLD, ACTIONS_NEW, "panel actions");
	text = replaceOnce(text, PROPS_OLD, PROPS_NEW, "TeamAction props");
	text = replaceOnce(text, ROWS_OLD, ROWS_NEW, "roster row wrapper");
	text = replaceOnce(text, ZH_OLD, ZH_NEW, "zh dictionary");
	text = replaceOnce(text, EN_OLD, EN_NEW, "en dictionary");
	return text;
}

function main() {
	if (!existsSync(CLIENT)) fail("client bundle not found");
	const text = readFileSync(CLIENT, "utf8");
	const next = patch(text);
	const changed = next !== text;
	if (CHECK_ONLY) {
		console.log(JSON.stringify({ applied: !changed, client: digest(CLIENT) }, null, 2));
		return changed ? 1 : 0;
	}
	mkdirSync(path.join(PATCHDIR, "originals"), { recursive: true });
	const backup = path.join(PATCHDIR, "originals/client-ui-agent-team.client.js");
	if (!existsSync(backup)) writeFileSync(backup, text);
	if (changed) writeFileSync(CLIENT, next);
	writeFileSync(path.join(PATCHDIR, "manifest.json"), JSON.stringify({
		id: "team-panel-remove-20261118",
		applied_at: new Date().toISOString(),
		file: "node_modules/@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js",
		original_sha256: digest(backup),
		patched_sha256: digest(CLIENT),
		behavior: "each non-lead roster row gains a × control that runs /team-remove <name> through the client Remote command channel; removed members disappear from the panel",
		note: "Client bundle is served from disk; refresh the Web UI page to load it."
	}, null, 2) + "\n");
	console.log(JSON.stringify({ status: changed ? "patched" : "already-applied" }, null, 2));
	return 0;
}

process.exit(main());
