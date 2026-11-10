/**
 * dsh-team-compact — manual context compaction for Agent Teams.
 *
 * Adds two manual interfaces on top of the shipped compaction seam:
 *
 *   - tool `compact_context`   — available to the Lead and to every teammate
 *                                (scoped per team member, so new teammates get it
 *                                automatically). The Lead may target a member name
 *                                or an exact live session id; a teammate may only
 *                                compact itself.
 *   - command `/compact-agent` — human-facing wrapper with the same resolution,
 *                                usable from any session.
 *
 * Both only call public services: `toolResultPruner.pruneSession()` (LLM-free)
 * and `compaction.compactNow()` (summary). They never write session events
 * themselves, so every effect is replayable through the shipped plugins.
 *
 * Requires an idle target: `compactNow` reserves the agent's next-turn admission
 * and refuses while a turn is open or work is queued.
 */

/** Cordis plugin name used by Loader diagnostics. */
export const name = "team-compact";

/** `agents` resolves a Session id to its live Agent; `commands` hosts `/compact-agent`. */
export const inject = ["agents", "commands"];

/** Shared tool value contract; the registry validates every returned value. */
const VALUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: { type: "string" },
    mode: { type: "string" },
    before: { type: "integer" },
    after: { type: "integer" },
    window: { type: "integer" },
    prunedItems: { type: "integer" },
    prunedChars: { type: "integer" },
    compactedTokens: { type: "integer" },
    compactionError: { type: "string" },
    note: { type: "string" },
  },
  required: ["target", "mode", "before", "after", "prunedItems", "prunedChars"],
};

/** @param {unknown} value @returns {number | undefined} */
function integerOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

/**
 * Estimated context tokens for one Agent's session, or undefined when the meter
 * is unavailable. The estimate is the shipped heuristic (chars/4), not the
 * provider's exact count.
 * @param {object} ctx @param {object} agent
 * @returns {number | undefined}
 */
function measure(ctx, agent) {
  try {
    const meter = ctx.get?.("tokenMeter");
    const measurement = meter?.measure?.(agent.session);
    return integerOrUndefined(measurement?.totalTokens);
  } catch {
    return undefined;
  }
}

/**
 * The routed model's declared context window, when the LLM service can resolve it.
 * @param {object} ctx @param {object} agent
 * @returns {Promise<number | undefined>}
 */
async function contextWindow(ctx, agent) {
  try {
    const llm = ctx.get?.("llm");
    const config = agent.session?.requestHeader?.()?.config;
    if (llm === undefined || config?.provider === undefined || config?.model === undefined) return undefined;
    const info = await llm.resolveModelInfo(config.provider, config.model);
    return integerOrUndefined(info?.context?.contextWindow);
  } catch {
    return undefined;
  }
}

/** @param {object} target @param {object | undefined} membership */
function describeTarget(target, membership) {
  if (membership === undefined) return String(target.id);
  return membership.role === "lead" ? "lead" : `teammate:${membership.name}`;
}

/**
 * Resolve one compaction target from a tool/command request.
 * @param {object} ctx
 * @param {object | undefined} teams - the optional `agentTeams` service.
 * @param {object} caller - the exact invoking Agent.
 * @param {{ target?: string, session?: string }} request
 * @returns {{ agent: object, membership: object | undefined }}
 */
function resolveTarget(ctx, teams, caller, request) {
  const callerMembership = teams?.tryMembership?.(caller);
  const isLead = callerMembership?.role === "lead";
  if (typeof request.session === "string" && request.session.length > 0) {
    if (!isLead) throw new Error("only the Team Lead may compact an arbitrary session id");
    const agent = ctx.agents.get(request.session);
    if (agent === undefined) throw new Error(`session "${request.session}" is not live`);
    return { agent, membership: teams?.tryMembership?.(agent) };
  }
  const requested = request.target ?? "self";
  if (requested === "self") return { agent: caller, membership: callerMembership };
  const row = teams?.listMembers?.(caller)?.find((member) => member.name === requested);
  if (row === undefined) throw new Error(`no Team member named "${requested}"`);
  const agent = ctx.agents.get(row.id);
  if (agent === undefined) throw new Error(`Team member "${requested}" is not live`);
  return { agent, membership: teams?.tryMembership?.(agent) };
}

/**
 * Prune then (optionally) summarize one idle Agent's context.
 * @param {object} ctx
 * @param {object | undefined} teams
 * @param {object} caller
 * @param {{ target?: string, session?: string, mode?: string }} request
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<object>} the tool value
 */
export async function runCompaction(ctx, teams, caller, request, signal) {
  const mode = request.mode ?? "auto";
  if (mode !== "auto" && mode !== "prune" && mode !== "compact") throw new Error(`unknown mode "${mode}"`);
  const { agent: target, membership } = resolveTarget(ctx, teams, caller, request);
  const targetLabel = describeTarget(target, membership);
  if (target.status !== "idle") {
    throw new Error(`target "${targetLabel}" is ${target.status}; wait until it is inactive or interrupt it first`);
  }

  /** @type {Record<string, unknown>} */
  const value = {
    target: targetLabel,
    mode,
    before: measure(ctx, target) ?? 0,
    after: 0,
    prunedItems: 0,
    prunedChars: 0,
  };
  const window = await contextWindow(ctx, target);
  if (window !== undefined) value.window = window;

  if (mode === "auto" || mode === "prune") {
    const pruner = target.ctx?.get?.("toolResultPruner");
    if (pruner === undefined) {
      value.note = "no tool-result pruner mounted in the target scope";
    } else {
      try {
        const result = pruner.pruneSession(target.session);
        value.prunedItems = Array.isArray(result?.pruned) ? result.pruned.length : 0;
        value.prunedChars = integerOrUndefined(result?.charsRemoved) ?? 0;
      } catch (error) {
        value.note = `prune failed: ${error?.message ?? error}`;
      }
    }
  }
  const afterPrune = measure(ctx, target);
  if (afterPrune !== undefined) value.after = afterPrune;

  const shouldSummarize =
    mode === "compact" || (mode === "auto" && (window === undefined || value.after >= window * 0.8));
  if (shouldSummarize) {
    const compaction = target.ctx?.get?.("compaction");
    if (compaction === undefined) {
      value.note = `${value.note ?? ""} no compaction service mounted in the target scope`.trim();
    } else {
      try {
        const result = await compaction.compactNow(target, signal);
        if (result !== null && result !== undefined) {
          value.compactedTokens = integerOrUndefined(result.shadowedTokenCount) ?? 0;
        }
      } catch (error) {
        value.compactionError = String(error?.code ?? error?.message ?? error);
      }
    }
  }

  const after = measure(ctx, target);
  if (after !== undefined) value.after = after;
  return value;
}

/**
 * Register the scoped tool for one Team member and the global human command.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function apply(ctx) {
  // Resolve lazily: the Team service may publish after this plugin applies.
  const teamsOf = () => ctx.get?.("agentTeams");

  const tool = {
    name: "compact_context",
    description:
      "Manually prune and/or compact a Team member's conversation context. The target must be idle (no turn running). The Team Lead may target a member name or an exact live session id; a teammate may only compact itself. Prune is LLM-free; compact summarizes with the target's routed model and fails when the target's context already exceeds that model's window.",
    parameters: {
      target: { type: "string", description: "Member name, 'lead', or 'self'. Defaults to 'self'." },
      session: { type: "string", description: "Exact live session id. Lead only; overrides target." },
      mode: {
        type: "string",
        enum: ["auto", "prune", "compact"],
        description: "auto prunes, then summarizes only when the estimate is near the model window. Defaults to auto.",
      },
    },
    required: [],
    output: {
      schema: VALUE_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      return runCompaction(ctx, teamsOf(), exec.agent, args ?? {}, exec.signal);
    },
  };

  /** @type {Map<object, () => void>} */
  const installed = new Map();
  const maybeInstall = (agent) => {
    if (installed.has(agent)) return;
    if (teamsOf()?.tryMembership?.(agent) === undefined) return;
    try {
      installed.set(agent, agent.ctx.tools.register(tool));
    } catch (error) {
      ctx.logger?.warn?.(`cannot register the compact tool for one member: ${error?.message ?? error}`);
    }
  };
  for (const agent of ctx.agents.list()) maybeInstall(agent);
  ctx.on("agent/created", ({ agent }) => maybeInstall(agent));
  ctx.on("agent/disposed", ({ agent }) => {
    installed.get(agent)?.();
    installed.delete(agent);
  });
  ctx.effect(
    () => () => {
      for (const dispose of installed.values()) dispose();
      installed.clear();
    },
    "team-compact.scopedTools()",
  );

  const USAGE = "Usage: /compact-agent <member-name|session-id|self> [auto|prune|compact]";
  const looksLikeSessionId = (value) => /^[0-9a-f][0-9a-f-]{7,}$/i.test(value);
  ctx.commands.register({
    definitionId: "dsh-team-compact/compact-agent",
    name: "compact-agent",
    description: "Manually prune/compact a Team member's context",
    async handler(invocation) {
      const parts = String(invocation.rawInput ?? "").trim().split(/\s+/).filter((part) => part.length > 0);
      if (parts.length === 0 || parts.length > 2) return { kind: "error", text: USAGE };
      const [first, second] = parts;
      const request = looksLikeSessionId(first) ? { session: first, mode: second } : { target: first, mode: second };
      try {
        const value = await runCompaction(ctx, teamsOf(), invocation.agent, request, invocation.signal);
        const detail = value.compactionError === undefined ? "" : `; compaction failed (${value.compactionError})`;
        return {
          kind: "success",
          text: `${value.target}: ${value.before} → ${value.after} estimated tokens (pruned ${value.prunedItems} results, ${value.prunedChars} chars)${detail}`,
        };
      } catch (error) {
        return { kind: "error", text: String(error?.message ?? error) };
      }
    },
  });
}
