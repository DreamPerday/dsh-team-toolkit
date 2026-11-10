/**
 * P0 team cache/prefix audit — Host half.
 *
 * The plugin observes durable Session events and appends one JSONL record per
 * interesting event. It registers no tool, no prompt section, and no context, so a
 * Session running with this plugin sends a byte-identical model request to one
 * running without it: the observation costs no tokens and cannot invalidate the
 * provider prefix.
 *
 * Data goes to `<logDir>/cache-events-YYYYMMDD.jsonl`, one JSON object per line.
 * Schema and analysis guidance live in README.md and `core.mjs`.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createRecorder } from "./core.mjs";

/** Cordis plugin name used by Loader diagnostics. */
export const name = "team-ext";

/**
 * `agents` resolves a Session id to its live Agent, which is how a record names the
 * Team role. `agentTeams` is optional (a profile without the Team layer still loads
 * this plugin and records every non-Team Session as `sub`).
 */
export const inject = ["agents"];

/** Defaults mirrored by the patch file; every field is validated in `resolveConfig`. */
const DEFAULTS = Object.freeze({
  logDir: "",
  enabled: true,
  recordToolResults: true,
  warnHitRateBelow: 0.5,
  warnConsecutive: 3,
  flushMs: 2000,
});

/** @param {string} label @param {unknown} value @param {number} min @param {number} max */
function numberInRange(label, value, min, max) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new TypeError(`team-ext: ${label} must be a number from ${min} through ${max}`);
  }
  return value;
}

/**
 * Validate the Loader-supplied configuration. The plugin exports no `Config` schema,
 * so Cordis passes the raw object through and this function is the only guard.
 * @param {Record<string, unknown>} raw
 */
function resolveConfig(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("team-ext: config must be an object");
  }
  const allowed = new Set(Object.keys(DEFAULTS));
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new TypeError(`team-ext: unknown config key "${key}" (allowed: ${[...allowed].join(", ")})`);
    }
  }
  const config = { ...DEFAULTS, ...raw };
  if (typeof config.logDir !== "string") throw new TypeError("team-ext: logDir must be a string");
  if (typeof config.enabled !== "boolean") throw new TypeError("team-ext: enabled must be a boolean");
  if (typeof config.recordToolResults !== "boolean") {
    throw new TypeError("team-ext: recordToolResults must be a boolean");
  }
  numberInRange("warnHitRateBelow", config.warnHitRateBelow, 0, 1);
  numberInRange("warnConsecutive", config.warnConsecutive, 1, 100);
  numberInRange("flushMs", config.flushMs, 100, 60000);
  return config;
}

/**
 * Local calendar day for the log file name, so a long-lived Host rotates daily.
 * @param {Date} [date]
 * @returns {string} `YYYYMMDD`
 */
function dayStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/**
 * Register the observation listener for the lifetime of this plugin entry.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  if (!resolved.enabled) {
    ctx.logger?.info?.("[team-ext] disabled by config; no records will be written");
    return;
  }
  const logDir = resolved.logDir.length > 0 ? resolved.logDir : path.join(homedir(), ".dsh", "team-ext");
  const agents = ctx.agents;
  const teams = typeof ctx.get === "function" ? ctx.get("agentTeams") : undefined;

  /** @type {Map<string, string>} role is fixed for the life of a Session. */
  const roles = new Map();

  /** @param {{ id: string }} session */
  const roleOf = (session) => {
    const id = String(session?.id ?? "");
    const cached = roles.get(id);
    if (cached !== undefined) return cached;
    let role = "unknown";
    try {
      const agent = agents.get(id);
      if (agent !== undefined) {
        const membership = teams?.tryMembership?.(agent);
        role =
          membership === undefined
            ? "sub"
            : membership.role === "lead"
              ? "lead"
              : `teammate:${membership.name}`;
      }
    } catch {
      role = "unknown";
    }
    if (role !== "unknown") roles.set(id, role);
    return role;
  };

  /** @type {string[]} */
  let buffer = [];
  let directoryReady = false;
  let writeDisabled = false;

  const flush = () => {
    if (buffer.length === 0 || writeDisabled) return;
    const text = `${buffer.join("\n")}\n`;
    buffer = [];
    try {
      if (!directoryReady) {
        mkdirSync(logDir, { recursive: true });
        directoryReady = true;
      }
      appendFileSync(path.join(logDir, `cache-events-${dayStamp()}.jsonl`), text, "utf8");
    } catch (error) {
      // One broken path must not spam the log or take the Host down.
      writeDisabled = true;
      ctx.logger?.warn?.(`[team-ext] cannot write to ${logDir}: ${error?.message ?? error}`);
    }
  };

  const emit = (record) => {
    buffer.push(JSON.stringify(record));
    if (buffer.length >= 256) flush();
  };

  const onSessionEvent = createRecorder({
    emit,
    roleOf,
    recordToolResults: resolved.recordToolResults,
    warnHitRateBelow: resolved.warnHitRateBelow,
    warnConsecutive: resolved.warnConsecutive,
  });

  ctx.on("session/event", (session, event) => {
    try {
      onSessionEvent(session, event);
    } catch (error) {
      // A recording failure is never allowed to disturb the Session.
      ctx.logger?.warn?.(`[team-ext] record failed: ${error?.message ?? error}`);
    }
  });

  ctx.effect(
    () => {
      const timer = setInterval(flush, resolved.flushMs);
      timer.unref?.();
      return () => {
        clearInterval(timer);
        flush();
      };
    },
    "team-ext.flush()",
  );
}
