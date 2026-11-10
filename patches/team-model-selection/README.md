# team-model-selection (in-place patch)

Adds three optional fields to the shipped `spawn_teammate` tool so the Team Lead can pin each
teammate to a different LLM route:

```js
spawn_teammate({
  name, description, prompt, context?,          // unchanged
  provider?, model?, reasoning_effort?          // new, optional
})
```

- all three omitted → the child inherits the Lead route, exactly as before;
- `provider` + `model` given → the child runs on that route; `reasoning_effort` omitted uses the
  model's default;
- only one of `provider` / `model` → the call fails before any child is created;
- an unknown provider, or a model/effort the adapter rejects, fails before creation;
- the route is persisted on the Team member record (`agentOptions`), so cold recovery re-materializes
  the same route and reports a mismatch instead of silently switching models;
- `list_agents` keeps showing the requested model for inactive or failed teammates.

## Why this is a patch and not a plugin

The feature changes an existing tool's schema **and** the team service's spawn, persistence, and
provisioning-recovery path. The experimental Agent Teams packages expose no extension point for
either, so an additive Cordis plugin cannot implement it. The patch edits the two installed bundle
files in place.

## Target version

DSH Desktop **0.2.1-rc.2** (bundles: `@deepseek-ai/dsh-experimental-agent-team`,
`@deepseek-ai/dsh-experimental-tool-agent-team`). Every anchor is asserted to exist exactly once; a
layout change fails loudly instead of writing a half-patch.

## Apply

```powershell
$env:DSH_APP_DIR = "C:\Program Files\DSH Desktop\resources\app"   # your install path
node apply_patch.mjs --check     # reports { applied, team, tool } digests
node apply_patch.mjs             # writes the patch, backs up originals, writes manifest.json
```

Backups and the manifest go to `patches/team-model-selection/.backups/` (git-ignored) unless
`DSH_PATCH_BACKUP_DIR` points elsewhere.

**Restart DSH Desktop** (or boot a fresh CLI process) after applying: the running process holds the
old code.

## Verify

```powershell
node verify.mjs
```

Covers: both patched bundles import, the exported route normalizer enforces the provider/model
contract, the real `spawn_teammate` definition exposes the new fields and forwards a validated route
as child `agentOptions`, omitting it preserves the old request shape, and the durable/provisioning
call sites are gated on the stored route.

## Rollback

```powershell
copy .backups\originals\agent-team.index.js       <app>\node_modules\@deepseek-ai\dsh-experimental-agent-team\lib\index.js
copy .backups\originals\tool-agent-team.index.js  <app>\node_modules\@deepseek-ai\dsh-experimental-tool-agent-team\lib\index.js
```

Then restart DSH Desktop.

## After a DSH update

The installer replaces `resources/app`, so the patch is lost. Re-run `apply_patch.mjs --check`; if
the layout is unchanged it re-applies; if the version moved, the anchors fail and the patch needs to
be ported.

## Known limits

- Version-pinned to 0.2.1-rc.2 bundle layout; not a supported upstream feature.
- `fork` children still inherit the Lead's conversation prefix, so switching the route can prevent
  provider-side prefix-cache reuse (same caveat as the built-in `subagent` model selection).
- No settings-page whitelist: any registered provider/model the adapter can resolve is accepted.
