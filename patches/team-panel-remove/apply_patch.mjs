/**
 * In-place patch: confirmed "remove member" control for the Agent Teams panel.
 *
 * v4: the control is a small text link under each non-Lead member card, styled
 * with the panel's own classes (no absolute positioning, no inline chrome);
 * clicking it swaps that line into "delete this member and its conversation?"
 * with 删除 / 取消 links. The host command is invoked through the injected
 * `remote.commands` service.
 *
 * Usage:
 *   DSH_APP_DIR=<...> node apply_patch.mjs --check
 *   DSH_APP_DIR=<...> node apply_patch.mjs
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
const MARK = "removeMemberLine";

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

const INJECT_OLD = `		const inject = [
			"sessions",
			"uiWorkspace",
			"slots",
			"locale"
		];`;
const INJECT_NEW = `		const inject = [
			"sessions",
			"uiWorkspace",
			"slots",
			"locale",
			"remote.commands"
		];`;

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
				const commands = ctx.remote?.commands;
				if (commands === void 0 || typeof commands.execute !== "function") return Promise.reject(new Error("team removal is unavailable in this client"));
				return commands.execute(leadSessionId(sessionId), \`/team-remove \${memberName}\`, []);
			} };`;

const PROPS_OLD = "function TeamAction({ sessionId, useSession, useSessions, useSessionStatus, openTeammate, t }) {";
const PROPS_NEW = "function TeamAction({ sessionId, useSession, useSessions, useSessionStatus, openTeammate, removeTeammate, t }) {";

const STATE_OLD = `			const [error, setError] = (0, react.useState)(null);`;
const STATE_NEW = `			const [error, setError] = (0, react.useState)(null);
			const [removeTarget, setRemoveTarget] = (0, react.useState)(null);`;

const RESET_OLD = `			(0, react.useEffect)(() => {
				cancelHoverChange();
				pinnedRef.current = false;
				setOpen(false);
				setError(null);
			}, [sessionId]);`;
const RESET_NEW = `			(0, react.useEffect)(() => {
				cancelHoverChange();
				pinnedRef.current = false;
				setOpen(false);
				setError(null);
				setRemoveTarget(null);
			}, [sessionId]);`;

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
											display: "flex",
											flexDirection: "column",
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
										}, member.id), member.role !== "lead" && (0, react_jsx_runtime.jsx)("div", {
											className: TeamAction_module_css_default.meta,
											style: {
												display: "flex",
												alignItems: "center",
												gap: 6,
												padding: "1px 12px 3px"
											},
											children: removeTarget !== null && removeTarget.id === member.id ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)("span", { children: t("removeConfirmShort") }), (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: TeamAction_module_css_default.expandToggle,
												style: { marginLeft: 0, float: "none" },
												onClick: () => {
													const target = removeTarget;
													setRemoveTarget(null);
													Promise.resolve(removeTeammate(sessionId, target.name)).catch((reason) => setError(String(reason)));
												},
												children: t("confirm")
											}), (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: TeamAction_module_css_default.expandToggle,
												style: { marginLeft: 0, float: "none" },
												onClick: () => setRemoveTarget(null),
												children: t("cancel")
											})] }) : (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: TeamAction_module_css_default.expandToggle,
												style: { marginLeft: 0, float: "none" },
												onClick: () => setRemoveTarget({
													id: member.id,
													name: member.name
												}),
												children: t("remove")
											})
										})]
									}, member.id))`;

const ZH_OLD = '\t\t\topen: "打开成员会话",';
const ZH_NEW = '\t\t\topen: "打开成员会话",\n\t\t\tremove: "移除",\n\t\t\tremoveConfirmShort: "删除该成员及其会话？",\n\t\t\tconfirm: "删除",\n\t\t\tcancel: "取消",';
const EN_OLD = '\t\t\topen: "Open member conversation",';
const EN_NEW = '\t\t\topen: "Open member conversation",\n\t\t\tremove: "Remove",\n\t\t\tremoveConfirmShort: "Delete this member and its conversation?",\n\t\t\tconfirm: "Delete",\n\t\t\tcancel: "Cancel",';

function patch(source) {
	if (source.includes(MARK)) return source;
	let text = source;
	text = replaceOnce(text, INJECT_OLD, INJECT_NEW, "client inject list");
	text = replaceOnce(text, ACTIONS_OLD, ACTIONS_NEW, "panel actions");
	text = replaceOnce(text, PROPS_OLD, PROPS_NEW, "TeamAction props");
	text = replaceOnce(text, STATE_OLD, STATE_NEW, "confirmation state");
	text = replaceOnce(text, RESET_OLD, RESET_NEW, "reset on session change");
	text = replaceOnce(text, ROWS_OLD, ROWS_NEW, "roster row with remove line");
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
	if (!changed && process.env.DSH_FORCE_PANEL !== "1") {
		console.log(JSON.stringify({ status: "already-applied" }, null, 2));
		return 0;
	}
	writeFileSync(CLIENT, next);
	writeFileSync(path.join(PATCHDIR, "manifest.json"), JSON.stringify({
		id: "team-panel-remove-20261119",
		version: 4,
		applied_at: new Date().toISOString(),
		file: "node_modules/@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js",
		original_sha256: digest(backup),
		patched_sha256: digest(CLIENT),
		behavior: "each non-Lead member card gains a small 移除 link styled with the panel's own classes; it expands inline into 删除 / 取消 and only 删除 runs /team-remove through remote.commands",
		note: "Client bundle is served from disk; refresh the Web UI page to load it."
	}, null, 2) + "\n");
	console.log(JSON.stringify({ status: "patched" }, null, 2));
	return 0;
}

process.exit(main());
