/**
 * dsh-team-effort — keep a chosen reasoning effort on delegated children.
 *
 * The shipped runtime drops the parent's effort as soon as a child switches
 * route. `resolveChildAgentOptions` does this deliberately:
 *
 *     const routeChanged = resolved.provider !== parentProvider
 *                        || resolved.model !== parentModel
 *     if (routeChanged && requested?.reasoningEffort === undefined)
 *       delete resolved.reasoningEffort
 *
 * So a caller that only names `provider` and `model` — the `workflow` tool's
 * `agent({ provider, model })` is exactly that, and the `agent()` option set is
 * a closed list of `label, phase, schema, provider, model` — always lands on
 * the target model's default strength. Nothing in the tool surface can ask for
 * `xhigh` there.
 *
 * This plugin bridges that gap at the one seam every caller shares:
 * `ctx.subagents.startActivation()`. When a spec carries a provider/model pair
 * and no effort, the configured effort is validated against the model's own
 * reasoning metadata and stamped into the spec, so the runtime's
 * `requested.reasoningEffort !== undefined` branch keeps it.
 *
 * It composes nothing, registers no tool and no prompt section, and writes no
 * Session event: a Session running with it sends the same request as one
 * without it unless a delegation actually asks for a route.
 */

/** Cordis plugin name used by Loader diagnostics. */
export const name = "team-effort";

/** `subagents` owns the one seam this plugin bridges; `llm` is read lazily. */
export const inject = ["subagents"];

/** Defaults mirrored by the patch file; every field is validated in `resolveConfig`. */
const DEFAULTS = Object.freeze({
  enabled: true,
  effort: "xhigh",
  fallbackToDefault: true,
  trustWithoutValidation: false,
});

/** Marks a service object this plugin already bridged, so a reload cannot stack wrappers. */
const BRIDGED = Symbol.for("dsh-team-effort.bridged");

/**
 * Validate the Loader-supplied configuration. The plugin exports no `Config`
 * schema, so Cordis passes the raw object through and this function is the only
 * guard.
 * @param {Record<string, unknown>} raw
 */
export function resolveConfig(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("team-effort: config must be an object");
  }
  const allowed = new Set(Object.keys(DEFAULTS));
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new TypeError(`team-effort: unknown config key "${key}" (allowed: ${[...allowed].join(", ")})`);
    }
  }
  const merged = { ...DEFAULTS, ...raw };
  if (typeof merged.enabled !== "boolean") throw new TypeError("team-effort: enabled must be a boolean");
  if (typeof merged.effort !== "string") throw new TypeError("team-effort: effort must be a string");
  if (typeof merged.fallbackToDefault !== "boolean") {
    throw new TypeError("team-effort: fallbackToDefault must be a boolean");
  }
  if (typeof merged.trustWithoutValidation !== "boolean") {
    throw new TypeError("team-effort: trustWithoutValidation must be a boolean");
  }
  if (merged.enabled && merged.effort.trim().length === 0) {
    throw new TypeError("team-effort: effort must be a non-empty reasoning effort id when enabled");
  }
  return { ...merged, effort: merged.effort.trim() };
}

/**
 * Pick the one effort to stamp for a route.
 *
 * The model's own metadata is the authority: an effort the adapter does not
 * advertise would be rejected by `resolveCallConfig` on the child's first
 * request, so it is never stamped blindly. When the configured effort is
 * missing, the model's declared default is used, and when nothing is known the
 * spec is left alone so the adapter keeps owning the decision.
 *
 * @param {object} ctx
 * @param {{ effort: string, fallbackToDefault: boolean, trustWithoutValidation: boolean }} settings
 * @param {string} provider
 * @param {string} model
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<{ effort?: string, reason: string }>}
 */
export async function chooseEffort(ctx, settings, provider, model, signal) {
  const llm = typeof ctx.get === "function" ? ctx.get("llm") : undefined;
  if (llm === undefined || typeof llm.resolveModelInfo !== "function") {
    return settings.trustWithoutValidation
      ? { effort: settings.effort, reason: "llm-unavailable-trusted" }
      : { reason: "llm-unavailable" };
  }
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, signal);
  } catch {
    return settings.trustWithoutValidation
      ? { effort: settings.effort, reason: "model-info-failed-trusted" }
      : { reason: "model-info-failed" };
  }
  const reasoning = info?.reasoning;
  if (reasoning === undefined || reasoning === null) return { reason: "model-has-no-reasoning" };
  const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : [];
  const ids = efforts
    .map((entry) => (typeof entry === "string" ? entry : entry?.id))
    .filter((id) => typeof id === "string");
  if (ids.includes(settings.effort)) return { effort: settings.effort, reason: "configured-supported" };
  const fallback = typeof reasoning.defaultEffort === "string" ? reasoning.defaultEffort : undefined;
  if (settings.fallbackToDefault && fallback !== undefined && ids.includes(fallback)) {
    return { effort: fallback, reason: `configured-unsupported-fell-back-to-${fallback}` };
  }
  return { reason: "configured-unsupported" };
}

/**
 * The spec a delegation actually runs with.
 *
 * Only a route switch is touched: without `agentOptions` the runtime already
 * inherits the parent's effort, and with an explicit `reasoningEffort` the
 * caller has spoken. Everything else returns the original spec unchanged.
 *
 * @param {object} ctx
 * @param {object} settings
 * @param {object} spec
 * @param {(event: object) => void} [report]
 * @returns {Promise<object>}
 */
export async function withEffort(ctx, settings, spec, report) {
  if (spec === null || typeof spec !== "object") return spec;
  const options = spec.agentOptions;
  if (options === null || typeof options !== "object") return spec;
  if (typeof options.provider !== "string" || typeof options.model !== "string") return spec;
  if (options.reasoningEffort !== undefined) return spec;
  const chosen = await chooseEffort(ctx, settings, options.provider, options.model, spec.signal);
  if (chosen.effort === undefined) {
    report?.({ kind: "skipped", provider: options.provider, model: options.model, reason: chosen.reason });
    return spec;
  }
  report?.({ kind: "stamped", provider: options.provider, model: options.model, effort: chosen.effort, reason: chosen.reason });
  return { ...spec, agentOptions: { ...options, reasoningEffort: chosen.effort } };
}

/**
 * Bridge `startActivation` for the life of this plugin.
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 * @returns {(() => void) | undefined} the restore callback, when bridged
 */
export function apply(ctx, rawConfig) {
  const settings = resolveConfig(rawConfig ?? {});
  if (!settings.enabled) {
    ctx.logger?.info?.("team-effort: disabled by config");
    return undefined;
  }
  const subagents = ctx.subagents;
  if (subagents === undefined || typeof subagents.startActivation !== "function") {
    throw new TypeError("team-effort: the subagents service does not expose startActivation");
  }
  if (subagents[BRIDGED] !== undefined) {
    ctx.logger?.warn?.("team-effort: startActivation is already bridged in this composition");
    return;
  }

  const original = subagents.startActivation;
  /** One diagnostic line per route keeps the log readable across a long run. */
  const reported = new Set();
  const report = (event) => {
    const key = `${event.provider}:${event.model}:${event.kind}:${event.reason}`;
    if (reported.has(key)) return;
    reported.add(key);
    ctx.logger?.info?.(
      `team-effort: ${event.kind} ${event.provider}/${event.model}${event.effort === undefined ? "" : ` -> ${event.effort}`} (${event.reason})`,
    );
  };

  const bridged = async function startActivation(spec, ...rest) {
    const next = await withEffort(ctx, settings, spec, report);
    return Reflect.apply(original, this, [next, ...rest]);
  };

  Object.defineProperty(subagents, "startActivation", {
    value: bridged,
    configurable: true,
    writable: true,
    enumerable: false,
  });
  subagents[BRIDGED] = true;

  const dispose = ctx.effect(
    () => () => {
      delete subagents[BRIDGED];
      // Dropping the own property restores the prototype method untouched.
      delete subagents.startActivation;
    },
    "team-effort: startActivation bridge",
  );
  return typeof dispose === "function" ? dispose : undefined;
}
