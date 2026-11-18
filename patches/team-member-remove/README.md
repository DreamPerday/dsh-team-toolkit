# team-member-remove (in-place patch)

Adds a Lead-only **`remove_teammate`** tool and a terminal `removed` member phase to the shipped
Agent Teams packages.

```
remove_teammate({ target })        // Lead only
→ { removed: true, target, previousStatus }
```

Effect:

- a running teammate's current turn is interrupted and its activation released;
- the member disappears from `list_agents` and from the roster projection;
- its **name becomes available again** and it no longer counts toward the member limit;
- its saved conversation stays on disk (`~/.dsh/sessions/<id>`) — nothing is deleted from history;
- removing an already-removed or unknown target reports `TEAM_MEMBER_NOT_FOUND` (idempotent replay
  returns `previousStatus: "inactive"`).

Member phase transitions become:

```
provisioning -> active | failed | removed
active       -> removed
failed       -> removed
removed      -> (terminal)
```

## Why this is a patch and not a plugin

The roster is a projection of the Lead's session journal. Member phases, transition validation, the
name-uniqueness rule, the member limit and the spawn/settle path are all private to
`@deepseek-ai/dsh-experimental-agent-team`; the public service has no removal method and no
extension point. A Cordis plugin can add tools but cannot mutate the roster, so the phase, the
projection rules and the service method are edited in place.

## Target version

DSH Desktop **0.2.1-rc.2** bundles (`@deepseek-ai/dsh-experimental-agent-team`,
`@deepseek-ai/dsh-experimental-tool-agent-team`). Every anchor is asserted to exist exactly once; a
layout change fails loudly instead of writing a half-patch. This patch is independent of
[`team-model-selection`](../team-model-selection/README.md) and can be applied before or after it.

## Apply

```powershell
$env:DSH_APP_DIR = "<DSH Desktop>\resources\app"
node apply_patch.mjs --check     # { applied, team, tool } digests
node apply_patch.mjs             # writes both bundles, backs up originals, writes manifest.json
```

Backups and the manifest go to `.backups/` (git-ignored) unless `DSH_PATCH_BACKUP_DIR` points
elsewhere. **Restart DSH Desktop** afterwards: the running process holds the old module.

## Verify

```powershell
node verify.mjs
```

Covers: both bundles import, `TeamService.removeTeammate` exists, both member phase enums accept
`removed`, the transition table is terminal, the roster list/name/slot/live-children rules ignore
removed members, the spawn settle path guards a concurrent removal, the removal event carries the
terminal phase, and the tool bundle registers `remove_teammate` with its value schema and policy
text.

## Rollback

```powershell
copy .backups\originals\agent-team.index.js       <app>\node_modules\@deepseek-ai\dsh-experimental-agent-team\lib\index.js
copy .backups\originals\tool-agent-team.index.js  <app>\node_modules\@deepseek-ai\dsh-experimental-tool-agent-team\lib\index.js
```

Then restart DSH Desktop.

## Known limits

- The removal event stays in the session journal (append-only); it is not a history delete.
- A removed teammate's session file can still be opened and inspected; only the roster entry is gone.
- A teammate cannot remove itself or another member, and the Lead cannot be removed.
- Removing a member that is still `provisioning` is allowed; the spawn path then fails with
  `TEAM_PROVISIONING_CONFLICT` instead of reporting a created member.
