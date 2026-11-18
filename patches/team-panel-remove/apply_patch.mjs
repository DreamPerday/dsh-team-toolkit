/**
 * In-place patch: add a confirmed "remove member" control to the Agent Teams panel.
 *
 * The panel lists the roster from the Lead Session's `agentTeam` projection.
 * Each non-Lead row gets a × control; clicking it opens an in-panel confirmation
 * ("remove <name> and its conversation?"), and only the confirm button runs the
 * host command `/team-remove <name>` through the client Remote command channel.
 *
 * Usage:
 *   DSH_APP_DIR=<...> node apply_patch.mjs --check
 *   DSH_APP_DIR=<...> node apply_patch.mjs
 *
 * Applies to the pristine client bundle (v3). Idempotent; fails loudly on an
 * ambiguous anchor. Refresh the page afterwards.
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
const MARK = "removeTarget";

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
												setRemoveTarget({
													id: member.id,
													name: member.name
												});
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

const ERROR_BAR_OLD = `							error !== null && (0, react_jsx_runtime.jsxs)("div", {
								className: TeamAction_module_css_default.error,
								role: "alert",
								children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, { state: "error" }), error]
							}),`;
const ERROR_BAR_NEW = ERROR_BAR_OLD + `
							removeTarget !== null && (0, react_jsx_runtime.jsxs)("div", {
								className: TeamAction_module_css_default.notice,
								role: "alertdialog",
								style: { flexWrap: "wrap" },
								children: [(0, react_jsx_runtime.jsx)("span", {
									children: t("confirmRemove", { name: removeTarget.name })
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => {
										const target = removeTarget;
										setRemoveTarget(null);
										Promise.resolve(removeTeammate(sessionId, target.name)).catch((reason) => setError(String(reason)));
									},
									children: t("confirm")
								}), (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									onClick: () => setRemoveTarget(null),
									children: t("cancel")
								})]
							}),`;

const ZH_OLD = '\t\t\topen: "打开成员会话",';
const ZH_NEW = '\t\t\topen: "打开成员会话",\n\t\t\tremove: "移除成员",\n\t\t\tconfirmRemove: "删除队友 {name} 及其会话？此操作不可恢复。",\n\t\t\tconfirm: "删除",\n\t\t\tcancel: "取消",';
const EN_OLD = '\t\t\topen: "Open member conversation",';
const EN_NEW = '\t\t\topen: "Open member conversation",\n\t\t\tremove: "Remove member",\n\t\t\tconfirmRemove: "Remove teammate {name} and delete its conversation? This cannot be undone.",\n\t\t\tconfirm: "Delete",\n\t\t\tcancel: "Cancel",';

function patch(source) {
	if (source.includes(MARK)) return source;
	let text = source;
	text = replaceOnce(text, ACTIONS_OLD, ACTIONS_NEW, "panel actions");
	text = replaceOnce(text, PROPS_OLD, PROPS_NEW, "TeamAction props");
	text = replaceOnce(text, STATE_OLD, STATE_NEW, "confirmation state");
	text = replaceOnce(text, RESET_OLD, RESET_NEW, "reset on session change");
	text = replaceOnce(text, ROWS_OLD, ROWS_NEW, "roster row wrapper");
	text = replaceOnce(text, ERROR_BAR_OLD, ERROR_BAR_NEW, "confirmation bar");
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
		version: 3,
		applied_at: new Date().toISOString(),
		file: "node_modules/@deepseek-ai/dsh-experimental-client-ui-agent-team/lib/client.js",
		original_sha256: digest(backup),
		patched_sha256: digest(CLIENT),
		behavior: "each non-Lead roster row gains a × control that opens an in-panel confirmation; only the confirm button runs /team-remove <name> through the client Remote command channel",
		note: "Client bundle is served from disk; refresh the Web UI page to load it."
	}, null, 2) + "\n");
	console.log(JSON.stringify({ status: changed ? "patched" : "already-applied" }, null, 2));
	return 0;
}

process.exit(main());
