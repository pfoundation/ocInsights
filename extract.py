#!/usr/bin/env python3
"""Extract every dataset the productivity deck needs into one data.json.

One read-only pass over the opencode SQLite store plus `git log` on each
project worktree. Stdlib only. Run: python3 extract.py [--out data.json]

Every number in the deck is derived here; build.py only formats and injects.
See README.md for the definitions (heartbeat hours, edits, verified, commit
attribution) and AGENTS.md for the data gotchas that shaped them.
"""
from __future__ import annotations

import argparse
import bisect
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict

# ---------------------------------------------------------------- config ---
DB_PATH = os.environ.get("OC_DB", os.path.expanduser("~/.local/share/opencode/opencode.db"))
DEV_ROOT = os.environ.get("OC_DEV_ROOT", os.path.expanduser("~/dev"))
GIT_AUTHORS = set(filter(None, os.environ.get("OC_GIT_AUTHORS", "Jud Saoud,judsd").split(",")))
WINDOW_DAYS = 90            # daily charts (hours by project, models per day)
HEARTBEAT_CAP_MS = 600_000  # gap between messages credited as active, max
HEARTBEAT_SEED_MS = 60_000  # credit for the first message of a session
LINES_CAP = 10_000          # per-session line cap for the legacy line-count column
LINES_CUTOFF = "2026-06-06" # summary_additions stopped being written at opencode 1.16.2
COMMIT_WINDOW_H = 72        # a commit's attribution window, capped
COMMIT_GRACE_S = 300        # messages up to this long after a commit still count
SHIP_DAYS = 7               # a session "shipped" if its edits landed in a commit within this many days
LEDGER_PATH = os.environ.get("OC_EDIT_LEDGER", os.path.expanduser("~/.local/share/ocProductivity/edits.jsonl"))  # written by plugin/editLedger.ts
PART_BACKFILL = True        # read edit paths from the legacy `part` table (Feb–Aug 2026, absent from message JSON)
BUILD_AGENTS = {"build", "Sisyphus-Junior", "Sisyphus (Ultraworker)", "BuildAgent", "beads-task-agent", "general"}
PLAN_AGENTS = {"plan", "Metis (Plan Consultant)"}
EDIT_TOOLS = {"edit", "write", "apply_patch", "multiedit", "patch"}
VERIFY_RE = re.compile(r"\b(vitest|jest|pytest|go test|cargo test|npm test|pnpm test|bun test|pnpm run test|npm run test|tsc|pnpm build|npm run build|pnpm run build|next build|bun build|cargo build|go build|eslint|pnpm lint|npm run lint|pnpm run lint|biome|ruff|golangci)\b")
COMMIT_RE = re.compile(r"\bgit\s+commit\b")
AGENT_RE = re.compile(r'"agent":"([^"]+)"')  # each assistant message records the agent (plan/build/...) it ran under


def canon(model_id: str) -> str:
    """Collapse provider prefixes and spelling variants into one name per model.

    claude-opus-4-6, claude-opus-4.6, anthropic/claude-opus-4.6 and claude-opus-46
    are all the same model. This is dedup, not grouping.
    """
    i = model_id.split("/")[-1]
    i = re.sub(r"-\d{8}$", "", i).replace("antigravity-", "")
    for pat, fmt in [
        (r"(claude-(?:opus|sonnet|haiku))-?(\d)[.-]?(\d)$", "{0}-{1}.{2}"),
        (r"(claude-(?:opus|sonnet|haiku))-(\d)(\d)$", "{0}-{1}.{2}"),
        (r"(claude-(?:opus|sonnet|haiku))-(\d)$", "{0}-{1}"),
        (r"(claude-fable)-(\d)-(\d)$", "{0}-{1}.{2}"),
        (r"(claude-fable)-(\d)$", "{0}-{1}"),
    ]:
        m = re.match(pat, i)
        if m:
            return fmt.format(*m.groups())
    return i


def role_of(agent: str) -> int:
    return 2 if agent in BUILD_AGENTS else 1 if agent in PLAN_AGENTS else 0


def day_of(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%d")


def days_between(a: str, b: str) -> list[str]:
    d0 = dt.date.fromisoformat(a)
    d1 = dt.date.fromisoformat(b)
    return [(d0 + dt.timedelta(days=i)).isoformat() for i in range((d1 - d0).days + 1)]


# ------------------------------------------------------------- sessions ---
def load_sessions(cur):
    cur.execute(
        """SELECT s.id, p.worktree, COALESCE(NULLIF(s.agent,''),'(unset)'), s.parent_id IS NOT NULL,
                  COALESCE(s.cost,0), COALESCE(s.tokens_input,0)+COALESCE(s.tokens_output,0)+COALESCE(s.tokens_reasoning,0),
                  COALESCE(s.tokens_cache_read,0), COALESCE(s.tokens_cache_write,0),
                  COALESCE(s.summary_additions,0), COALESCE(s.summary_deletions,0), s.summary_additions IS NOT NULL,
                  s.model, s.time_created, COALESCE(s.directory, p.worktree), s.parent_id
           FROM session_v2 s JOIN project p ON p.id=s.project_id"""
    )
    meta = {}
    for r in cur.fetchall():
        meta[r[0]] = dict(wt=r[1], agent=r[2], child=bool(r[3]), cost=r[4], fresh=r[5], cache_r=r[6], cache_w=r[7],
                          add=r[8], dele=r[9], has_lines=bool(r[10]), model=r[11], created=r[12], dir=r[13], parent=r[14])
    return meta


def rel_file(path: str, base: str) -> str | None:
    """A recorded edit path, relative to the directory the session ran in.

    Sessions ran in the project worktree, in a renamed copy of it (v0-dashboard → datastudio),
    or in one of opencode's temporary git worktrees; git paths are always repo-relative, so
    the base must be the session's own directory, never the project's current worktree.
    """
    if not path:
        return None
    if not os.path.isabs(path):
        return path.replace("\\", "/")
    rel = os.path.relpath(path, base)
    return None if rel.startswith("..") else rel.replace("\\", "/")


def part_edits(cur, meta):
    """Edit paths from the legacy `part` table (Feb–Aug 2026). Returns session -> [(ts_s, relpath)]."""
    out = defaultdict(list)
    if not PART_BACKFILL:
        return out
    try:
        cur.execute("""SELECT session_id, time_created, data FROM part
                       WHERE (data LIKE '%"tool":"edit"%' OR data LIKE '%"tool":"write"%' OR data LIKE '%"tool":"apply_patch"%')
                         AND data LIKE '%"filePath"%'""")
    except Exception:
        return out
    for sid, tc, data in cur:
        m = meta.get(sid)
        if not m:
            continue
        try:
            st = json.loads(data).get("state") or {}
        except Exception:
            continue
        f = rel_file((st.get("input") or {}).get("filePath") or (st.get("input") or {}).get("path"), m["dir"])
        if f:
            out[sid].append((tc / 1000, f))
    return out


def ledger_edits(meta):
    """Edit paths from our own append-only ledger (plugin/editLedger.ts).

    Returns (session -> [(ts_s, relpath)], info). opencode instantiates a plugin once per
    location, so the same tool call can be appended more than once; lines are deduped on the
    tool call id (`call`), falling back to (session, ts, file) for lines written before it existed.
    `info` counts every well-formed line, including sessions outside the scanned projects.
    """
    out = defaultdict(list)
    info = dict(lines=0, first=None, last=None, sessions=0)
    if not os.path.exists(LEDGER_PATH):
        return out, info
    seen, sess = set(), set()
    with open(LEDGER_PATH) as fh:
        for line in fh:
            try:
                e = json.loads(line)
            except Exception:
                continue
            key = (e.get("call"), e.get("file")) if e.get("call") else (e.get("session"), e.get("ts"), e.get("file"))
            if key in seen:
                continue
            seen.add(key)
            info["lines"] += 1
            info["first"] = min(info["first"] or e["ts"], e["ts"])
            info["last"] = max(info["last"] or 0, e["ts"])
            sess.add(e.get("session"))
            m = meta.get(e.get("session"))
            if not m:
                continue
            f = rel_file(e.get("file"), e.get("dir") or m["dir"])
            if f:
                out[e["session"]].append((e["ts"] / 1000, f))
    info["sessions"] = len(sess)
    return out, info


def scan_messages(cur, meta, win_start_ms):
    """Single ordered pass over user+assistant messages. Returns per-session stats and global rollups."""
    S = defaultdict(lambda: dict(mp=Counter(), u=0, a=0, err=0, ms=0, last=None, ev=[], edits=0, eerr=0, files=set(),
                                 reads=0, bash=0, tools=0, terr=0, ver=0, commit=0, edit_ev=[], first=None, comp=0, day0=None, cur=None,
                                 ph=defaultdict(lambda: dict(mp=Counter(), ms=0, u=0, a=0, err=0, edits=0, eerr=0, files=set(), reads=0, bash=0, tools=0, terr=0, ver=0, commit=0))))
    day_wt_ms = defaultdict(Counter)      # day -> worktree -> ms
    day_wt_role = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))  # day -> worktree -> ms by role code [all, plan, build]
    rhythm_day = defaultdict(lambda: [0] * 24)  # day -> hour -> messages
    day_u = defaultdict(lambda: [0, 0, 0])      # day -> [your prompts, subagent prompts, replies]
    models_day_role = defaultdict(lambda: defaultdict(lambda: [0, 0, 0]))  # day -> "model|provider" -> msgs by role code [all, plan, build]
    day_sess = defaultdict(set)           # day -> sessions active
    rhythm = [[0] * 24 for _ in range(7)] # Sun..Sat x hour
    models_day = defaultdict(Counter)     # day -> "model|provider" -> assistant msgs (window only)
    ua_wt = defaultdict(lambda: [0, 0, 0])
    ua_month = defaultdict(lambda: [0, 0, 0])
    depth = {}                            # worktree -> [first, last, compactions]
    month_edits = defaultdict(lambda: [0, 0])  # month -> [edit tool calls, of which with a path in the message JSON]
    last_edit_ms = 0                      # newest edit tool call seen, to judge whether the ledger is keeping up
    n_msgs = 0
    cur.execute("SELECT session_id, type, data, time_created FROM session_message WHERE type IN ('user','assistant','compaction') ORDER BY session_id, time_created")
    for sid, typ, data, tc in cur:
        m = meta.get(sid)
        if not m:
            continue
        wt = m["wt"]
        day = day_of(tc)
        d = depth.setdefault(wt, [day, day, 0])
        d[0] = min(d[0], day)
        d[1] = max(d[1], day)
        if typ == "compaction":
            d[2] += 1
            S[sid]["comp"] += 1
            continue
        n_msgs += 1
        s = S[sid]
        inc = HEARTBEAT_SEED_MS if s["last"] is None else min(tc - s["last"], HEARTBEAT_CAP_MS)
        if s["first"] is None:
            s["first"] = tc / 1000
            s["day0"] = day
        if typ == "assistant":
            am = AGENT_RE.search(data[:400])
            if am:
                s["cur"] = role_of(am.group(1))
        r = s["cur"] if s["cur"] is not None else role_of(m["agent"])
        ph = s["ph"][r]
        ph["ms"] += inc
        dr = day_wt_role[day][wt]
        dr[0] += inc
        if r:
            dr[r] += inc
        rhythm_day[day][dt.datetime.fromtimestamp(tc / 1000, dt.timezone.utc).hour] += 1
        s["last"] = tc
        s["ms"] += inc
        s["ev"].append((tc / 1000, inc))
        day_wt_ms[day][wt] += inc
        day_sess[day].add(sid)
        t = dt.datetime.fromtimestamp(tc / 1000, dt.timezone.utc)
        rhythm[(t.weekday() + 1) % 7][t.hour] += 1
        month = day[:7]
        if typ == "user":
            s["u"] += 1
            ph["u"] += 1
            k = 1 if m["child"] else 0
            ua_wt[wt][k] += 1
            ua_month[month][k] += 1
            day_u[day][k] += 1
            continue
        s["a"] += 1
        ph["a"] += 1
        ua_wt[wt][2] += 1
        ua_month[month][2] += 1
        day_u[day][2] += 1
        try:
            o = json.loads(data)
        except Exception:
            continue
        mm = o.get("model") or {}
        model = canon(mm.get("id", "(unlisted)"))
        prov = mm.get("providerID", "(unlisted)")
        s["mp"][(model, prov)] += 1
        ph["mp"][(model, prov)] += 1
        if tc >= win_start_ms:
            models_day[day][model + "|" + prov] += 1
        mdr = models_day_role[day][model + "|" + prov]
        mdr[0] += 1
        if r:
            mdr[r] += 1
        if o.get("error"):
            s["err"] += 1
            ph["err"] += 1
        for part in o.get("content") or []:
            if part.get("type") != "tool":
                continue
            name = part.get("name", "?")
            st = part.get("state") or {}
            status = st.get("status")
            s["tools"] += 1
            ph["tools"] += 1
            if status == "error":
                s["terr"] += 1
                ph["terr"] += 1
            if name in EDIT_TOOLS:
                s["edits"] += 1
                ph["edits"] += 1
                if status == "error":
                    s["eerr"] += 1
                    ph["eerr"] += 1
                f = st.get("title") or (st.get("input") or {}).get("filePath") or (st.get("input") or {}).get("path")
                month_edits[month][0] += 1
                last_edit_ms = max(last_edit_ms, tc)
                if f:
                    month_edits[month][1] += 1
                    s["files"].add(f)
                    ph["files"].add(f)
                    rf = rel_file(f, m["dir"])
                    if rf:
                        s["edit_ev"].append((tc / 1000, rf))
            elif name == "read":
                s["reads"] += 1
                ph["reads"] += 1
            elif name in ("bash", "shell"):
                s["bash"] += 1
                ph["bash"] += 1
                c = (st.get("input") or {}).get("command") or ""
                if VERIFY_RE.search(c):
                    s["ver"] += 1
                    ph["ver"] += 1
                if COMMIT_RE.search(c):
                    s["commit"] += 1
                    ph["commit"] += 1
    return S, day_wt_ms, day_sess, rhythm, models_day, ua_wt, ua_month, depth, n_msgs, dict(day_wt_role=day_wt_role, rhythm_day=rhythm_day, day_u=day_u, models_day_role=models_day_role,
                                                                                          month_edits=month_edits, last_edit_ms=last_edit_ms)


# --------------------------------------------------------------- commits ---
def git_commits(repo: str):
    """Commits with their changed files. --numstat gives insertions, deletions and the path per file
    in one pass (binary files show '-' and count as 0 lines)."""
    out = subprocess.run(["git", "-C", repo, "log", "--all", "--since=2026-01-01", "--no-merges", "--format=%x1e%H|%at|%an", "--numstat"],
                         capture_output=True, text=True).stdout
    cs = []
    for blk in out.split("\x1e")[1:]:
        lines = blk.strip("\n").split("\n")
        h, at, an = lines[0].split("|", 2)
        c = dict(h=h, at=int(at), an=an, ins=0, dele=0, files=set())
        for line in lines[1:]:
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            a, d, f = parts
            c["ins"] += int(a) if a.isdigit() else 0
            c["dele"] += int(d) if d.isdigit() else 0
            if " => " in f:  # rename: "dir/{old => new}.ts" or "old => new"
                m = re.match(r"^(.*)\{(.*) => (.*)\}(.*)$", f)
                f = (m.group(1) + m.group(3) + m.group(4)) if m else f.split(" => ")[-1]
            c["files"].add(f)
        cs.append(c)
    return cs


def attribute_commits(S, meta, start_day, edits):
    """Commit attribution by file overlap.

    A commit's window runs from the previous commit in the same repo to the commit (capped at
    COMMIT_WINDOW_H, plus COMMIT_GRACE_S). Sessions whose recorded edits inside the window touch
    files in the commit share it, weighted by how many of its files each touched. Sessions that
    were active but touched none of the files get no credit (they advised; they did not ship).
    Sessions that edited in the window but have no recorded paths at all (OpenAI providers, the
    gap before the ledger) fall back to the old active-minutes share, flagged basis "window".
    Commits with no qualifying session are manual. `edits` is session -> [(ts_s, relpath)].
    """
    since = dt.datetime.fromisoformat(start_day).replace(tzinfo=dt.timezone.utc).timestamp()
    WT, ED = defaultdict(list), defaultdict(list)
    for sid, s in S.items():
        if sid in meta and s["mp"]:
            wt = meta[sid]["wt"]
            for ts, ms in s["ev"]:
                WT[wt].append((ts, sid, ms))
            for ts, f in edits.get(sid, []):
                ED[wt].append((ts, sid, f))
    for w in WT:
        WT[w].sort()
    for w in ED:
        ED[w].sort()
    repos = sorted(w for w in {m["wt"] for m in meta.values()}
                   if w.startswith(DEV_ROOT + "/") and subprocess.run(["git", "-C", w, "rev-parse", "--git-dir"], capture_output=True).returncode == 0)
    models, provs, mi, pi = [], [], {}, {}

    def idx(lst, d, v):
        if v not in d:
            d[v] = len(lst)
            lst.append(v)
        return d[v]

    recs, manual, seen, total = [], [], set(), 0
    basis = Counter()            # files / window / manual / advised (commits with activity but no credited session)
    shipped = defaultdict(list)  # session -> [commit_ts] for sessions credited by file overlap
    for repo in repos:
        cs = [c for c in git_commits(repo) if c["an"] in GIT_AUTHORS and c["at"] >= since and c["h"] not in seen]
        seen.update(c["h"] for c in cs)
        cs.sort(key=lambda c: c["at"])
        ev, ed = WT.get(repo, []), ED.get(repo, [])
        ts, ets = [e[0] for e in ev], [e[0] for e in ed]
        prev = None
        for c in cs:
            total += 1
            lo = max(prev if prev else c["at"] - 6 * 3600, c["at"] - COMMIT_WINDOW_H * 3600)
            hi = c["at"] + COMMIT_GRACE_S
            prev = c["at"]
            lines = c["ins"] + c["dele"]
            # active minutes per session in the window (fallback weight, and the hours/prompts credited)
            mins = Counter()
            for _, sid, ms in ev[bisect.bisect_left(ts, lo):bisect.bisect_right(ts, hi)]:
                mins[sid] += ms
            # files of this commit touched per session in the window
            touched = defaultdict(set)
            for _, sid, f in ed[bisect.bisect_left(ets, lo):bisect.bisect_right(ets, hi)]:
                if f in c["files"]:
                    touched[sid].add(f)
            if touched:
                weights = {sid: len(fs) for sid, fs in touched.items()}
                how = "files"
            else:
                # sessions that edited in the window but never had a path recorded: fall back to time share
                blind = {sid: ms for sid, ms in mins.items() if S[sid]["edits"] > 0 and not edits.get(sid)}
                weights, how = blind, "window"
            tot = sum(weights.values())
            if not tot:
                basis["advised" if mins else "manual"] += 1
                manual.append([c["at"], lines, 1 if mins else 0])
                continue
            basis[how] += 1
            # Entries are per session PHASE: a credited session contributes its build phase and, if it had one, its
            # plan phase, splitting its credit, hours and prompts by phase time. Plan-only sessions active in the
            # window get an advisor entry (share 0, flagged) so the planner→builder pairing can still see who planned;
            # the off and split views ignore advisor entries, so credit and hours per commit are unchanged by them.
            ent = []
            for sid, w in weights.items():
                share = w / tot
                ms = mins.get(sid, 0)
                s = S[sid]
                phases = [(r, ph) for r, ph in s["ph"].items() if ph["mp"] and ph["ms"] > 0] or [(role_of(meta[sid]["agent"]), None)]
                for r, ph in phases:
                    if ph is None:
                        (model, prov), _ = s["mp"].most_common(1)[0]
                        frac = 1.0
                    else:
                        (model, prov), _ = ph["mp"].most_common(1)[0]
                        frac = ph["ms"] / max(s["ms"], 1)
                    ent.append([idx(models, mi, model), idx(provs, pi, prov), r, round(share * frac, 4),
                                round(s["u"] * ms / max(s["ms"], 1) * frac, 3), round(ms / 3.6e6 * frac, 3), 0])
                if how == "files":
                    shipped[sid].append(c["at"])
            for sid, ms in mins.items():
                if sid in weights:
                    continue
                ph = S[sid]["ph"].get(1)
                if ph and ph["mp"] and ph["ms"] > 0:
                    (model, prov), _ = ph["mp"].most_common(1)[0]
                    frac = ph["ms"] / max(S[sid]["ms"], 1)
                    ent.append([idx(models, mi, model), idx(provs, pi, prov), 1, 0.0,
                                round(S[sid]["u"] * ms / max(S[sid]["ms"], 1) * frac, 3), round(ms / 3.6e6 * frac, 3), 1])
            recs.append([lines, round(sum(mins.values()) / 3.6e6, 3), ent, c["at"], how])
    latest = max([r[3] for r in recs] + [m[0] for m in manual] + [0])
    return dict(models=models, provs=provs, recs=recs, manual=manual, total=total, repos=len(repos), latest=latest,
                basis=dict(basis)), shipped


# ------------------------------------------------------------------ main ---
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data.json")
    args = ap.parse_args()
    import sqlite3
    t0 = time.time()
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=600)
    cur = con.cursor()
    meta = load_sessions(cur)

    cur.execute("SELECT MIN(time_created), MAX(time_created) FROM session_message WHERE type IN ('user','assistant')")
    lo, hi = cur.fetchone()
    start_day, end_day = day_of(lo), day_of(hi)
    all_days = days_between(start_day, end_day)
    win_start = (dt.date.fromisoformat(end_day) - dt.timedelta(days=WINDOW_DAYS - 1)).isoformat()
    win_start_ms = int(dt.datetime.fromisoformat(win_start).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)

    S, day_wt_ms, day_sess, rhythm, models_day, ua_wt, ua_month, depth, n_msgs, X = scan_messages(cur, meta, win_start_ms)

    # hours by worktree: monthly, daily window, totals
    HM = defaultdict(lambda: defaultdict(float))
    HD = defaultdict(dict)
    DHRS = {}
    wt_ms, wt_sess, wt_msgs = Counter(), defaultdict(set), Counter()
    for day, per in day_wt_ms.items():
        DHRS[day] = round(sum(per.values()) / 3.6e6, 2)
        for wt, ms in per.items():
            HM[day[:7]][wt] += ms / 3.6e6
            if day >= win_start:
                HD[day][wt] = round(ms / 3.6e6, 2)
            wt_ms[wt] += ms
    for sid, s in S.items():
        wt = meta[sid]["wt"]
        wt_sess[wt].add(sid)
        wt_msgs[wt] += s["u"] + s["a"]
    HM = {m: {w: round(h, 2) for w, h in per.items()} for m, per in HM.items()}
    PORDER = [w for w, _ in wt_ms.most_common()]
    total_ms = sum(wt_ms.values())
    LB = [[w, len(wt_sess[w]), wt_msgs[w], round(wt_ms[w] / 3.6e6, 2), round(100 * wt_ms[w] / total_ms, 1)] for w in PORDER]

    COST = defaultdict(lambda: [0.0, 0, 0, 0])
    for m in meta.values():
        c = COST[m["wt"]]
        c[0] += m["cost"]; c[1] += m["fresh"]; c[2] += m["add"]; c[3] += m["dele"]
    COST = {w: [round(v[0], 2), v[1], v[2], v[3]] for w, v in COST.items()}

    AGENTS = Counter(m["agent"] for m in meta.values()).most_common(8)
    def model_label(mj):
        if not mj:
            return "(unset)"
        try:
            o = json.loads(mj)
            return f"{o.get('id','?')} ({o.get('variant','?')})"
        except Exception:
            return mj[:40]
    MODELS = Counter(model_label(m["model"]) for m in meta.values()).most_common(8)

    # tokens per day: session fresh tokens/cost split across message days by active-ms share
    sess_day_ms = defaultdict(Counter)
    for sid, s in S.items():
        for ts, inc in s["ev"]:
            sess_day_ms[sid][day_of(int(ts * 1000))] += inc
    acc = defaultdict(lambda: [0.0, 0.0, set()])
    for sid, days in sess_day_ms.items():
        m = meta[sid]; tot = sum(days.values())
        for day, ms in days.items():
            e = acc[day]; e[0] += m["fresh"] * ms / tot; e[1] += m["cost"] * ms / tot; e[2].add(sid)
    DTOK = {d: [round(v[0]), round(v[1], 2), len(v[2])] for d, v in acc.items()}

    # edit paths from all three sources: message JSON, the legacy part table (Feb–Aug), our ledger (Sep onward).
    # The message JSON is the primary source and still carries paths; the ledger is insurance against it stopping again.
    edits = defaultdict(set)
    for sid, s in S.items():
        edits[sid].update(s["edit_ev"])
    part_src = part_edits(cur, meta)
    ledger_src, ledger = ledger_edits(meta)
    for src in (part_src, ledger_src):
        for sid, evs in src.items():
            edits[sid].update(evs)
    edits = {sid: sorted(v) for sid, v in edits.items() if v}
    # PSRC: month -> [edit tool calls, with a path in the message JSON, part-table records, ledger records].
    # The three sources overlap, so they are drawn side by side as coverage of the edit count, never stacked.
    PSRC = {mo: [n, p, 0, 0] for mo, (n, p) in X["month_edits"].items()}
    for col, src in ((2, part_src), (3, ledger_src)):
        for evs in src.values():
            for ts, _ in evs:
                PSRC.setdefault(day_of(int(ts * 1000))[:7], [0, 0, 0, 0])[col] += 1
    PSRC = {mo: PSRC[mo] for mo in sorted(PSRC)}
    path_cov = sum(1 for sid, s in S.items() if s["edits"] > 0 and sid in edits)
    editing = sum(1 for s in S.values() if s["edits"] > 0)

    CM, shipped = attribute_commits(S, meta, start_day, edits)

    # per-model aggregates (productivity + shipping share one record shape)
    AGG = defaultdict(Counter)
    lines_cut = int(dt.datetime.fromisoformat(LINES_CUTOFF).replace(tzinfo=dt.timezone.utc).timestamp() * 1000)
    ship_lag = defaultdict(list)  # (model, prov, build) -> hours from session start to first credited commit
    per_sess_ship = {}            # sid -> (shipped, lag_h, has_paths)
    for sid, s in S.items():
        if not s["a"]:
            continue
        m = meta[sid]
        (model, prov), _ = s["mp"].most_common(1)[0]
        key = (model, prov, int(m["agent"] in BUILD_AGENTS))
        g = AGG[key]
        g["sess"] += 1; g["hrs"] += s["ms"] / 3.6e6; g["u"] += s["u"]; g["a"] += s["a"]; g["err"] += s["err"]; g["cost"] += m["cost"]
        g["edits"] += s["edits"]; g["eerr"] += s["eerr"]; g["files"] += len(s["files"]); g["reads"] += s["reads"]; g["bash"] += s["bash"]
        g["tools"] += s["tools"]; g["terr"] += s["terr"]; g["vercalls"] += s["ver"]; g["commits"] += s["commit"]
        if s["edits"] > 0:
            g["coded"] += 1
        if m["has_lines"] and m["created"] < lines_cut:
            g["lsess"] += 1; g["lhrs"] += s["ms"] / 3.6e6; g["lines"] += min(m["add"] + m["dele"], LINES_CAP)
        # shipped: this session's edits landed in one of your commits within SHIP_DAYS of its start
        first_commit = min((t for t in shipped.get(sid, []) if t >= (s["first"] or 0)), default=None)
        sh = first_commit is not None and first_commit - s["first"] <= SHIP_DAYS * 86400
        ed, v = s["edits"] > 0, s["ver"] > 0
        g["s_noedit"] += 0 if ed else 1
        g["s_edit"] += 1 if ed and not v and not sh else 0
        g["s_ver"] += 1 if ed and v and not sh else 0
        g["s_commit"] += 1 if ed and sh else 0          # stage name kept for the template; it now means shipped
        g["s_paths"] += 1 if ed and sid in edits else 0  # sessions whose shipping could be judged at all
        if sh:
            ship_lag[key].append((first_commit - s["first"]) / 3600)
        per_sess_ship[sid] = (1 if sh else 0, round((first_commit - s["first"]) / 3600, 2) if sh else -1, 1 if (ed and sid in edits) else 0)
    PROD = []
    for k, g in AGG.items():
        lag = sorted(ship_lag[k])
        PROD.append({"m": k[0], "p": k[1], "b": k[2], **{x: (round(v, 3) if isinstance(v, float) else v) for x, v in g.items()},
                     "ship_lag_med": round(lag[len(lag) // 2], 2) if lag else None})

    # per-session rows and day-granular series: everything the deck re-derives under a window / role filter
    IDX = dict(wt=[], agent=[], model=[], prov=[], lmodel=[])
    ix = {k: {} for k in IDX}

    def idx(kind, v):
        if v not in ix[kind]:
            ix[kind][v] = len(IDX[kind])
            IDX[kind].append(v)
        return ix[kind][v]
    SESS, PH = [], []

    def phase_models(s):
        out = []
        for r in (1, 2):
            ph = s["ph"].get(r) if s else None
            if ph and ph["mp"]:
                pm = ph["mp"].most_common(1)[0][0]
                out += [idx("model", pm[0]), idx("prov", pm[1])]
            else:
                out += [-1, -1]
        return out
    for sid, m in meta.items():
        s = S.get(sid)
        if s and s["mp"]:
            (model, prov), _ = s["mp"].most_common(1)[0]
        else:
            model, prov = "(none)", "(none)"
        day = (s and s["day0"]) or day_of(m["created"])
        lines = min(m["add"] + m["dele"], LINES_CAP) if (m["has_lines"] and m["created"] < lines_cut) else -1
        sh, lag, paths = per_sess_ship.get(sid, (0, -1, 0))
        SESS.append([day, idx("wt", m["wt"]), idx("agent", m["agent"]), role_of(m["agent"]), int(m["child"]), idx("model", model), idx("prov", prov),
                     idx("lmodel", model_label(m["model"])), round((s["ms"] if s else 0) / 3.6e6, 3), s["u"] if s else 0, s["a"] if s else 0, s["err"] if s else 0,
                     round(m["cost"], 4), m["fresh"], m["cache_r"], m["cache_w"], s["edits"] if s else 0, s["eerr"] if s else 0, len(s["files"]) if s else 0,
                     s["reads"] if s else 0, s["bash"] if s else 0, s["tools"] if s else 0, s["terr"] if s else 0, s["ver"] if s else 0, s["commit"] if s else 0,
                     lines, s["comp"] if s else 0, sh, lag, paths, m["add"], m["dele"],
                     *phase_models(s)])
        if s:
            for r, ph in s["ph"].items():
                if not (ph["a"] or ph["u"]):
                    continue
                pm = ph["mp"].most_common(1)[0][0] if ph["mp"] else (model, prov)
                share = ph["ms"] / max(s["ms"], 1)
                PH.append([len(SESS) - 1, r, idx("model", pm[0]), idx("prov", pm[1]), round(ph["ms"] / 3.6e6, 3), ph["u"], ph["a"], ph["err"],
                           round(m["cost"] * share, 4), ph["edits"], ph["eerr"], len(ph["files"]), ph["reads"], ph["bash"], ph["tools"], ph["terr"], ph["ver"], ph["commit"]])
    SESS_COLS = ["day", "wt", "agent", "role", "child", "model", "prov", "lmodel", "hrs", "u", "a", "err", "cost", "fresh", "cacheR", "cacheW",
                 "edits", "eerr", "files", "reads", "bash", "tools", "terr", "ver", "commit", "lines", "comp", "shipped", "lag", "paths", "add", "dele", "pm", "pp", "bm", "bp"]
    PH_COLS = ["sess", "role", "model", "prov", "hrs", "u", "a", "err", "cost", "edits", "eerr", "files", "reads", "bash", "tools", "terr", "ver", "commit"]
    DAYW = {d: {w: [round(v[0] / 3.6e6, 3), round(v[1] / 3.6e6, 3), round(v[2] / 3.6e6, 3)] for w, v in per.items()} for d, per in X["day_wt_role"].items()}
    DAYM = {d: dict(per) for d, per in X["models_day_role"].items()}
    DAYU = dict(X["day_u"])
    RHYD = dict(X["rhythm_day"])

    fresh = sum(m["fresh"] for m in meta.values())
    u_top = sum(s["u"] for sid, s in S.items() if not meta[sid]["child"])
    a_all = sum(s["a"] for s in S.values())
    busiest = max(DHRS, key=DHRS.get)
    day_msgs = Counter()
    for sid, s in S.items():
        for ts, _ in s["ev"]:
            day_msgs[day_of(int(ts * 1000))] += 1
    peak_month = max(HM, key=lambda m: sum(HM[m].values()))
    data = dict(
        meta=dict(generated=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), db=DB_PATH, start=start_day, end=end_day,
                  win_start=win_start, window_days=WINDOW_DAYS, span_days=len(all_days), active_days=len(DHRS),
                  sessions=len(meta), messages=n_msgs, total_hr=round(total_ms / 3.6e6, 2), cost=round(sum(m["cost"] for m in meta.values()), 2),
                  fresh_tokens=fresh, cache_read=sum(m["cache_r"] for m in meta.values()), cache_write=sum(m["cache_w"] for m in meta.values()),
                  prompts_top=u_top, prompts_child=sum(s["u"] for sid, s in S.items() if meta[sid]["child"]), replies=a_all,
                  busiest_day=busiest, busiest_hr=DHRS[busiest], busiest_msgs=day_msgs[busiest],
                  peak_month=peak_month, peak_month_hr=round(sum(HM[peak_month].values()), 1),
                  top_project=PORDER[0], top_hr=LB[0][3], top_pct=LB[0][4], top_sessions=LB[0][1],
                  repos=CM["repos"], lines_cutoff=LINES_CUTOFF, heartbeat_cap_min=HEARTBEAT_CAP_MS // 60000,
                  ship_days=SHIP_DAYS, basis=CM["basis"], sessions_editing=editing, sessions_with_paths=path_cov,
                  ledger_present=os.path.exists(LEDGER_PATH)),
        # LEDGER: what plugin/editLedger.ts has collected, plus the newest edit seen in the DB so the deck can tell a dead plugin from a quiet week
        LEDGER=dict(path=LEDGER_PATH, lines=ledger["lines"], sessions=ledger["sessions"], first=ledger["first"], last=ledger["last"], last_edit=X["last_edit_ms"]),
        MONTHS=sorted(HM), HM=HM, HD=HD, PORDER=PORDER, LB=LB, COST=COST, DEPTH=depth, AGENTS=AGENTS, MODELS=MODELS, RHY=rhythm,
        DMODELS={"day": {d: dict(c) for d, c in models_day.items()}}, DTOK=DTOK,
        UA={w: v for w, v in ua_wt.items()}, UAM={m: v for m, v in sorted(ua_month.items())},
        PROD=PROD, SHIP=PROD, CM=CM, DHRS=DHRS, PSRC=PSRC,
        DAYW=DAYW, DAYM=DAYM, DAYU=DAYU, RHYD=RHYD, SESS=SESS, SESS_COLS=SESS_COLS, IDX=IDX, PH=PH, PH_COLS=PH_COLS,
    )
    with open(args.out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    mt = data["meta"]
    b = CM["basis"]
    print(f"{args.out}: {mt['start']} → {mt['end']}, {mt['sessions']} sessions, {mt['messages']:,} msgs, {mt['total_hr']} h, "
          f"{CM['total']} commits in {CM['repos']} repos — by files {b.get('files',0)}, by window {b.get('window',0)}, "
          f"advised only {b.get('advised',0)}, manual {b.get('manual',0)} · edit paths for {path_cov}/{editing} editing sessions"
          f" · ledger: {ledger['lines']} edits in {ledger['sessions']} sessions, last {day_of(ledger['last']) if ledger['last'] else 'never'}"
          f"{'' if ledger['lines'] else ' (run make install-plugin, then restart opencode)'} · {time.time()-t0:.0f}s")


if __name__ == "__main__":
    main()
