# dsh-team-panel

A richer Agent-Teams panel for the DSH Web GUI. It replaces nothing: it adds a
header action beside the shipped subagent control and a right-hand overlay that
shows **who is on the team, how full each context is, and how the shared tasks
depend on one another** — plus retire/restore per member.

English | [中文](README.zh.md)

## What it adds

| Surface | Content |
|---|---|
| Header action `团队面板 / Team panel` | Member count and open-task count |
| Overlay · Members | One row per teammate: live/idle dot, name, context-occupancy bar with `used / window`, and `打开 / 移除` |
| Overlay · Retired | Members whose session is archived; each row offers `恢复` |
| Overlay · Task dependencies | The shared board drawn as layered columns: one node per task, one elbow edge per `blockedBy`, status colour per node |

Retiring uses the shipped Workspace archive: the session is archived durably,
running work is stopped, and the archived-session gate refuses any further model
step until the member is restored. History is kept — 0.2.2 has no session-delete
API, so archiving is the strongest supported "remove".

## Install

```powershell
# from a checkout of this repository
dsh plugin install D:\path\to\dsh-team-toolkit\packages\team-panel
```

Or through the plugin manager tool:

```
plugin_manager action=install_bundle target="D:\path\to\...\packages\team-panel"
```

The package declares `dsh.bundle.patch` (the Loader row) and
`dsh.client.platform: web` with a `./client` export, so installing it adds both
halves. After installing, **refresh the GUI page** — client bundles load with the
page, not with the Host.

Rollback: `plugin_manager action=remove_bundle target="dsh-team-panel"`, then
refresh the page.

## What it reads (no new model input)

Everything comes from shipped seams:

- `useSessions` — the Session list snapshot, which carries every Session projection; the panel
  reads `subagentCatalog` (the root's direct children and their names), `agentTeam` (the shared
  task board: `tasks[].blockedBy`, `status`, `ownerName`), each member's `contextPressure`,
  and every member's `running` flag from it. `shell.overlay` is root-scoped and gets neither
  `sessionId` nor `useProjection`, so this is the only hook that works there.
- `useWorkspaces` — the registry-global `archivedSessionIds` set
- `ctx.get('uiWorkspace')` — `archiveSession(id, { stopActivity: true })`, `unarchiveSession(id)`, `openSession(id)`

The plugin registers no tool, no prompt section, and no Session event, so a
Session running with it sends a byte-identical model request to one without it.

## 0.1.1: the overlay renders in a root-scoped slot

`shell.overlay` is root-scoped: it receives neither `sessionId` nor `useProjection`. 0.1.0 read the
projections through both and threw `useProjection is not a function` on every frame render, which
took the whole conversation header down with it. 0.1.1 reads every projection through `useSessions`
and takes the addressed Session from a store the header trigger writes, so the panel has no
Session-scoped dependency at all. `verify.mjs` now renders the overlay with root-scope props only and
asserts that the source never calls `useProjection`.

## Verify

```powershell
node verify.mjs
```

40 offline checks against a stubbed browser runtime: slot registration and
ordering, dictionary parity, the closed-panel no-op, one row per member, the
occupied/archived split, occupancy bar levels, the dependency graph's node and
edge counts, deleted-task exclusion, blocked-task marking, trigger counters,
degraded inputs, and the guarantee that retire asks before it acts.

## Files

- `lib/client.js` — the browser half (panel, trigger, graph, stylesheet)
- `lib/index.js` — the Host half (empty: the row exists so the Client bundle is discovered)
- `cordis.patch.yml` — the Loader row
- `verify.mjs` — the offline harness

## Known limitations

- The roster is the root Session's **catalog**, so a member whose session was
  archived outside this panel still lists until the catalog is re-read.
- No rename, no per-member model switch: those belong to the Session, not the panel.
- Archiving is not deletion. Deleting history would need an unsupported write to
  the session directory.
