import sqlite3, json, re, datetime
db='file:/home/ubuntu/.local/share/opencode/opencode.db?mode=ro'
con=sqlite3.connect(db, timeout=300); cur=con.cursor()
# per-session per-day active ms (same heartbeat buckets as hours grid)
cur.execute('''
WITH f AS (SELECT session_id, time_created, date(time_created/1000,'unixepoch') d FROM session_message WHERE type IN ('user','assistant')),
o AS (SELECT session_id, time_created, d, LAG(time_created) OVER (PARTITION BY session_id ORDER BY time_created) p FROM f)
SELECT session_id, d, SUM(CASE WHEN p IS NULL THEN 60000 WHEN (time_created-p)>600000 THEN 600000 ELSE (time_created-p) END)
FROM o GROUP BY session_id, d;''')
sess_day={}
for sid, d, ms in cur.fetchall():
    sess_day.setdefault(sid, []).append((d, ms))
cur.execute("SELECT id, date(time_created/1000,'unixepoch'), COALESCE(tokens_input,0)+COALESCE(tokens_output,0)+COALESCE(tokens_reasoning,0), COALESCE(cost,0) FROM session_v2;")
tok={}; sess=0
for sid, cday, t, c in cur.fetchall():
    days=sess_day.get(sid)
    if not days:
        assert t==0 and c==0, (sid, t, c)  # lossless: zero-token sessions only
        continue
    tot=sum(ms for _, ms in days)
    for d, ms in days:
        e=tok.setdefault(d, [0, 0.0, set()])
        e[0]+=t*ms/tot; e[1]+=c*ms/tot; e[2].add(sid)
DTOK={d:[round(v[0]), round(v[1],2), len(v[2])] for d,v in tok.items()}
print("tok days:", len(DTOK), "fresh:", round(sum(v[0] for v in DTOK.values())))
# cross-check: every hours-day now has tokens
cur.execute("SELECT COUNT(DISTINCT date(time_created/1000,'unixepoch')) FROM session_message WHERE type IN ('user','assistant');")
print("hours days:", cur.fetchone()[0])
json.dump(DTOK, open("/tmp/opencode/dtok_fixed.json","w"))

p="/tmp/opencode/opencode_time_full.html"
h=open(p).read()
def rep(old, new):
    global h
    assert old in h, "ANCHOR MISSING: "+old[:70]
    h=h.replace(old, new, 1)

# swap DTOK payload
h=re.sub(r'const DTOK=\{.*?\};', 'const DTOK='+json.dumps(DTOK)+';', h, count=1, flags=re.S)
# UTC-safe grid math
rep("let fd=new Date('2026-01-16');while(fd.getDay()!==1)fd.setDate(fd.getDate()-1);",
    "let fd=new Date(Date.UTC(2026,0,16));while(fd.getUTCDay()!==1)fd.setUTCDate(fd.getUTCDate()-1);")
rep("const dt=new Date(fd);dt.setDate(fd.getDate()+w*7+k);const iso=dt.toISOString().slice(0,10);",
    "const dt=new Date(fd.getTime());dt.setUTCDate(fd.getUTCDate()+w*7+k);const iso=dt.toISOString().slice(0,10);")
# footnote: allocation note instead of midnight caveat
rep("Fresh tokens per day by session creation day. Sessions spanning midnight (7%) attribute to their start day.",
    "Fresh tokens per day. Each session's tokens split across the days its messages fall on, weighted by active time, so days match the hours grid.")
rep("Cost and token sums come straight from session records.",
    "Cost and token sums come straight from session records, split across message days by active time. ")
open(p,"w").write(h)
print("patched bytes:", len(h))
