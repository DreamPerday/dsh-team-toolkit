/**
 * dsh-team-compact — manual context compaction for DSH Agent Teams (0.2.2+).
 *
 * 0.2.2 changed Agent Teams: there is no roster and no `spawn_teammate`. A Team
 * is the subagent tree of one root Session; teammates are ordinary continuable
 * subagents addressed by name. This port keeps the two manual interfaces:
 *
 *   - tool `compact_context`   — Lead and every teammate (scoped per member).
 *   - command `/compact-agent` — human-facing wrapper.
 *
 * Both only call public services: `toolResultPruner.pruneSession()` (LLM-free)
 * and `compaction.compactNow()` (summary). Membership and names come from
 * `subagents.listDescendants()` / `subagents.resolveName()`.
 *
 * Requires an idle target: `compactNow` refuses while a turn is open.
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

/** Estimated context tokens for one Agent's session, or undefined when unavailable. */
function measure(ctx, agent) {
  try {
    const meter = ctx.get?.("tokenMeter");
    const measurement = meter?.measure?.(agent.session);
    return integerOrUndefined(measurement?.totalTokens);
  } catch {
    return undefined;
  }
}

/** The routed model's declared context window, when the LLM service can resolve it. */
async function contextWindow(ctx, agent) {
  try {
    const llm = ctx.get?.("llm");
    const config = agent.session?.requestHeader?.()?.config;
    if (llm === undefined || config?.provider === undefined || config?.model === undefined) return undefined;
    const info = await llm.resolveModelInfo(config.provider, config.model);
    return integerOrUndefined(info?.context?.contextWindow ?? info?.contextWindow);
  } catch {
    return undefined;
  }
}

/** Lazy service lookup so a late-published service is still found. */
function subagentsOf(ctx) {
  return ctx.get?.("subagents");
}

function teamsOf(ctx) {
  return ctx.get?.("agentTeams");
}

/** Whether one Agent belongs to a Team-enabled root tree. */
function inTeam(ctx, agent) {
  const teams = teamsOf(ctx);
  try {
    if (typeof teams?.isEnabled === "function") return teams.isEnabled(agent) === true;
  } catch {}
  // Team mode unknown (older build or service still loading): allow roots only.
  try {
    return subagentsOf(ctx)?.rootOf?.(agent)?.id === agent.id;
  } catch {
    return false;
  }
}

/** Roster row for the root's descendants, as `{ id, name }`. */
async function membersOf(ctx, root, signal) {
  const subagents = subagentsOf(ctx);
  if (subagents === undefined) return [];
  try {
    const rows = await subagents.listDescendants(root.id, signal);
    return rows
      .filter((row) => row.kind === "child" && typeof row.name === "string")
      .map((row) => ({ id: row.id, name: row.name, path: row.path }));
  } catch {
    return [];
  }
}

/** @param {object} target @param {string} label */
function describeTarget(target, label) {
  return label ?? String(target.id);
}

/**
 * Resolve one compaction target from a tool/command request.
 * @param {object} ctx
 * @param {object} caller
 * @param {{ target?: string, session?: string }} request
 * @param {AbortSignal | undefined} signal
 */
async function resolveTarget(ctx, caller, request, signal) {
  const subagents = subagentsOf(ctx);
  let root = caller;
  try {
    root = subagents?.rootOf?.(caller) ?? caller;
  } catch {}
  const isLead = root.id === caller.id;

  if (typeof request.session === "string" && request.session.length > 0) {
    if (!isLead) throw new Error("only the Team Lead may compact an arbitrary session id");
    const agent = ctx.agents.get(request.session);
    if (agent === undefined) throw new Error(`session "${request.session}" is not live`);
    return { agent, label: request.session, isLead };
  }

  const requested = request.target ?? "self";
  if (requested === "self") return { agent: caller, label: isLead ? "lead" : `teammate:${requested}`, isLead };
  if (requested === "lead") return { agent: root, label: "lead", isLead };

  const members = await membersOf(ctx, root, signal);
  const known = members.find((member) => member.name === requested || member.path === requested);
  if (known === undefined) throw new Error(`no Team member named "${requested}"`);
  const live = ctx.agents.get(known.id);
  if (live === undefined) {
    throw new Error(`Team member "${requested}" is not live; send it a message to resume it, then retry`);
  }
  return { agent: live, label: `teammate:${known.name}`, isLead };
}

/** Size accounting that tolerates both pruner result shapes. */
function prunedSize(result) {
  const entries = Array.isArray(result?.entries) ? result.entries : Array.isArray(result?.pruned) ? result.pruned : [];
  let chars = 0;
  for (const entry of entries) {
    if (typeof entry?.charsBefore === "number" && typeof entry?.charsAfter === "number") {
      chars += Math.max(0, entry.charsBefore - entry.charsAfter);
    }
  }
  if (chars === 0 && typeof result?.charsRemoved === "number") chars = result.charsRemoved;
  return { items: entries.length, chars };
}

/**
 * Prune then (optionally) summarize one idle Agent's context.
 * @returns {Promise<object>} the tool value
 */
export async function runCompaction(ctx, caller, request, signal) {
  const mode = request.mode ?? "auto";
  if (mode !== "auto" && mode !== "prune" && mode !== "compact") throw new Error(`unknown mode "${mode}"`);
  const { agent: target, label } = await resolveTarget(ctx, caller, request, signal);
  const targetLabel = describeTarget(target, label);

  const status = target.status;
  if (typeof status === "string" && status !== "idle") {
    throw new Error(`target "${targetLabel}" is ${status}; wait until it is inactive or interrupt it first`);
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
    const pruner = ctx.get?.("toolResultPruner") ?? target.ctx?.get?.("toolResultPruner");
    if (pruner === undefined) {
      value.note = "no tool-result pruner mounted";
    } else {
      try {
        const result = pruner.pruneSession(target.session);
        const size = prunedSize(result);
        value.prunedItems = size.items;
        value.prunedChars = size.chars;
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
    const compaction = ctx.get?.("compaction") ?? target.ctx?.get?.("compaction");
    if (compaction === undefined) {
      value.note = `${value.note ?? ""} no compaction service mounted`.trim();
    } else {
      try {
        const result = await compaction.compactNow(target, signal);
        if (result !== null && result !== undefined) {
          value.compactedTokens =
            integerOrUndefined(result.shadowedTokenCount ?? result.compactedTokens ?? result.tokens) ?? 0;
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
/**
 * Archive or unarchive one teammate session through the Workspace registry.
 * Archiving stops running work; the history stays and the roster may still list it.
 * @returns {Promise<object>} the tool value
 */
export async function setRetired(ctx, caller, target, signal, restore) {
  const subagents = subagentsOf(ctx);
  const registry = ctx.get?.("workspaceRegistry");
  if (subagents === undefined) throw new Error("the subagents service is unavailable");
  if (registry === undefined || typeof registry.archiveSession !== "function") {
    throw new Error("the workspaceRegistry service is unavailable; cannot archive sessions");
  }
  let root = caller;
  try {
    root = subagents.rootOf?.(caller) ?? caller;
  } catch {}
  if (root.id !== caller.id) throw new Error("only the Team Lead may retire or restore teammates");
  const name = String(target ?? "").trim();
  if (name.length === 0) throw new Error("target member name is required");
  const id = await subagents.resolveName(caller, name, signal);
  if (restore) await registry.unarchiveSession(id);
  else await registry.archiveSession(id, { stopActivity: true });
  const archived = Array.isArray(registry.archivedSessionIds) ? registry.archivedSessionIds.includes(id) : undefined;
  return {
    target: name,
    session: String(id),
    retired: restore !== true,
    ...(archived === undefined ? {} : { archived }),
  };
}

/**
 * Register the scoped tool for one Team member and the global human command.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 */
export function apply(ctx) {
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
      return runCompaction(ctx, exec.agent, args ?? {}, exec.signal);
    },
  };

  const RETIRE_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
      target: { type: "string" },
      session: { type: "string" },
      retired: { type: "boolean" },
      archived: { type: "boolean" },
    },
    required: ["target", "session", "retired"],
  };

  const retireTool = {
    name: "retire_teammate",
    description:
      "Retire one teammate: archive its session and stop its running work. Team Lead only. A retired member cannot run again until restored; its history is kept and it may still appear in the roster. Use this to free a teammate slot or stop a runaway member without deleting history.",
    parameters: {
      target: { type: "string", description: "Member name as shown by list_agents." },
    },
    required: ["target"],
    output: {
      schema: RETIRE_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      return setRetired(ctx, exec.agent, args?.target, exec.signal, false);
    },
  };

  const restoreTool = {
    name: "restore_teammate",
    description:
      "Restore one retired teammate: remove its session from the archive set so it can run again. Team Lead only.",
    parameters: {
      target: { type: "string", description: "Member name as shown by list_agents." },
    },
    required: ["target"],
    output: {
      schema: RETIRE_SCHEMA,
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
    },
    execute(args, exec) {
      return setRetired(ctx, exec.agent, args?.target, exec.signal, true);
    },
  };

  /** @type {Map<object, Array<() => void>>} */
  const installed = new Map();
  const tools = [tool, retireTool, restoreTool];
  const maybeInstall = (agent) => {
    if (installed.has(agent)) return;
    if (!inTeam(ctx, agent)) return;
    try {
      installed.set(
        agent,
        tools.map((entry) => agent.ctx.tools.register(entry)),
      );
    } catch (error) {
      ctx.logger?.warn?.(`cannot register the team tools for one member: ${error?.message ?? error}`);
    }
  };
  for (const agent of ctx.agents.list()) maybeInstall(agent);
  ctx.on("agent/created", ({ agent }) => maybeInstall(agent));
  ctx.on("agent/disposed", ({ agent }) => {
    for (const dispose of installed.get(agent) ?? []) dispose();
    installed.delete(agent);
  });
  ctx.effect(
    () => () => {
      for (const disposers of installed.values()) for (const dispose of disposers) dispose();
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
        const value = await runCompaction(ctx, invocation.agent, request, invocation.signal);
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

  const RETIRE_USAGE = "Usage: /team-retire <member-name>";
  ctx.commands.register({
    definitionId: "dsh-team-compact/team-retire",
    name: "team-retire",
    description: "Archive one Team member's session and stop its work (reversible)",
    async handler(invocation) {
      const parts = String(invocation.rawInput ?? "").trim().split(/\s+/).filter((part) => part.length > 0);
      if (parts.length !== 1) return { kind: "error", text: RETIRE_USAGE };
      try {
        const value = await setRetired(ctx, invocation.agent, parts[0], invocation.signal, false);
        return {
          kind: "success",
          text: `retired ${value.target} (session ${value.session}); it cannot run until /team-restore ${value.target}`,
        };
      } catch (error) {
        return { kind: "error", text: String(error?.message ?? error) };
      }
    },
  });

  ctx.commands.register({
    definitionId: "dsh-team-compact/team-restore",
    name: "team-restore",
    description: "Restore one retired Team member",
    async handler(invocation) {
      const parts = String(invocation.rawInput ?? "").trim().split(/\s+/).filter((part) => part.length > 0);
      if (parts.length !== 1) return { kind: "error", text: "Usage: /team-restore <member-name>" };
      try {
        const value = await setRetired(ctx, invocation.agent, parts[0], invocation.signal, true);
        return { kind: "success", text: `restored ${value.target} (session ${value.session})` };
      } catch (error) {
        return { kind: "error", text: String(error?.message ?? error) };
      }
    },
  });
}
