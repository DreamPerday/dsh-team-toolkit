/**
 * Pure, dependency-free event reduction for the P0 team cache/prefix audit.
 *
 * The Host half (`index.js`) owns filesystem access and Cordis wiring; this module
 * only turns one durable Session event into at most one JSONL record. Keeping the
 * reduction pure lets `verify.mjs` exercise the record schema with a fake clock and
 * a fake writer, without loading the DSH runtime.
 *
 * Record kinds (`k`):
 *   header  - `request/header`: a new request series or a changed call envelope.
 *             `series: true` is the only signal that the provider prefix was reset.
 *   req     - `assistant/message`: one model request and its provider-reported usage.
 *   warn    - consecutive low cache-hit streak for one Session (a candidate, not a
 *             verdict: the analyser must confirm the requests are comparable).
 *   compact - `compaction/start|end|summary|prune`: prefix-rewrite evidence.
 *   tcall   - `tool/call`: tool name and argument size.
 *   tres    - `tool/result`: result size, used to find over-budget tool outputs.
 *   team    - `team/member` or `team/task`: coordination state change.
 *
 * The record set is intentionally additive: no field is required for a consumer to
 * make progress, and every numeric provider field is recorded raw (`in`/`out`/`cr`/`cw`)
 * so the analyser can state its own denominator instead of inheriting an assumption.
 */

/** Bump only when an existing field changes meaning; new optional fields do not. */
export const SCHEMA_VERSION = 1;

/** Team coordination tools whose call counts measure polling overhead. */
export const TEAM_TOOL_NAMES = Object.freeze([
  "spawn_teammate",
  "send_message",
  "list_agents",
  "wait_agent",
  "interrupt_agent",
  "team_task_create",
  "team_task_list",
  "team_task_get",
  "team_task_update",
]);

/** @param {unknown} value @returns {number | null} */
const asInt = (value) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;

/** @param {unknown} value @param {number} [max] @returns {string | undefined} */
const asText = (value, max = 200) =>
  typeof value === "string" && value.length > 0 ? value.slice(0, max) : undefined;

/** @param {unknown} value @returns {string | undefined} */
const asReason = (value) => {
  if (typeof value === "string") return value.slice(0, 300);
  if (value !== null && typeof value === "object" && "message" in value) {
    return asReason(/** @type {{ message: unknown }} */ (value).message);
  }
  return undefined;
};

/**
 * Count the model-visible size of one tool result.
 * @param {unknown} content - tool result content blocks.
 * @returns {{ chars: number, blocks: number }}
 */
function contentSize(content) {
  if (!Array.isArray(content)) return { chars: 0, blocks: 0 };
  let chars = 0;
  for (const block of content) {
    if (block !== null && typeof block === "object" && block.type === "text") {
      if (typeof block.text === "string") chars += block.text.length;
    }
  }
  return { chars, blocks: content.length };
}

/**
 * Size one JSON-like value without letting a cyclic or hostile value throw.
 * @param {unknown} value - tool-call arguments.
 * @returns {number}
 */
function jsonSize(value) {
  try {
    return JSON.stringify(value ?? null)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Build the event reducer.
 *
 * @param {object} options
 * @param {(record: object) => void} options.emit - receives one finished record.
 * @param {(session: object) => string} options.roleOf - `lead`, `teammate:<name>`, `sub`, `unknown`.
 * @param {() => number} [options.now] - epoch milliseconds; injectable for tests.
 * @param {boolean} [options.recordToolResults] - record `tres` records.
 * @param {number} [options.warnHitRateBelow] - hit-rate floor for a `warn` streak.
 * @param {number} [options.warnConsecutive] - consecutive low requests before warning.
 * @returns {(session: object, event: object) => void} one Session-event listener.
 */
export function createRecorder(options) {
  const {
    emit,
    roleOf,
    now = () => Date.now(),
    recordToolResults = true,
    warnHitRateBelow = 0.5,
    warnConsecutive = 3,
  } = options;

  /** @type {Map<string, number>} consecutive low-hit requests per Session. */
  const streaks = new Map();

  return function onSessionEvent(session, event) {
    const sessionId = asText(session?.id, 120);
    const type = event?.type;
    if (sessionId === undefined || typeof type !== "string") return;
    const data = event.data ?? {};
    const head = () => ({ v: SCHEMA_VERSION, t: now(), s: sessionId, r: roleOf(session) });

    if (type === "request/header") {
      emit({
        ...head(),
        k: "header",
        reason: asText(data.reason, 32),
        series: data.startsSeries === true,
        tools: Array.isArray(data.header?.tools) ? data.header.tools.length : null,
        prov: asText(data.header?.config?.provider, 80),
        model: asText(data.header?.config?.model, 120),
      });
      return;
    }

    if (type === "assistant/message") {
      const usage = data.usage;
      const source = data.message?.source;
      /** @type {Record<string, unknown>} */
      const record = {
        ...head(),
        k: "req",
        turn: asInt(data.turn),
        step: asInt(data.step),
        prov: asText(source?.provider, 80),
        model: asText(source?.model, 120),
        interrupted: data.interrupted === true,
        in: null,
        out: null,
        cr: null,
        cw: null,
        hit: null,
        denom: null,
      };
      if (usage !== null && typeof usage === "object") {
        record.in = asInt(usage.inputTokens);
        record.out = asInt(usage.outputTokens);
        record.cr = asInt(usage.cacheReadTokens);
        record.cw = asInt(usage.cacheWriteTokens);
        // Adapters disagree on whether `inputTokens` already contains the cached part
        // (the DeepSeek adapter reports it uncached; the OpenAI-compatible one may not).
        // `denom` is therefore an explicit estimate; the raw fields stay authoritative.
        const denom = (record.in ?? 0) + (record.cr ?? 0) + (record.cw ?? 0);
        if (denom > 0) {
          record.denom = denom;
          record.hit = Number(((record.cr ?? 0) / denom).toFixed(4));
        }
      }
      emit(record);

      const hit = typeof record.hit === "number" ? record.hit : null;
      if (hit === null) {
        streaks.set(sessionId, 0);
        return;
      }
      if (hit < warnHitRateBelow) {
        const streak = (streaks.get(sessionId) ?? 0) + 1;
        streaks.set(sessionId, streak);
        if (streak === warnConsecutive) {
          emit({
            ...head(),
            k: "warn",
            streak,
            hit,
            prov: record.prov,
            model: record.model,
          });
        }
      } else {
        streaks.set(sessionId, 0);
      }
      return;
    }

    if (type === "compaction/start" || type === "compaction/end") {
      emit({
        ...head(),
        k: "compact",
        ty: type === "compaction/start" ? "start" : "end",
        id: asText(data.compactionId, 64),
        turn: asInt(data.turn),
        err: asReason(data.error),
      });
      return;
    }

    if (type === "compaction/summary") {
      emit({
        ...head(),
        k: "compact",
        ty: "summary",
        id: asText(data.compactionId, 64),
        shadowed: asInt(data.shadowedTokenCount),
        start: asInt(data.shadowedRange?.start),
        end: asInt(data.shadowedRange?.end),
        prov: asText(data.provider, 80),
        model: asText(data.model, 120),
        in: asInt(data.usage?.inputTokens),
        cr: asInt(data.usage?.cacheReadTokens),
      });
      return;
    }

    if (type === "compaction/prune") {
      emit({
        ...head(),
        k: "compact",
        ty: "prune",
        shadowed: asInt(data.shadowedTokenCount),
        start: asInt(data.shadowedRange?.start),
        end: asInt(data.shadowedRange?.end),
      });
      return;
    }

    if (type === "image/offload") {
      emit({ ...head(), k: "compact", ty: "image-offload", id: asText(data.imageId, 64) });
      return;
    }

    if (type === "tool/call") {
      emit({
        ...head(),
        k: "tcall",
        name: asText(data.name, 80),
        call: asText(data.callId, 80),
        args: jsonSize(data.arguments),
      });
      return;
    }

    if (type === "tool/result") {
      if (!recordToolResults) return;
      const size = contentSize(data.message?.content);
      emit({
        ...head(),
        k: "tres",
        call: asText(data.message?.callId, 80),
        chars: size.chars,
        blocks: size.blocks,
        err: data.error !== undefined || data.message?.isError === true,
      });
      return;
    }

    if (type === "team/member" || type === "team/task") {
      const member = data.member;
      const task = data.task;
      emit({
        ...head(),
        k: "team",
        ty: type === "team/member" ? "member" : "task",
        name: asText(member?.name ?? task?.ownerName, 80),
        status: asText(member?.phase ?? task?.status, 32),
        id: asText(member?.id ?? task?.id, 64),
        rev: asInt(task?.revision),
      });
    }
  };
}
