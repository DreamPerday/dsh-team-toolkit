/**
 * Host half of `dsh-team-panel`.
 *
 * The panel is pure Client UI: it reads the shipped projections
 * (`agentTeam`, `subagentCatalog`, `contextPressure`) and calls the shipped
 * Client services (`uiWorkspace.archiveSession` / `unarchiveSession`). This
 * half exists so the Loader owns a row: the browser bundle is discovered from
 * that row's package (`dsh.client.platform: web` plus the `./client` export),
 * so disabling the row removes the panel.
 *
 * It registers no tool, no prompt section, and no Session event, so a Session
 * with this plugin sends a byte-identical model request to one without it.
 */

/** Cordis plugin name used by Loader diagnostics. */
export const name = "team-panel";

/** Nothing to inject: the panel never runs Host code. */
export function apply() {}
