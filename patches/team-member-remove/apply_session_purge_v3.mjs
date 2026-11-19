/**
 * Upgrade the team-member-remove host patch to v3: correct session purge.
 *
 * v2 looked for `<sessions>/<workspace>/session-<id>` only, so teammate
 * sessions (stored as `<sessions>/<workspace>/<id>`) were never deleted.
 * v3 also removes the projection-cache entry, retries around transient file
 * locks, and records ids it could not delete in
 * `~/.dsh/team-ext/pending-session-purge.txt` for the next Host start.
 *
 * Usage: DSH_APP_DIR=<...> node apply_patch_v3.mjs [--check]
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
	console.error("usage: DSH_APP_DIR=<DSH Desktop resources/app> node apply_patch_v3.mjs   (or pass --app <dir>)");
	process.exit(2);
}
const TEAM = path.join(APP, "node_modules/@deepseek-ai/dsh-experimental-agent-team/lib/index.js");
const CHECK_ONLY = process.argv.includes("--check");
const MARK = "removeWithRetry";

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
function fail(message) {
	throw new Error(`team-member-remove-v3: ${message}`);
}
function replaceOnce(text, find, replacement, label) {
	const first = text.indexOf(find);
	if (first < 0) fail(`anchor not found: ${label}`);
	if (text.indexOf(find, first + find.length) >= 0) fail(`anchor is ambiguous: ${label}`);
	return text.slice(0, first) + replacement + text.slice(first + find.length);
}

const OLD_HELPER = [
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
].join("\n");

const NEW_HELPER = [
	"/** Remove a path, retrying around transient Windows file locks. */",
	"async function removeWithRetry(fs, target) {",
	"	for (let attempt = 0; attempt < 6; attempt += 1) {",
	"		try {",
	"			await fs.rm(target, { recursive: true, force: true });",
	"			return true;",
	"		} catch {",
	"			await new Promise((resolve) => setTimeout(resolve, 200));",
	"		}",
	"	}",
	"	return false;",
	"}",
	"/** Delete the removed teammate's saved session directory and projection cache, best effort. */",
	"async function purgeMemberSession(id) {",
	"	const fs = await import(\"node:fs/promises\");",
	"	const os = await import(\"node:os\");",
	"	const p = await import(\"node:path\");",
	"	const home = os.homedir();",
	"	const root = process.env.DSH_SESSIONS_DIR ?? p.join(home, \".dsh\", \"sessions\");",
	"	const pendingFile = p.join(home, \".dsh\", \"team-ext\", \"pending-session-purge.txt\");",
	"	const candidates = [];",
	"	try {",
	"		for (const entry of await fs.readdir(root, { withFileTypes: true })) {",
	"			if (!entry.isDirectory()) continue;",
	"			candidates.push(p.join(root, entry.name, `session-${id}`));",
	"			candidates.push(p.join(root, entry.name, id));",
	"		}",
	"	} catch {}",
	"	let found = false;",
	"	let deleted = false;",
	"	for (const candidate of candidates) {",
	"		try {",
	"			const stat = await fs.stat(candidate);",
	"			if (!stat.isDirectory()) continue;",
	"		} catch {",
	"			continue;",
	"		}",
	"		found = true;",
	"		if (await removeWithRetry(fs, candidate)) deleted = true;",
	"	}",
	"	try {",
	"		await fs.rm(p.join(home, \".dsh\", \"storages\", \"session_projcache\", \"sessions\", `${id}.json`), { force: true });",
	"	} catch {}",
	"	if (found && !deleted) {",
	"		try {",
	"			await fs.mkdir(p.dirname(pendingFile), { recursive: true });",
	"			await fs.appendFile(pendingFile, `${id}\\n`);",
	"		} catch {}",
	"	}",
	"	return deleted;",
	"}"
].join("\n");

const text = readFileSync(TEAM, "utf8");
if (!text.includes(MARK)) {
	if (!text.includes(OLD_HELPER)) fail("v2 purge helper not found");
	const next = replaceOnce(text, OLD_HELPER, NEW_HELPER, "purge helper");
	if (CHECK_ONLY) {
		console.log(JSON.stringify({ applied: false, team: digest(TEAM) }, null, 2));
		process.exit(1);
	}
	writeFileSync(TEAM, next);
	console.log(JSON.stringify({ status: "patched", team: digest(TEAM) }, null, 2));
} else {
	console.log(JSON.stringify({ applied: true, team: digest(TEAM) }, null, 2));
}
