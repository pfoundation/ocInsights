#!/usr/bin/env python3
"""Derive template.html from a built deck by replacing embedded data with placeholders.

This is how template.html was created from legacy/opencode_time_full.reference.html.
You only need to re-run it if you edit a built deck by hand and want to fold the
change back into the template; normal edits go straight into template.html.

Usage: python3 tools/make_template.py legacy/opencode_time_full.reference.html template.html
"""
import re
import sys

DATA_CONSTS = ["MONTHS", "HM", "HD", "PORDER", "LB", "COST", "DEPTH", "AGENTS", "MODELS", "RHY",
               "DMODELS", "DTOK", "UA", "UAM", "PROD", "SHIP", "CM", "DHRS"]
DROP_CONSTS = ["TOP"]  # embedded but unused


def json_end(s: str, i: int) -> int:
    """Index just past the JSON value starting at s[i] (object/array/string/number)."""
    depth, in_str, esc = 0, False, False
    j = i
    while j < len(s):
        c = s[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c in "[{":
            depth += 1
        elif c in "]}":
            depth -= 1
            if depth == 0:
                return j + 1
        elif depth == 0 and c == ";":
            return j
        j += 1
    raise ValueError("unterminated value")


def main(src, dst):
    h = open(src).read()
    for name in DATA_CONSTS + DROP_CONSTS:
        key = f"const {name}="
        i = h.index(key)
        assert h.count(key) == 1, name
        j = json_end(h, i + len(key))
        assert h[j] == ";", (name, h[j:j + 20])
        h = h[:i] + ("" if name in DROP_CONSTS else f"const {name}=@@{name}@@") + h[j + (1 if name in DROP_CONSTS else 0):]

    def rep(old, new, n=1):
        nonlocal h
        c = h.count(old)
        assert c == n, f"{old[:60]!r}: expected {n}, found {c}"
        h = h.replace(old, new)

    # date/window logic literals -> RANGE
    rep("const MONTHS=@@MONTHS@@;", "const RANGE=@@RANGE@@;\nconst MONTHS=@@MONTHS@@;")
    rep("let t=Date.UTC(2026,5,6);const end=Date.UTC(2026,8,3);", "let t=Date.parse(RANGE.winStart);const end=Date.parse(RANGE.end);", 2)
    rep("let fd=new Date(Date.UTC(2026,0,16));", "let fd=new Date(Date.parse(RANGE.start));")
    rep("for(let w=0;w<34;w++)", "for(let w=0;w<RANGE.weeks;w++)")
    rep("if(iso<'2026-01-16'||iso>'2026-09-03')", "if(iso<RANGE.start||iso>RANGE.end)")
    rep("bars(AGENTS,954,2405)", "bars(AGENTS,AGENTS[0][1],RANGE.sessions)")
    rep("bars(MODELS,883,2405)", "bars(MODELS,MODELS[0][1],RANGE.sessions)")
    rep("moTot=2405;", "moTot=RANGE.sessions;")

    # KPI text -> placeholders
    rep("818.35 h · 2,405 sess · $14,737 · 202.6M tok", "@@badge@@")
    rep("2026-01-16 to 2026-09-03.", "@@start@@ to @@end@@.")
    rep("173 active days of 231", "@@active_days@@ active days of @@span_days@@")
    rep('<div class="kpi">818.35 h</div>', '<div class="kpi">@@total_hr@@ h</div>')
    rep("91,313 messages", "@@messages@@ messages")
    rep('<div class="kpi">12.7&times;</div>', '<div class="kpi">@@autonomy@@&times;</div>')
    rep("6,538 prompts by you &middot; 83,312 by agents", "@@prompts_top@@ prompts by you &middot; @@replies@@ by agents")
    rep('<div class="kpi">202.6M</div>', '<div class="kpi">@@fresh@@</div>')
    rep("13.6B cache reads · 947M cache writes", "@@cache_read@@ cache reads · @@cache_write@@ cache writes")
    rep('<p class="cdesc mono">/home/ubuntu/dev/datastudio</p>', '<p class="cdesc mono">@@top_project@@</p>')
    rep('<div class="kpi">402.79 h</div>', '<div class="kpi">@@top_hr@@ h</div>')
    rep("49.2% · 1,092 sessions", "@@top_pct@@% · @@top_sessions@@ sessions")
    rep('<div class="kpi">$14,732</div>', '<div class="kpi">$@@cost@@</div>')
    rep("202.6M fresh tokens · $18.01 per active hour", "@@fresh@@ fresh tokens · $@@cost_per_hr@@ per active hour")
    rep('<p class="cdesc mono">2026-03-20</p>', '<p class="cdesc mono">@@busiest_day@@</p>')
    rep('<div class="kpi">24.02 h</div>', '<div class="kpi">@@busiest_hr@@ h</div>')
    rep("3,189 messages · March peak", "@@busiest_msgs@@ messages · @@busiest_month@@ peak")
    rep("March is the peak at 164.4 h", "@@peak_month_name@@ is the peak at @@peak_month_hr@@ h")
    rep("2026-06-06 to 2026-09-03", "@@win_start@@ to @@end@@", 2)
    rep("read straight from the 21 repositories", "read straight from the @@repos@@ repositories")

    left = sorted(set(re.findall(r"20\d\d-\d\d-\d\d", h[:h.index("<script>")])))
    assert not left, f"dates still baked into the page body: {left}"
    open(dst, "w").write(h)
    print(f"{dst}: {len(h):,} bytes, {len(re.findall(r'@@[a-zA-Z_]+@@', h))} placeholders")


if __name__ == "__main__":
    main(*sys.argv[1:3])
