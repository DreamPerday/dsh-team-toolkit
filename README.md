# dsh-team-toolkit

Four small, additive plugins for **DSH Agent Teams** ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)).
None of them edits a shipped package. The first adds a tool and a command; the other two add
no model-visible input at all.

| Package | What it does | Model surface |
|---|---|---|
| [`packages/team-compact`](packages/team-compact/README.md) | Manual context compaction for the Lead and every teammate: a scoped `compact_context` tool plus the `/compact-agent` command. | Adds one tool + one human command |
| [`packages/team-ext`](packages/team-ext/README.md) | Observation-only audit: records per-request cache usage and every prompt-prefix rewrite (compaction, prune, series reset) to JSONL, with an analysis script. | Adds no tool and no prompt section |
| [`packages/team-panel`](packages/team-panel/README.md) | Web GUI panel: member roster with a context-occupancy bar each, retire/restore backed by the Workspace archive, and the shared-task dependency graph. | Adds no tool and no prompt section |
| [`packages/team-effort`](packages/team-effort/README.md) | Keeps a chosen reasoning effort on a delegation that switches provider/model, which the shipped runtime would otherwise reset to the target model default. | Adds no tool and no prompt section |

Both are Cordis bundles (`dsh.bundle` manifest) and install into a DSH profile without touching
`resources/app`.

## Install

Requirements: DSH Desktop with Agent Teams available. On 0.2.2 that ships in the base
bundle: a Team is the subagent tree of one root Session, and the per-Session switch is
**Enable agent teamwork** in the model menu (or `defaultEnabled: true` on the `agent-team` row).

From a local clone (recommended while the packages are not in a registry):

```powershell
git clone https://github.com/DreamPerday/dsh-team-toolkit.git
# in DSH: ask the agent, or call the plugin manager, with the absolute package directory
plugin_manager action=install_bundle target="<clone>\packages\team-compact"
plugin_manager action=install_bundle target="<clone>\packages\team-ext"
plugin_manager action=install_bundle target="<clone>\packages\team-panel"
plugin_manager action=install_bundle target="<clone>\packages\team-effort"
```

Both packages are `link`-installed, so the clone must stay where it is. Restart DSH Desktop after
the first install if your profile does not hot-reload plugin modules (host plugin code is cached
by the running process; config changes hot-reload, module changes need a restart).

Remove with:

```text
plugin_manager action=remove_bundle target="dsh-team-compact"
plugin_manager action=remove_bundle target="dsh-team-ext"
plugin_manager action=remove_bundle target="dsh-team-panel"
plugin_manager action=remove_bundle target="dsh-team-effort"
```

## Why these exist

While running a real multi-agent workload on DSH 0.2.1, every teammate compaction failed with a
`400` because auxiliary LLM calls without an explicit reasoning effort fell through to
`reasoning.effort: "none"` on an OpenAI-compatible reasoning model. The audit plugin exists to make
that class of failure visible (per-request cache fields plus prefix-rewrite events), and the
compact plugin exists because the official compaction seam only compacts the whole compactable
range, so a manual, targetable entry point is useful when an agent's context has grown large.

## Patches (not plugins)

[`patches/team-model-selection`](patches/team-model-selection/README.md) — an in-place patch for DSH
Desktop 0.2.1-rc.2 that adds optional `provider` / `model` / `reasoning_effort` to `spawn_teammate`,
so the Lead can pin each teammate to a different LLM route.

[`patches/team-member-remove`](patches/team-member-remove/README.md) — adds a terminal `removed`
member phase, a Lead-only `remove_teammate` tool and the `/team-remove` command: the teammate is
interrupted, released, hidden from `list_agents` and the Web panel, its name and member slot are
freed, and its saved conversation is deleted. The roster is journal-projected and private, so this
also has to be an in-place patch.

[`patches/team-panel-remove`](patches/team-panel-remove/README.md) — a client-bundle patch that adds
a × control to each non-Lead row of the Web member panel; it runs `/team-remove` through the client
Remote command channel.

The patches are version-pinned, fail loudly on anchor mismatch, and must be re-applied after a DSH
update.

## Compatibility

Written against DSH `0.2.1-rc.2` host services (`agents`, `commands`, `agentTeams`,
`tokenMeter`, `compaction`, `toolResultPruner`). The experimental Agent Teams packages are
explicitly unstable upstream; check the two package READMEs for the exact services they use.

## License

MIT
