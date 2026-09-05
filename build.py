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

    for name in ["RANGE", "DTOK", "CM", "DAYW", "DAYM", "DAYU", "RHYD", "SESS", "SESS_COLS", "IDX", "PH", "PH_COLS", "PSRC", "LEDGER"]:
        h = h.replace(f"@@{name}@@", json.dumps(d[name], separators=(",", ":")))

    month_name = lambda ym: dt.date.fromisoformat(ym + "-01").strftime("%B")
    sc = {c: i for i, c in enumerate(d["SESS_COLS"])}
    edits = sum(r[sc["edits"]] for r in d["SESS"])
    edit_sess = sum(1 for r in d["SESS"] if r[sc["edits"]] > 0)
    rec_n = len(d["CM"]["recs"])
    man_n = sum(1 for x in d["CM"]["manual"] if not x[2])
    commit_n = rec_n + man_n
    judged = [r for r in d["SESS"] if not r[sc["child"]] and r[sc["a"]] > 0 and r[sc["tedits"]] > 0 and r[sc["tpaths"]]]
    shipped = [r for r in judged if r[sc["tship"]]]
    kpi = dict(
        badge=f"{m['total_hr']:.2f} h · {m['sessions']:,} sess · ${m['cost']:,.0f} · {tokens(m['fresh_tokens'])} tok",
        start=m["start"], end=m["end"], win_start=m["win_start"],
        active_days=str(m["active_days"]), span_days=str(m["span_days"]),
        total_hr=f"{m['total_hr']:.2f}", messages=f"{m['messages']:,}",
        autonomy=f"{m['replies']/max(m['prompts_top'],1):.1f}",
        tts=f"{sum(r[sc['u']] for r in judged)/max(len(shipped),1):.1f}" if shipped else "—",
        tjudged=f"{len(judged):,}", tshipped=f"{len(shipped):,}",
        fresh=tokens(m["fresh_tokens"]), cache_read=tokens(m["cache_read"]), cache_write=tokens(m["cache_write"]),
        edits=f"{edits:,}", edits_per_hr=f"{edits/max(m['total_hr'],0.01):.1f}", edits_sess=f"{edit_sess:,}",
        commits=str(rec_n), commits_share=f"{100*rec_n/max(commit_n,1):.0f}",
        commits_total=str(commit_n), commits_manual=str(man_n),
        cost=f"{m['cost']:,.0f}", cost_per_hr=f"{m['cost']/max(m['total_hr'],0.01):.2f}",
        peak_month_name=month_name(m["peak_month"]), peak_month_hr=f"{m['peak_month_hr']:.1f}",
        repos=str(m["repos"]), ship_days=str(m.get("ship_days", 7)),
        sessions=f"{m['sessions']:,}",
    )
    for k, v in kpi.items():
        h = h.replace(f"@@{k}@@", v)
    left = re.findall(r"@@[a-zA-Z_]+@@", h)
    assert not left, f"unfilled placeholders: {sorted(set(left))}"
    open(args.out, "w").write(h)
    print(f"{args.out}: {len(h):,} bytes · {kpi['badge']} · generated from data of {m['generated']}")


if __name__ == "__main__":
    main()
