# dsh-team-effort

Keep a chosen reasoning effort on delegated children.

English | [中文](README.zh.md)

## The problem it fixes

DSH drops the parent's reasoning effort the moment a delegation switches route.
`resolveChildAgentOptions` does that on purpose:

```js
const routeChanged = resolved.provider !== parentProvider || resolved.model !== parentModel
if (routeChanged && requested?.reasoningEffort === undefined)
  delete resolved.reasoningEffort
```

Any caller that names only `provider` and `model` therefore lands on the target
model's **default** strength. The `workflow` tool is exactly such a caller: its
`agent()` option set is a closed list of `label, phase, schema, provider, model`
and `effort` is rejected outright —

```
agent() option "effort" is deferred and not supported by this engine
(supported: label, phase, schema, provider, model)
```

So from a script there is no way to ask for `xhigh`; the GUI model selector is
the only place the strength can be chosen. This plugin restores the missing half.

## What it does

It wraps the one seam every delegation shares — `ctx.subagents.startActivation()`
— and, only when a spec carries a provider/model pair with no effort, stamps the
configured effort into `spec.agentOptions.reasoningEffort`. The shipped runtime
then keeps it, because its `requested.reasoningEffort !== undefined` branch no
longer fires.

The effort is validated against the target model's own reasoning metadata before
it is stamped, so the plugin can never hand a child an effort its adapter would
reject on the first request:

| Situation | Behaviour |
|---|---|
| Configured effort is advertised by the model | stamped |
| Configured effort is not advertised | falls back to the model's `defaultEffort` (disable with `fallbackToDefault: false`) |
| Model declares no reasoning metadata | spec left untouched |
| `llm` service unavailable or metadata lookup fails | spec left untouched |
| Spec already carries `reasoningEffort` | untouched — the caller has spoken |
| Spec has no `agentOptions` | untouched — the runtime already inherits the parent's effort |

## Install

```powershell
plugin_manager action=install_bundle target="D:\path\to\dsh-team-toolkit\packages\team-effort"
```

Restart DSH once: this is a Host module, and the running process caches loaded
modules. Config-only changes on the row hot-reload.

Rollback: `plugin_manager action=remove_bundle target="dsh-team-effort"`, then
restart.

## Configuration

```yaml
- id: team-effort
  name: 'dsh-team-effort'
  config:
    enabled: true
    effort: xhigh
    fallbackToDefault: true
    trustWithoutValidation: false
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Turn the bridge off without uninstalling |
| `effort` | `xhigh` | Reasoning effort id to keep on a route-switching child |
| `fallbackToDefault` | `true` | Use the model's `defaultEffort` when the configured id is not advertised |
| `trustWithoutValidation` | `false` | Stamp without consulting model metadata (escape hatch; an unsupported id then fails on the child's first request) |

## Model surface

None. The plugin registers no tool, adds no prompt section, and writes no
Session event. A Session with it sends a byte-identical request to one without
it until a delegation actually names a route — at which point the child's own
request carries the effort that was previously lost.

## Verify

```powershell
node verify.mjs
```

36 offline checks against a fake Cordis Context, a fake `subagents` service with
a prototype `startActivation`, and a fake `llm`: configuration validation,
effort selection (kept / fallback / untouched paths), spec rewriting that never
mutates the caller's object and never overrides an explicit effort, the bridge's
end-to-end behaviour, single-line diagnostics per route, refusal to stack a
second bridge, and disposal restoring the original prototype method.

## Files

- `index.js` — the plugin (config guard, effort selection, bridge)
- `cordis.patch.yml` — the Loader row and its default config
- `verify.mjs` — the offline harness

## Known limitations

- The bridge is an own property on the live service object; a composition that
  replaces that object after activation would drop it.
- Effort inheritance is still the shipped runtime's business when the child does
  not switch route. This plugin deliberately does not interfere there.
- `trustWithoutValidation: true` can produce a child that fails on its first
  request; the default validates first.
