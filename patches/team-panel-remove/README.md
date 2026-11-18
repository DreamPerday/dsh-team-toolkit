# team-panel-remove (in-place client patch)

Adds a small **× control** to every non-Lead row of the Web Agent Teams member panel. Clicking it
runs the host command `/team-remove <name>` through the client Remote command channel:

- the member is removed from the roster (hidden from the panel and `list_agents`);
- its saved session directory is deleted;
- the Lead and the current session row never show the control.

Requires [`team-member-remove`](../team-member-remove/README.md) on the host (the roster phase and
the `remove_teammate` service method) plus the **dsh-team-compact** plugin (registers
`/team-remove`).

## Why this is a patch and not a plugin

The panel is a shipped browser bundle (`@deepseek-ai/dsh-experimental-client-ui-agent-team`) that
renders the Lead Session's `agentTeam` projection. The package README states the panel deliberately
has **no lifecycle control**; there is no slot or extension point for a per-row action, so the row
markup and the injected action map are edited in place.

## Target version

DSH Desktop **2.0.18** / core `0.2.1-rc.2` client bundle. Anchors are asserted exactly; a layout
change fails loudly.

## Apply

```powershell
$env:DSH_APP_DIR = "<DSH Desktop>\resources\app"
node apply_patch.mjs --check
node apply_patch.mjs
```

**Refresh the Web UI page** afterwards (the bundle is served from disk; no app restart needed for
the client half).

## Rollback

Restore `.backups\originals\client-ui-agent-team.client.js` over the bundle and refresh the page.

## Known limits

- The control is a `<span role="button">` positioned over the row card (the row itself is a
  `<button>`, so a nested button would be invalid); it stops click propagation.
- If the host command channel is unavailable, the panel shows the error inline and nothing changes.
- The confirmation-free control deletes the conversation; that is intentional for this workflow.
