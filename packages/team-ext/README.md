# dsh-team-ext

Observation-only audit for **DSH Agent Teams**. It records what the session log already knows —
per-request provider usage and every prompt-prefix rewrite — into JSONL, so cache behaviour can be
measured instead of guessed.

It registers **no tool and no prompt section**, so a session running with this plugin sends a
byte-identical model request to one running without it: the observation costs no tokens and cannot
invalidate the provider prefix.

## What it records

One JSON object per line in `cache-events-YYYYMMDD.jsonl`, with `v` (schema version), `t` (epoch ms),
`s` (session id), `r` (role: `lead` / `teammate:<name>` / `sub` / `unknown`) and `k` (record kind).

| `k` | Source event | Key fields | Use |
|---|---|---|---|
| `header` | `request/header` | `series`, `reason`, `tools`, `prov`, `model` | `series: true` is the only signal that the provider prefix was reset |
| `req` | `assistant/message` | `turn`, `step`, `in`, `out`, `cr`, `cw`, `hit`, `denom` | per-request cache hit and usage |
| `warn` | computed | `streak`, `hit` | consecutive low-hit candidate, not a verdict |
| `compact` | `compaction/start\|end\|summary\|prune`, `image/offload` | `ty`, `shadowed`, `start`, `end` | prefix-rewrite evidence and size |
| `tcall` | `tool/call` | `name`, `call`, `args` | tool calls and argument size |
| `tres` | `tool/result` | `call`, `chars`, `blocks`, `err` | find outputs over the 8192-char prune threshold |
| `team` | `team/member`, `team/task` | `name`, `status`, `id`, `rev` | coordination state changes, to align with polling |

`in`/`out`/`cr`/`cw` are the provider's raw fields (input / output / cache read / cache write) and
are not normalised. `denom = in + cr + cw` and `hit = cr / denom` are an explicit estimate; the
analysis script prints the raw sums so a different denominator can be recomputed.

## Configuration

The `team-ext` row in `cordis.patch.yml`:

| Field | Default | Meaning |
|---|---|---|
| `logDir` | empty (`~/.dsh/team-ext`) | JSONL directory |
| `enabled` | `true` | disable to unsubscribe and write nothing |
| `recordToolResults` | `true` | record `tres` (size only, never content) |
| `warnHitRateBelow` | `0.5` | low-hit threshold |
| `warnConsecutive` | `3` | consecutive low requests before a `warn` record |
| `flushMs` | `2000` | in-memory buffer flush interval |

## Analysis

```powershell
python analyze_cache_log.py [LOG_DIR] [--out OUT_DIR]
```

Prints a report (weighted hit rate, per session, prefix-rewrite events, tool-result size Top10,
worst turns) and writes `analysis/summary_by_session.csv`, `tools.csv`, `turns.csv`.

Reading notes:

- **Hit-rate denominator** = `in + cr + cw`. The DeepSeek adapter reports `inputTokens` without the
  cached part; OpenAI-compatible adapters may include it. Raw fields are recorded so the denominator
  can be changed.
- **Missing `cr` is not zero.** A provider that omits the field yields `null` and counts as
  `no_usage`; do not read it as a miss.
- Only `series` resets, `compact/summary` and `compact/prune` rewrite the prefix. Appended peer
  messages, time snapshots and runtime context do not.

## Install

See the [repository README](../../README.md). Point `plugin_manager install_bundle` at this
directory. Rollback: `plugin_manager action=remove_bundle target="dsh-team-ext"`.

## Verification

```powershell
node verify.mjs        # 46 checks: record reduction
node verify_host.mjs   # 14 checks: Host half against a fake Cordis context
```

## Files

| File | Role |
|---|---|
| `index.js` | Host half: Cordis subscription, role resolution, buffered writes |
| `core.mjs` | pure event reduction (offline-testable) |
| `package.json` | bundle manifest (`dsh.bundle.patch`) |
| `cordis.patch.yml` | one composition insert plus configuration |
| `verify.mjs`, `verify_host.mjs` | offline verification |
| `analyze_cache_log.py` | JSONL → report + CSV |
