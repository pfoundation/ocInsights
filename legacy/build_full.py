import sqlite3, json, datetime
db='file:/home/ubuntu/.local/share/opencode/opencode.db?mode=ro'
con=sqlite3.connect(db, timeout=180); cur=con.cursor()
# merged leaderboard by worktree
cur.execute('''
WITH f AS (SELECT session_id, time_created FROM session_message WHERE type IN ('user','assistant')),
o AS (SELECT session_id, time_created, LAG(time_created) OVER (PARTITION BY session_id ORDER BY time_created) p FROM f),
a AS (SELECT session_id, time_created, CASE WHEN p IS NULL THEN 60000 WHEN (time_created-p)>600000 THEN 600000 ELSE (time_created-p) END ms FROM o)
SELECT p.worktree, COUNT(DISTINCT a.session_id), COUNT(*), SUM(ms), COUNT(DISTINCT date(a.time_created/1000,'unixepoch')),
 MIN(date(a.time_created/1000,'unixepoch')), MAX(date(a.time_created/1000,'unixepoch'))
FROM a JOIN session_v2 s ON s.id=a.session_id JOIN project p ON p.id=s.project_id
GROUP BY p.worktree ORDER BY SUM(ms) DESC;
''')
lb=[{"w":r[0],"sess":r[1],"msgs":r[2],"hr":round(r[3]/3600000,2),"days":r[4],"first":r[5],"last":r[6]} for r in cur.fetchall()]
tot_hr=round(sum(x["hr"] for x in lb),2)
# distinct active days overall
cur.execute("SELECT COUNT(DISTINCT date(time_created/1000,'unixepoch')) FROM session_message WHERE type IN ('user','assistant');")
ndays=cur.fetchone()[0]
# monthly matrix
cur.execute('''
WITH f AS (SELECT session_id, time_created, strftime('%Y-%m', time_created/1000,'unixepoch') m FROM session_message WHERE type IN ('user','assistant')),
o AS (SELECT session_id, time_created, m, LAG(time_created) OVER (PARTITION BY session_id ORDER BY time_created) p FROM f),
a AS (SELECT session_id, m, CASE WHEN p IS NULL THEN 60000 WHEN (time_created-p)>600000 THEN 600000 ELSE (time_created-p) END ms FROM o)
SELECT p.worktree, a.m, SUM(ms)/3600000.0 FROM a JOIN session_v2 s ON s.id=a.session_id JOIN project p ON p.id=s.project_id GROUP BY p.worktree, a.m;
''')
monrows=cur.fetchall()
months=sorted(set(r[1] for r in monrows))
top8=[x["w"] for x in lb[:8]]
monmat={m:{w:0 for w in top8+["OTHER"]} for m in months}
for w,m,h in monrows:
    monmat[m][w if w in top8 else "OTHER"]+=round(h,2)
# cost/tokens/churn
cur.execute('''SELECT p.worktree, SUM(s.cost), SUM(s.tokens_input+s.tokens_output+s.tokens_reasoning),
 SUM(COALESCE(s.summary_additions,0)), SUM(COALESCE(s.summary_deletions,0)) FROM session_v2 s JOIN project p ON p.id=s.project_id GROUP BY p.worktree;''')
cost={r[0]:{"cost":round(r[1] or 0,2),"tok":r[2] or 0,"add":r[3],"dele":r[4]} for r in cur.fetchall()}
# agents
cur.execute("SELECT COALESCE(NULLIF(agent,''),'(unset)'), COUNT(*) FROM session_v2 GROUP BY 1 ORDER BY 2 DESC LIMIT 8;")
agents=cur.fetchall()
# models with variant
cur.execute("SELECT model, COUNT(*) FROM session_v2 GROUP BY model ORDER BY 2 DESC LIMIT 8;")
models=[]
for m,c in cur.fetchall():
    try:
        import json as J; o=J.loads(m); mid=f"{o['id']} ({o.get('variant','?')})" if m else "(unset)"
    except: mid="(unset)" if not m else m[:40]
    models.append((mid,c))
# rhythm 7x24 counts
cur.execute("""SELECT CAST(strftime('%w', time_created/1000,'unixepoch') AS INT) wd, CAST(strftime('%H', time_created/1000,'unixepoch') AS INT) h, COUNT(*) FROM session_message WHERE type IN ('user','assistant') GROUP BY wd,h;""")
rhy=[[0]*24 for _ in range(7)]
for wd,h,c in cur.fetchall(): rhy[wd][h]=c
# compactions
cur.execute("""SELECT p.worktree, COUNT(*) FROM session_message m JOIN session_v2 s ON s.id=m.session_id JOIN project p ON p.id=s.project_id WHERE m.type='compaction' GROUP BY p.worktree;""")
comp=dict(cur.fetchall())
out={"lb":lb,"tot_hr":tot_hr,"ndays":ndays,"months":months,"monmat":monmat,"top8":top8,"cost":cost,"agents":agents,"models":models,"rhy":rhy,"comp":comp}
json.dump(out, open("/tmp/opencode/full_data.json","w"))
print("tot_hr",tot_hr,"ndays",ndays,"months",months)
print("top worktree",lb[0])
