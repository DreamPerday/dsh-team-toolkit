#!/usr/bin/env python
"""Summarize the P0 team cache/prefix audit JSONL.

The plugin `dsh-team-ext` appends one JSON object per line to
`cache-events-YYYYMMDD.jsonl`. This script turns that stream into the three
questions the convention document asks for:

1. Where did the request prefix actually reset?  (`header.series`, compaction,
   prune, image offload)
2. How much of the traffic is cacheable, and what is the weighted hit rate?
3. How much of the traffic is coordination polling rather than work?

Denominator note: adapters disagree on whether `inputTokens` already contains the
cached part, so this script reports the hit rate against
`in + cr + cw` (the same explicit estimate the plugin records as `denom`) and
also prints the raw sums, so a different denominator can be recomputed by hand.

Usage:
    python analyze_cache_log.py [LOG_DIR] [--out OUT_DIR]

Defaults: LOG_DIR = the project output directory configured in cordis.patch.yml,
OUT_DIR = LOG_DIR/analysis.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

DEFAULT_LOG_DIR = Path.home() / ".dsh" / "team-ext"

TEAM_TOOL_NAMES = {
    "spawn_teammate",
    "send_message",
    "list_agents",
    "wait_agent",
    "interrupt_agent",
    "team_task_create",
    "team_task_list",
    "team_task_get",
    "team_task_update",
}


def load_records(log_dir: Path) -> list[dict]:
    """Read every cache-events-*.jsonl under `log_dir`, skipping unreadable lines."""
    files = sorted(log_dir.glob("cache-events-*.jsonl"))
    if not files:
        raise SystemExit(f"no cache-events-*.jsonl under {log_dir}")
    records: list[dict] = []
    for path in files:
        # utf-8-sig tolerates a BOM left by PowerShell `Set-Content -Encoding UTF8`
        # or by an editor, which would otherwise hide the first record.
        with path.open("r", encoding="utf-8-sig") as handle:
            for line_number, line in enumerate(handle, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    print(f"warn: {path.name}:{line_number} is not JSON; skipped", file=sys.stderr)
                    continue
                if isinstance(record, dict):
                    records.append(record)
    return records


def int_or_zero(value) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def weighted_hit(records: list[dict]) -> tuple[int, int, int]:
    """Return (cache_read, denominator, requests_without_usage)."""
    cache_read = 0
    denominator = 0
    missing = 0
    for record in records:
        denom = record.get("denom")
        if not isinstance(denom, int) or denom <= 0:
            missing += 1
            continue
        cache_read += int_or_zero(record.get("cr"))
        denominator += denom
    return cache_read, denominator, missing


def percentile(values: list[int], fraction: float) -> int:
    if not values:
        return 0
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round(fraction * (len(ordered) - 1)))))
    return ordered[index]


def summarize(records: list[dict]) -> dict:
    by_session: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        by_session[str(record.get("s", "?"))].append(record)

    sessions: list[dict] = []
    for session_id, session_records in sorted(by_session.items()):
        requests = [r for r in session_records if r.get("k") == "req"]
        headers = [r for r in session_records if r.get("k") == "header"]
        compactions = [r for r in session_records if r.get("k") == "compact"]
        tool_calls = [r for r in session_records if r.get("k") == "tcall"]
        tool_results = [r for r in session_records if r.get("k") == "tres"]
        cache_read, denominator, missing = weighted_hit(requests)
        result_chars = [int_or_zero(r.get("chars")) for r in tool_results]
        team_calls = [r for r in tool_calls if r.get("name") in TEAM_TOOL_NAMES]
        sessions.append(
            {
                "session": session_id,
                "role": next((r.get("r") for r in session_records if r.get("r")), "unknown"),
                "requests": len(requests),
                "no_usage": missing,
                "cache_read": cache_read,
                "denominator": denominator,
                "hit": (cache_read / denominator) if denominator else None,
                "series_resets": sum(1 for r in headers if r.get("series") is True),
                "compactions": sum(1 for r in compactions if r.get("ty") == "summary"),
                "prunes": sum(1 for r in compactions if r.get("ty") == "prune"),
                "prune_tokens": sum(int_or_zero(r.get("shadowed")) for r in compactions if r.get("ty") == "prune"),
                "tool_calls": len(tool_calls),
                "team_tool_calls": len(team_calls),
                "tool_result_chars": sum(result_chars),
                "tool_result_p95": percentile(result_chars, 0.95),
                "warnings": sum(1 for r in session_records if r.get("k") == "warn"),
            }
        )

    tool_chars: Counter[str] = Counter()
    for record in records:
        if record.get("k") == "tres" and isinstance(record.get("call"), str):
            tool_chars[record["call"]] += int_or_zero(record.get("chars"))
    call_names = {r.get("call"): r.get("name") for r in records if r.get("k") == "tcall"}
    tools = [
        {
            "tool": call_names.get(call, "?"),
            "calls": sum(1 for r in records if r.get("k") == "tres" and r.get("call") == call),
            "chars": chars,
        }
        for call, chars in tool_chars.items()
    ]
    tools.sort(key=lambda row: row["chars"], reverse=True)

    turns: list[dict] = []
    grouped: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for record in records:
        if record.get("k") == "req" and isinstance(record.get("turn"), int):
            grouped[(str(record.get("s")), record["turn"])].append(record)
    for (session_id, turn), turn_records in sorted(grouped.items()):
        cache_read, denominator, _ = weighted_hit(turn_records)
        turns.append(
            {
                "session": session_id,
                "turn": turn,
                "requests": len(turn_records),
                "hit": (cache_read / denominator) if denominator else None,
            }
        )

    rewrites = [
        {
            "time": r.get("t"),
            "session": r.get("s"),
            "role": r.get("r"),
            "kind": r.get("ty"),
            "shadowed_tokens": r.get("shadowed"),
            "detail": r.get("err") or "",
        }
        for r in records
        if r.get("k") == "compact"
    ]
    return {"sessions": sessions, "tools": tools, "turns": turns, "rewrites": rewrites}


def fmt_rate(value) -> str:
    return "未知" if value is None else f"{value * 100:.1f}%"


def fmt_time(value) -> str:
    if not isinstance(value, (int, float)):
        return "?"
    return datetime.fromtimestamp(value / 1000).strftime("%m-%d %H:%M:%S")


def write_csv(path: Path, rows: list[dict], fields: list[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow({field: row.get(field, "") for field in fields})


def print_report(records: list[dict], summary: dict) -> None:
    sessions = summary["sessions"]
    total_requests = sum(s["requests"] for s in sessions)
    total_cr = sum(s["cache_read"] for s in sessions)
    total_denom = sum(s["denominator"] for s in sessions)
    total_series = sum(s["series_resets"] for s in sessions)
    total_compactions = sum(s["compactions"] for s in sessions)
    total_prunes = sum(s["prunes"] for s in sessions)
    total_team_calls = sum(s["team_tool_calls"] for s in sessions)
    total_calls = sum(s["tool_calls"] for s in sessions)

    print("=" * 78)
    print("P0 团队缓存 / 前缀审计报告")
    print("=" * 78)
    print(f"记录数 {len(records)} · 会话 {len(sessions)} · 请求 {total_requests}")
    print(
        f"加权命中率 {fmt_rate((total_cr / total_denom) if total_denom else None)}"
        f"  (cache_read {total_cr:,} / 分母 {total_denom:,}；分母 = in + cr + cw)"
    )
    print(f"前缀重写：series 重置 {total_series} 次 · 压缩摘要 {total_compactions} 次 · 工具结果裁剪 {total_prunes} 次")
    if total_calls:
        print(f"团队协调工具调用 {total_team_calls}/{total_calls} = {total_team_calls / total_calls * 100:.1f}%")
    print()

    print("-- 每会话 --------------------------------------------------------------")
    header = f"{'会话':<18}{'角色':<16}{'请求':>5}{'命中率':>8}{'重置':>5}{'压缩':>5}{'裁剪':>5}{'协调占比':>9}"
    print(header)
    for session in sessions:
        share = (session["team_tool_calls"] / session["tool_calls"] * 100) if session["tool_calls"] else 0.0
        role = str(session["role"])[:14]
        print(
            f"{session['session'][:16]:<18}{role:<16}{session['requests']:>5}"
            f"{fmt_rate(session['hit']):>8}{session['series_resets']:>5}"
            f"{session['compactions']:>5}{session['prunes']:>5}{share:>8.1f}%"
        )
    print()

    if summary["rewrites"]:
        print("-- 前缀重写事件 --------------------------------------------------------")
        for rewrite in summary["rewrites"][-20:]:
            tokens = rewrite["shadowed_tokens"]
            token_text = f"{tokens:,} tok" if isinstance(tokens, int) else "-"
            print(
                f"{fmt_time(rewrite['time'])}  {str(rewrite['session'])[:12]:<12}"
                f"{str(rewrite['role'])[:14]:<15}{rewrite['kind']:<14}{token_text:>12}  {rewrite['detail'][:40]}"
            )
        print()

    if summary["tools"]:
        print("-- 工具结果体积 Top10（裁剪阈值 8192 字符）-------------------------------")
        for row in summary["tools"][:10]:
            print(f"{row['tool']:<28}{row['calls']:>5} 次{row['chars']:>12,} 字符")
        print()

    turns = [turn for turn in summary["turns"] if turn["hit"] is not None]
    if turns:
        worst = sorted(turns, key=lambda turn: turn["hit"])[:10]
        print("-- 命中率最低的 10 个回合 ----------------------------------------------")
        for turn in worst:
            print(f"{turn['session'][:16]:<18}turn {turn['turn']:<4}{turn['requests']:>3} 请求  {fmt_rate(turn['hit'])}")
        print()


def main() -> None:
    # The report is Chinese; keep the pipe UTF-8 even when the Windows console
    # still runs an older code page (redirect to a file, or `chcp 65001`, to read it).
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError):
            pass

    parser = argparse.ArgumentParser(description="Summarize dsh-team-ext cache/prefix audit logs.")
    parser.add_argument("log_dir", nargs="?", default=str(DEFAULT_LOG_DIR))
    parser.add_argument("--out", default="")
    args = parser.parse_args()

    log_dir = Path(args.log_dir)
    records = load_records(log_dir)
    summary = summarize(records)
    print_report(records, summary)

    out_dir = Path(args.out) if args.out else log_dir / "analysis"
    write_csv(
        out_dir / "summary_by_session.csv",
        summary["sessions"],
        [
            "session", "role", "requests", "no_usage", "cache_read", "denominator", "hit",
            "series_resets", "compactions", "prunes", "prune_tokens", "tool_calls",
            "team_tool_calls", "tool_result_chars", "tool_result_p95", "warnings",
        ],
    )
    write_csv(out_dir / "tools.csv", summary["tools"], ["tool", "calls", "chars"])
    write_csv(out_dir / "turns.csv", summary["turns"], ["session", "turn", "requests", "hit"])
    print(f"CSV 已写入 {out_dir}")


if __name__ == "__main__":
    main()
