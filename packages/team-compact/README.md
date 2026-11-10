# dsh-team-compact

Manual context compaction for **DSH Agent Teams**. Adds two manual entry points on top of the
shipped `compaction` service without editing any official package:

| Entry point | Who can use it | What it does |
|---|---|---|
| tool `compact_context` | the Lead and every teammate (registered per member scope, so new teammates get it automatically) | prune and/or summarize a chosen member's context |
| command `/compact-agent` | any session (human input) | same, by member name, `self`, or session id |

Both only call public services:

- `toolResultPruner.pruneSession(session)` — rule-based pruning of oversized tool results, no model call;
- `compaction.compactNow(agent, signal)` — the official manual compaction, which calls the summarizer.

Every effect is therefore replayable through the shipped plugins; this package writes no private
session events.

## Parameters

```
compact_context({ target?, session?, mode? })
```

| Field | Meaning |
|---|---|
| `target` | member name, `lead`, or `self` (default `self`) |
| `session` | exact **live** session id; Lead only, overrides `target` |
| `mode` | `auto` (default): prune, then summarize only when the estimate is near the model window; `prune`: prune only; `compact`: summarize only |

Returns `{target, mode, before, after, window?, prunedItems, prunedChars, compactedTokens?, compactionError?, note?}`.
`before`/`after` are token-meter estimates (the shipped `chars/4` heuristic), not provider-exact counts.

Command:

```
/compact-agent <member-name|session-id|self> [auto|prune|compact]
```

## Hard constraints (from the official services, not from this plugin)

1. **The target must be idle.** `compactNow` reserves the agent's next-turn admission and refuses
   while a turn is open or work is queued (reported as `busy`). Interrupt the target or wait until
   it is inactive.
2. **Only the Lead may target an arbitrary session id.** A teammate can compact itself.
3. **A session already beyond its model window cannot be compacted.** `compactNow` summarizes the
   whole compactable range (everything except the system head); there is no public API to compact
   a bounded sub-range. If the session's real context is larger than the model window, the
   summarizer request itself overflows and the tool reports `compactionError: "summary"`. Rescue
   requires a larger-window summarization route, a bounded-range patch, or rebuilding the session.

## Install

See the [repository README](../../README.md). Point `plugin_manager install_bundle` at this
directory. Restart DSH Desktop if your profile does not reload plugin modules.

Rollback: `plugin_manager action=remove_bundle target="dsh-team-compact"`.

## Verification

```powershell
node verify.mjs
```

25 offline checks against a fake Cordis context: per-member tool registration, new members getting
the tool on `agent/created`, non-members getting nothing, the three modes, the idle guard, the
Lead-only session-id rule, summary failures reported as `compactionError`, and the command's usage
and success paths.

## Files

| File | Role |
|---|---|
| `index.js` | plugin implementation (zero external imports; only Host public services) |
| `package.json` | bundle manifest (`dsh.bundle.patch`) |
| `cordis.patch.yml` | one composition insert |
| `verify.mjs` | offline verification |
