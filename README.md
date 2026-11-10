# dsh-team-toolkit

Two small, additive plugins for **DSH Agent Teams** ([DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)).
Neither plugin edits a shipped package, and neither changes the model-visible request unless
you explicitly call its tool.

| Package | What it does | Model surface |
|---|---|---|
| [`packages/team-compact`](packages/team-compact/README.md) | Manual context compaction for the Lead and every teammate: a scoped `compact_context` tool plus the `/compact-agent` command. | Adds one tool + one human command |
| [`packages/team-ext`](packages/team-ext/README.md) | Observation-only audit: records per-request cache usage and every prompt-prefix rewrite (compaction, prune, series reset) to JSONL, with an analysis script. | Adds no tool and no prompt section |

Both are Cordis bundles (`dsh.bundle` manifest) and install into a DSH profile without touching
`resources/app`.

## Install

Requirements: DSH Desktop with the experimental Agent Teams profile
(`@deepseek-ai/dsh-experimental-agent-team-profile`), i.e. the Lead gets `spawn_teammate` and
teammates exist.

From a local clone (recommended while the packages are not in a registry):

```powershell
git clone https://github.com/DreamPerday/dsh-team-toolkit.git
# in DSH: ask the agent, or call the plugin manager, with the absolute package directory
plugin_manager action=install_bundle target="<clone>\packages\team-compact"
plugin_manager action=install_bundle target="<clone>\packages\team-ext"
```

Both packages are `link`-installed, so the clone must stay where it is. Restart DSH Desktop after
the first install if your profile does not hot-reload plugin modules (host plugin code is cached
by the running process; config changes hot-reload, module changes need a restart).

Remove with:

```text
plugin_manager action=remove_bundle target="dsh-team-compact"
plugin_manager action=remove_bundle target="dsh-team-ext"
```

## Why these exist

While running a real multi-agent workload on DSH 0.2.1, every teammate compaction failed with a
`400` because auxiliary LLM calls without an explicit reasoning effort fell through to
`reasoning.effort: "none"` on an OpenAI-compatible reasoning model. The audit plugin exists to make
that class of failure visible (per-request cache fields plus prefix-rewrite events), and the
compact plugin exists because the official compaction seam only compacts the whole compactable
range, so a manual, targetable entry point is useful when an agent's context has grown large.

## Compatibility

Written against DSH `0.2.1-rc.2` host services (`agents`, `commands`, `agentTeams`,
`tokenMeter`, `compaction`, `toolResultPruner`). The experimental Agent Teams packages are
explicitly unstable upstream; check the two package READMEs for the exact services they use.

## License

MIT
