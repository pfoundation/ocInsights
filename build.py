#!/usr/bin/env python3
"""Render the deck: data.json + template.html -> opencode_time_full.html.

Pure formatting. Every number comes from extract.py; this only turns it into
strings and injects the JSON constants. Run: python3 build.py [--data data.json] [--out opencode_time_full.html]
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re


def tokens(v: float) -> str:
    return f"{v/1e9:.1f}B" if v >= 1e9 else f"{v/1e6:.1f}M" if v >= 1e6 else f"{v/1e3:.0f}k" if v >= 1e3 else str(int(v))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="data.json")
    ap.add_argument("--template", default="template.html")
    ap.add_argument("--out", default="opencode_time_full.html")
    args = ap.parse_args()
    d = json.load(open(args.data))
    m = d["meta"]
    h = open(args.template).read()

    # calendar grid: Monday on or before the first day, through the week holding the last day
    first = dt.date.fromisoformat(m["start"])
    monday = first - dt.timedelta(days=(first.weekday()))
    weeks = (dt.date.fromisoformat(m["end"]) - monday).days // 7 + 1
    d["RANGE"] = dict(start=m["start"], end=m["end"], winStart=m["win_start"], weeks=weeks, sessions=m["sessions"])

    for name in ["RANGE", "DTOK", "CM", "DAYW", "DAYM", "DAYU", "RHYD", "SESS", "SESS_COLS", "IDX"]:
        h = h.replace(f"@@{name}@@", json.dumps(d[name], separators=(",", ":")))

    month_name = lambda ym: dt.date.fromisoformat(ym + "-01").strftime("%B")
    kpi = dict(
        badge=f"{m['total_hr']:.2f} h · {m['sessions']:,} sess · ${m['cost']:,.0f} · {tokens(m['fresh_tokens'])} tok",
        start=m["start"], end=m["end"], win_start=m["win_start"],
        active_days=str(m["active_days"]), span_days=str(m["span_days"]),
        total_hr=f"{m['total_hr']:.2f}", messages=f"{m['messages']:,}",
        autonomy=f"{m['replies']/max(m['prompts_top'],1):.1f}", prompts_top=f"{m['prompts_top']:,}", replies=f"{m['replies']:,}",
        fresh=tokens(m["fresh_tokens"]), cache_read=tokens(m["cache_read"]), cache_write=tokens(m["cache_write"]),
        top_project=m["top_project"], top_hr=f"{m['top_hr']:.2f}", top_pct=f"{m['top_pct']:.1f}", top_sessions=f"{m['top_sessions']:,}",
        cost=f"{m['cost']:,.0f}", cost_per_hr=f"{m['cost']/max(m['total_hr'],0.01):.2f}",
        busiest_day=m["busiest_day"], busiest_hr=f"{m['busiest_hr']:.2f}", busiest_msgs=f"{m['busiest_msgs']:,}",
        busiest_month=month_name(m["busiest_day"][:7]), peak_month_name=month_name(m["peak_month"]), peak_month_hr=f"{m['peak_month_hr']:.1f}",
        repos=str(m["repos"]), ship_days=str(m.get("ship_days", 7)),
    )
    for k, v in kpi.items():
        h = h.replace(f"@@{k}@@", v)
    left = re.findall(r"@@[a-zA-Z_]+@@", h)
    assert not left, f"unfilled placeholders: {sorted(set(left))}"
    open(args.out, "w").write(h)
    print(f"{args.out}: {len(h):,} bytes · {kpi['badge']} · generated from data of {m['generated']}")


if __name__ == "__main__":
    main()
