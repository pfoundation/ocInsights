import sqlite3, datetime, csv, collections
cutoff = 1785801600000
db='file:/home/ubuntu/.local/share/opencode/opencode.db?mode=ro'
con=sqlite3.connect(db, timeout=60)
cur=con.cursor()

# per-project-per-day ms
cur.execute('''
WITH filtered AS (
 SELECT session_id, time_created, date(time_created/1000,'unixepoch') as d FROM session_message
 WHERE time_created >= ? AND type IN ('user','assistant')
),
ordered AS (
 SELECT session_id, time_created, d,
        LAG(time_created) OVER (PARTITION BY session_id ORDER BY time_created) as prev
 FROM filtered
),
active AS (
 SELECT session_id, d, time_created,
  CASE WHEN prev IS NULL THEN 60000 WHEN (time_created-prev) > 600000 THEN 600000 ELSE (time_created-prev) END as a_ms
 FROM ordered
)
SELECT p.worktree, a.d, COUNT(DISTINCT a.session_id), COUNT(*), SUM(a_ms)
FROM active a
JOIN session_v2 s ON s.id=a.session_id
JOIN project p ON p.id=s.project_id
GROUP BY p.id, a.d;
''', (cutoff,))
rows=cur.fetchall()

# date list Aug4-Sep3 inclusive
start=datetime.date(2026,8,4); end=datetime.date(2026,9,3)
days=[]
d=start
while d<=end:
    days.append(d.isoformat()); d+=datetime.timedelta(days=1)

projects_ordered=[]
seen=set()
# order by total desc (re-query totals)
cur.execute('''
WITH filtered AS (SELECT session_id,time_created FROM session_message WHERE time_created>=? AND type IN ('user','assistant')),
ordered AS (SELECT session_id,time_created, LAG(time_created) OVER (PARTITION BY session_id ORDER BY time_created) as prev FROM filtered),
active AS (SELECT session_id,time_created, CASE WHEN prev IS NULL THEN 60000 WHEN (time_created-prev)>600000 THEN 600000 ELSE (time_created-prev) END as a_ms FROM ordered)
SELECT p.worktree, COUNT(DISTINCT a.session_id), COUNT(*), SUM(a_ms) FROM active a JOIN session_v2 s ON s.id=a.session_id JOIN project p ON p.id=s.project_id GROUP BY p.id ORDER BY SUM(a_ms) DESC;
''',(cutoff,))
totals=cur.fetchall()
proj_short={w:(w.split('/')[-1] if w not in ('/','/home/ubuntu','/home/ubuntu/dev') else w) for w,_,_,_ in totals}

matrix={(w,d):0 for w,_,_,_ in totals for d in days}
sess_d={(w,d):0 for w,_,_,_ in totals for d in days}
msgs_d={(w,d):0 for w,_,_,_ in totals for d in days}
for w,d,ns,nm,ms in rows:
    matrix[(w,d)]=ms; sess_d[(w,d)]=ns; msgs_d[(w,d)]=nm

# write CSVs
with open('/tmp/opencode/project_time_30d.csv','w',newline='') as f:
    w=csv.writer(f); w.writerow(['worktree','short','sessions','messages','active_ms','active_hr','pct'])
    total=sum(r[3] for r in totals)
    for work,ns,nm,ms in totals:
        w.writerow([work,proj_short[work],ns,nm,ms,round(ms/3600000,2),round(ms/total*100,2)])
with open('/tmp/opencode/project_time_daily.csv','w',newline='') as f:
    w=csv.writer(f); w.writerow(['worktree','date','sessions','messages','active_ms','active_hr'])
    for (work,d),ms in sorted(matrix.items()):
        if ms>0:
            w.writerow([work,d,sess_d[(work,d)],msgs_d[(work,d)],ms,round(ms/3600000,2)])

# daily totals
daily_tot={d:sum(matrix[(w,d)] for w,_,_,_ in totals) for d in days}
print("DAILY_TOT_HR:", {d:round(v/3600000,2) for d,v in daily_tot.items()})

# Build GitHub-style HTML (weeks Mon-Sun)
# pad start to Monday
fd=start
while fd.weekday()!=0: fd-=datetime.timedelta(days=1)
ld=end
while ld.weekday()!=6: ld+=datetime.timedelta(days=1)
weeks=[]
cur_d=fd
while cur_d<=ld:
    weeks.append([cur_d+datetime.timedelta(days=i) for i in range(7)])
    cur_d+=datetime.timedelta(days=7)

def color(ms):
    h=ms/3600000
    if h<=0: return '#161b22'
    if h<1: return '#0e4429'
    if h<3: return '#006d32'
    if h<6: return '#26a641'
    return '#39d353'

html=['<html><head><meta charset="utf-8"><title>OpenCode 30d activity</title>',
'<style>body{background:#0d1117;color:#c9d1d9;font-family:sans-serif;padding:24px}table{border-collapse:collapse;margin:16px 0}td,th{border:1px solid #30363d;padding:6px 8px;font-size:12px}.cal{display:flex;gap:4px}.wk{display:flex;flex-direction:column;gap:4px}.cell{width:14px;height:14px;border-radius:3px}.lbl{font-size:11px;color:#8b949e}</style></head><body>',
'<h2>OpenCode activity — 2026-08-04 → 2026-09-03 (UTC, 10-min cap)</h2>',
'<p>Method: per session, order user+assistant messages, active += min(delta,10min), +60s for first message. Group by project worktree.</p>',
'<h3>Overall daily (GitHub-style, Mon rows → Sun)</h3><div class="cal">']
for wk in weeks:
    html.append('<div class="wk">')
    for day in wk:
        iso=day.isoformat()
        ms=daily_tot.get(iso,0) if start.isoformat()<=iso<=end.isoformat() else -1
        if ms==-1:
            html.append('<div class="cell" style="background:transparent"></div>')
        else:
            html.append(f'<div class="cell" title="{iso}: {ms/3600000:.2f}h" style="background:{color(ms)}"></div>')
    html.append('</div>')
html.append('</div>')
html.append('<p class="lbl">Less → More: <span style="background:#161b22">&nbsp;&nbsp;</span> <span style="background:#0e4429">&nbsp;&nbsp;</span> <span style="background:#006d32">&nbsp;&nbsp;</span> <span style="background:#26a641">&nbsp;&nbsp;</span> <span style="background:#39d353">&nbsp;&nbsp;</span> &nbsp; 0h / &lt;1h / &lt;3h / &lt;6h / ≥6h</p>')
html.append('<h3>Per-project totals</h3><table><tr><th>worktree</th><th>sessions</th><th>msgs</th><th>hrs</th><th>%</th></tr>')
total=sum(r[3] for r in totals)
for work,ns,nm,ms in totals:
    html.append(f'<tr><td>{work}</td><td>{ns}</td><td>{nm}</td><td>{ms/3600000:.2f}</td><td>{ms/total*100:.1f}%</td></tr>')
html.append(f'</table><p>Total: {total/3600000:.2f}h across {sum(r[1] for r in totals)} sessions, {sum(r[2] for r in totals)} msgs, {len(totals)} projects.</p>')
# per-project daily heat table
html.append('<h3>Per-project daily heat (hrs)</h3><table><tr><th>project</th>')
for d in days: html.append(f'<th>{d[5:]}</th>')
html.append('</tr>')
for work,ns,nm,ms in totals:
    html.append(f'<tr><td>{proj_short[work]}</td>')
    for d in days:
        h=matrix[(work,d)]/3600000
        bg=color(matrix[(work,d)])
        txt=f'{h:.1f}' if h>=0.5 else (f'{h:.2f}' if h>0 else '')
        html.append(f'<td title="{work} {d}: {h:.2f}h" style="background:{bg}">{txt}</td>')
    html.append('</tr>')
html.append('</table></body></html>')
open('/tmp/opencode/opencode_time_heatmap.html','w').write('\n'.join(html))
print("wrote html + csv")
