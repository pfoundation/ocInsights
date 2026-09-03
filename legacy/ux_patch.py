import re, json, sqlite3
p="/tmp/opencode/opencode_time_full.html"
h=open(p).read()
def rep(old,new,count=1):
    global h
    assert old in h, "ANCHOR MISSING: "+old[:80]
    h=h.replace(old,new,count)

# ---------- hours-per-day for token tooltips ----------
con=sqlite3.connect('file:/home/ubuntu/.local/share/opencode/opencode.db?mode=ro',timeout=180,uri=True)
cur=con.cursor()
cur.execute("""WITH f AS (SELECT session_id,time_created,date(time_created/1000,'unixepoch') d FROM session_message WHERE type IN ('user','assistant')),
o AS (SELECT session_id,time_created,d,LAG(time_created) OVER (PARTITION BY session_id ORDER BY time_created) p FROM f),
a AS (SELECT d,CASE WHEN p IS NULL THEN 60000 WHEN (time_created-p)>600000 THEN 600000 ELSE (time_created-p) END ms FROM o)
SELECT d,ROUND(SUM(ms)/3600000.0,2) FROM a GROUP BY d;""")
DHRS={r[0]:r[1] for r in cur.fetchall()}

# ---------- CSS ----------
rep("*{box-sizing:border-box;border-radius:0!important}",
"""*{box-sizing:border-box;border-radius:0!important}
:root{--background:oklch(0.98 0.005 260);--foreground:oklch(0.15 0.005 260);--card:oklch(1 0 0);--card-foreground:oklch(0.15 0.005 260);--muted:oklch(0.94 0.005 260);--muted-foreground:oklch(0.45 0.005 260);--primary:oklch(0.55 0.16 55);--primary-foreground:oklch(0.98 0 0);--secondary:oklch(0.94 0.005 260);--secondary-foreground:oklch(0.25 0.005 260);--border:oklch(0.88 0.005 260);--chart-1:oklch(0.55 0.16 55);--chart-2:oklch(0.6 0.15 160);--chart-3:oklch(0.65 0.15 80);--chart-4:oklch(0.55 0.2 320);--chart-5:oklch(0.6 0.2 30)}
#tip{position:fixed;pointer-events:none;background:var(--card);color:var(--card-foreground);border:1px solid var(--border);padding:8px 10px;font-size:12px;display:none;z-index:50;box-shadow:0 2px 8px rgba(0,0,0,.25);max-width:300px;line-height:1.5;font-family:"IBM Plex Sans",system-ui,sans-serif}
#tip b{font-weight:600}#tip .row{display:flex;justify-content:space-between;gap:14px}#tip .row span:last-child{font-family:"Inconsolata",monospace}
#tip .sw{display:inline-block;width:9px;height:9px;margin-right:6px;vertical-align:-1px}
.bar{position:sticky;top:0;z-index:20;background:var(--background);padding:12px 0;margin:-24px 0 4px;border-bottom:1px solid var(--border)}
.btn{font:inherit;font-size:12px;background:var(--card);color:var(--foreground);border:1px solid var(--border);padding:5px 10px;cursor:pointer;height:28px}
.btn:hover{background:var(--muted)}.btn[aria-pressed=true]{background:var(--primary);color:var(--primary-foreground);border-color:var(--primary)}
.lg{cursor:pointer;user-select:none}.lg:hover{background:var(--muted)}.lg.off{opacity:.35}.lg.hot{background:var(--muted)}
.lgreset{font-size:11.5px;color:var(--muted-foreground);cursor:pointer;margin-left:4px;text-decoration:underline;text-underline-offset:2px;display:none}.lgreset.on{display:inline}
svg rect{transition:opacity .15s}svg rect.dim{opacity:.18}svg rect:hover{stroke:var(--foreground);stroke-width:1}
th.sortable{cursor:pointer;user-select:none;white-space:nowrap}th.sortable:hover{color:var(--foreground)}th.sortable::after{content:'';display:inline-block;width:0;margin-left:5px}
th.sortable[data-dir=asc]::after{content:'\\25B4'}th.sortable[data-sort][data-dir=desc]::after{content:'\\25BE'}
tbody tr{cursor:default}tbody tr:hover td{background:var(--muted)}tbody tr.hot td{background:var(--muted)}
.cell{cursor:default}.cell:hover{outline:1px solid var(--foreground);outline-offset:-1px}
.rhy .cell:hover{outline:1px solid var(--foreground);outline-offset:-1px}
.scale{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted-foreground);margin-top:10px}.scale i{width:12px;height:12px;display:inline-block;border:1px solid var(--border)}
details{margin-top:12px}summary{cursor:pointer;font-size:12.5px;color:var(--muted-foreground);user-select:none}summary:hover{color:var(--foreground)}
details p{margin:8px 0 0}
.showall{margin-top:8px}
.hbar{cursor:default}""")

# ---------- header: theme toggle + method details ----------
rep('<span class="badge mono">818.35 h · 2,405 sess · $14,737 · 202.6M tok</span></div>',
    '<span class="badge mono">818.35 h · 2,405 sess · $14,737 · 202.6M tok</span><button class="btn" id="theme" aria-pressed="true" title="Toggle light or dark">Dark</button></div>')
rep('<p class="dim">Estimate, not wall clock. Active adds min(delta, 10 min) per message plus 60 s seed. Excludes system, synthetic and compaction messages. Cost and token sums come straight from session records, split across message days by active time.  Fresh tokens equal input plus output plus reasoning; cache reads (13.6B) are reported separately. Models over time counts assistant messages by the model field on each message (session records only keep the last model used).</p>',
    '<details><summary>Method and caveats</summary><p class="dim">Estimate, not wall clock. Active adds min(delta, 10 min) per message plus 60 s seed. Excludes system, synthetic and compaction messages.</p><p class="dim">Cost and token sums come straight from session records, split across message days by active time. Fresh tokens equal input plus output plus reasoning; cache reads (13.6B) are reported separately.</p><p class="dim">Models over time counts assistant messages by the model field on each message; session records only keep the last model used. All dates and hours are UTC.</p></details>')

# ---------- swatch scales + show all ----------
rep('<p class="dim" style="margin:10px 0 0">Scale: none · &lt;1M · &lt;3M · &lt;8M · 8M or more fresh tokens</p>',
    '<div class="scale"><span>Less</span><i style="background:var(--muted)"></i><i style="background:color-mix(in oklab, var(--primary) 30%, var(--muted))"></i><i style="background:color-mix(in oklab, var(--primary) 55%, var(--muted))"></i><i style="background:color-mix(in oklab, var(--primary) 80%, var(--muted))"></i><i style="background:var(--primary)"></i><span>More</span><span style="margin-left:8px">none · under 1M · under 3M · under 8M · 8M or more</span></div>')
rep('<p class="dim">Rows Sunday to Saturday, columns 00 to 23.</p>',
    '<div class="scale"><span>Less</span><i style="background:var(--muted)"></i><i style="background:color-mix(in oklab, var(--primary) 35%, var(--muted))"></i><i style="background:color-mix(in oklab, var(--primary) 65%, var(--muted))"></i><i style="background:var(--primary)"></i><span>More</span><span style="margin-left:8px">Sunday to Saturday, 00 to 23 UTC</span></div>')
rep('<table><thead><tr><th>Worktree</th><th>Hours</th><th>Share</th><th>Sess</th><th>Cost</th><th>$/h</th><th>Tokens</th><th>Churn +/-</th></tr></thead><tbody id="tb"></tbody></table>',
    '<table id="lbt"><thead><tr><th class="sortable" data-k="0" data-t="s">Worktree</th><th class="sortable" data-k="1" data-sort data-dir="desc">Hours</th><th class="sortable" data-k="2">Share</th><th class="sortable" data-k="3">Sess</th><th class="sortable" data-k="4">Cost</th><th class="sortable" data-k="5">$/h</th><th class="sortable" data-k="6">Tokens</th><th class="sortable" data-k="7">Churn +/-</th></tr></thead><tbody id="tb"></tbody></table>')
rep('<table><thead><tr><th>Worktree</th><th>Msgs/sess</th><th>Min/sess</th><th>Compactions</th><th>First</th><th>Last</th></tr></thead><tbody id="db"></tbody></table></div></div>',
    '<table id="dpt"><thead><tr><th class="sortable" data-k="0" data-t="s">Worktree</th><th class="sortable" data-k="1">Msgs/sess</th><th class="sortable" data-k="2">Min/sess</th><th class="sortable" data-k="3">Compactions</th><th class="sortable" data-k="4" data-t="s">First</th><th class="sortable" data-k="5" data-t="s">Last</th></tr></thead><tbody id="db"></tbody></table><button class="btn showall" id="showall" aria-pressed="false">Show all 24 projects</button></div></div>')
rep('<div class="cbody"><div id="mleg"></div><svg id="mchart"','<div class="cbody"><div id="mleg"></div><span class="lgreset" id="mreset">Reset</span><svg id="mchart"')
rep('<div class="cbody"><div id="dleg"></div><svg id="dchart"','<div class="cbody"><div id="dleg"></div><span class="lgreset" id="dreset">Reset</span><svg id="dchart"')

# ---------- full DEPTH for all 24 ----------
cur.execute("""SELECT p.worktree, MIN(date(m.time_created/1000,'unixepoch')), MAX(date(m.time_created/1000,'unixepoch')),
 SUM(CASE WHEN m.type='compaction' THEN 1 ELSE 0 END)
FROM session_message m JOIN session_v2 s ON s.id=m.session_id JOIN project p ON p.id=s.project_id
WHERE m.type IN ('user','assistant','compaction') GROUP BY p.worktree;""")
DEPTH={r[0]:[r[1],r[2],r[3]] for r in cur.fetchall()}
h=re.sub(r'const DEPTH=\{.*?\};', 'const DEPTH='+json.dumps(DEPTH)+';', h, count=1, flags=re.S)

# ---------- replace the whole render section ----------
start=h.index("// monthly stacked bars"); end=h.index("const DMODELS=")
mid_start=h.index("const DMONTHS=Object.keys(DMODELS).sort();"); mid_end=h.index("</script></body></html>")
data_block=h[end:mid_start]  # DMODELS, DTOK, DFAMS, DCOLS
render = r"""
const DHRS=__DHRS__;
const DMONTHS=Object.keys(DMODELS).sort();
const NS='http://www.w3.org/2000/svg';
const fmtT=v=>v>=1e6?(v/1e6).toFixed(2)+'M':v>=1e3?(v/1e3).toFixed(0)+'k':String(v);
// ---------- tooltip ----------
const tip=document.getElementById('tip');
let tipOn=false;
function showTip(html,x,y){tip.innerHTML=html;tip.style.display='block';tipOn=true;moveTip(x,y)}
function moveTip(x,y){const r=tip.getBoundingClientRect();let L=x+14,T=y+14;if(L+r.width>innerWidth-8)L=x-r.width-14;if(T+r.height>innerHeight-8)T=y-r.height-14;tip.style.left=Math.max(4,L)+'px';tip.style.top=Math.max(4,T)+'px'}
function hideTip(){tip.style.display='none';tipOn=false}
function bindTip(el,fn){el.addEventListener('mouseenter',e=>showTip(fn(),e.clientX,e.clientY));el.addEventListener('mousemove',e=>{if(tipOn)moveTip(e.clientX,e.clientY)});el.addEventListener('mouseleave',hideTip);
el.addEventListener('touchstart',e=>{const t=e.touches[0];showTip(fn(),t.clientX,t.clientY)},{passive:true});
if(el.tabIndex<0&&!(el instanceof SVGElement))el.tabIndex=0;el.addEventListener('focus',()=>{const r=el.getBoundingClientRect();showTip(fn(),r.left,r.bottom)});el.addEventListener('blur',hideTip)}
document.addEventListener('keydown',e=>{if(e.key==='Escape')hideTip()});
document.addEventListener('touchstart',e=>{if(!e.target.closest('[data-tip]'))hideTip()},{passive:true});
const row=(l,v,c)=>`<div class="row"><span>${c?`<i class="sw" style="background:${c}"></i>`:''}${l}</span><span>${v}</span></div>`;
// ---------- theme ----------
const root=document.querySelector('.dark')||document.body.firstElementChild;const tbtn=document.getElementById('theme');
function setTheme(d){root.classList.toggle('dark',d);tbtn.textContent=d?'Dark':'Light';tbtn.setAttribute('aria-pressed',String(d));try{localStorage.setItem('pt-theme',d?'dark':'light')}catch(_){}}
(()=>{let s=null;try{s=localStorage.getItem('pt-theme')}catch(_){}setTheme(s?s==='dark':!matchMedia('(prefers-color-scheme: light)').matches)})();
tbtn.onclick=()=>setTheme(!root.classList.contains('dark'));
// ---------- cross highlight state ----------
let hotProj=null;
function setHot(name){hotProj=name;document.querySelectorAll('#mchart rect[data-s]').forEach(r=>r.classList.toggle('dim',!!name&&r.dataset.s!==name));
document.querySelectorAll('#mleg .lg').forEach(l=>l.classList.toggle('hot',!!name&&l.dataset.s===name));
document.querySelectorAll('#tb tr,#db tr').forEach(tr=>tr.classList.toggle('hot',!!name&&tr.dataset.s===name))}
const shortName=w=>{const i=TOP.indexOf(w);return i>=0?NAMES[i]:'other'};
// ---------- generic stacked bar chart ----------
function stacked(cfg){const svg=document.getElementById(cfg.svg),W=940,H=cfg.H,PL=44,PB=30,PT=10;const keys=cfg.keys,cols=cfg.cols,months=cfg.months;const hidden={};
const leg=document.getElementById(cfg.leg),reset=document.getElementById(cfg.reset);
keys.forEach((k,i)=>{const s=document.createElement('span');s.className='lg';s.dataset.s=k;s.innerHTML=`<i style="background:${cols[i]}"></i><span class="mono">${k}</span>`;
s.onclick=()=>{const vis=keys.filter(x=>!hidden[x]);if(vis.length===1&&vis[0]===k){keys.forEach(x=>hidden[x]=false)}else if(Object.values(hidden).some(Boolean)){hidden[k]=!hidden[k]}else{keys.forEach(x=>hidden[x]=x!==k)}sync();draw()};
if(cfg.hover)s.onmouseenter=()=>setHot(k),s.onmouseleave=()=>setHot(null);
bindTip(s,()=>`<b>${k}</b><div class="dim">Click to isolate, click again to restore</div>`);leg.appendChild(s)});
function sync(){keys.forEach(k=>{const el=leg.querySelector(`[data-s="${CSS.escape(k)}"]`);el.classList.toggle('off',!!hidden[k])});reset.classList.toggle('on',Object.values(hidden).some(Boolean))}
reset.onclick=()=>{keys.forEach(k=>hidden[k]=false);sync();draw()};
function draw(){svg.innerHTML='';const bw=(W-PL-20)/months.length;const vis=keys.filter(k=>!hidden[k]);
const totals=months.map(m=>vis.reduce((a,k)=>a+cfg.val(m,k),0));const maxV=cfg.pct?1:Math.max(...totals,0.001);
for(let g=0;g<=4;g++){const y=H-PB-(H-PT-PB)*g/4;const l=document.createElementNS(NS,'line');l.setAttribute('x1',PL);l.setAttribute('x2',W-20);l.setAttribute('y1',y);l.setAttribute('y2',y);l.setAttribute('stroke','currentColor');l.setAttribute('opacity','.12');svg.appendChild(l);const t=document.createElementNS(NS,'text');t.setAttribute('x',2);t.setAttribute('y',y+4);t.setAttribute('font-size','11');t.setAttribute('fill','currentColor');t.setAttribute('opacity','.6');t.textContent=cfg.pct?(g*25)+'%':(maxV*g/4).toFixed(0)+'h';svg.appendChild(t)}
months.forEach((m,i)=>{const tot=totals[i];let y0=0;const X=PL+i*bw+8;
vis.forEach(k=>{const j=keys.indexOf(k);const raw=cfg.val(m,k);const v=cfg.pct?(tot?raw/tot:0):raw;const hh=v/maxV*(H-PT-PB);if(hh<=0)return;const r=document.createElementNS(NS,'rect');r.setAttribute('x',X);r.setAttribute('y',H-PB-y0-hh);r.setAttribute('width',bw-16);r.setAttribute('height',hh);r.setAttribute('fill',cols[j]);r.dataset.s=k;
bindTip(r,()=>{const rows=vis.map(kk=>[kk,cfg.val(m,kk),keys.indexOf(kk)]).filter(x=>x[1]>0).sort((a,b)=>b[1]-a[1]);return `<b>${cfg.title(m)}</b>`+row('Total',cfg.fmt(tot))+'<hr style="border:0;border-top:1px solid var(--border);margin:6px 0">'+rows.map(x=>row(x[0]+(x[0]===k?' &larr;':''),cfg.fmt(x[1])+(tot?` (${(x[1]/tot*100).toFixed(0)}%)`:''),cols[x[2]])).join('')});
if(cfg.hover){r.addEventListener('mouseenter',()=>setHot(k));r.addEventListener('mouseleave',()=>setHot(null))}
svg.appendChild(r);y0+=hh});
const t=document.createElementNS(NS,'text');t.setAttribute('x',X+(bw-16)/2);t.setAttribute('y',H-10);t.setAttribute('font-size','11');t.setAttribute('text-anchor','middle');t.setAttribute('fill','currentColor');t.setAttribute('opacity','.65');t.textContent=m.slice(2);svg.appendChild(t);
if(!cfg.pct){const v=document.createElementNS(NS,'text');v.setAttribute('x',X+(bw-16)/2);v.setAttribute('y',H-PB-y0-4);v.setAttribute('font-size','11');v.setAttribute('text-anchor','middle');v.setAttribute('fill','currentColor');v.textContent=tot.toFixed(0)+'h';svg.appendChild(v)}});
if(hotProj)setHot(hotProj)}
draw()}
stacked({svg:'mchart',leg:'mleg',reset:'mreset',H:300,keys:NAMES,cols:COLS,months:MONTHS,hover:true,val:(m,k)=>MC[m][NAMES.indexOf(k)],fmt:v=>v.toFixed(1)+' h',title:m=>m+' hours by project'});
stacked({svg:'dchart',leg:'dleg',reset:'dreset',H:260,keys:DFAMS,cols:DCOLS,months:DMONTHS,pct:true,val:(m,k)=>DMODELS[m][k],fmt:v=>v.toLocaleString()+' msgs',title:m=>m+' assistant messages by model'});
// ---------- tokens per day grid ----------
(function(){const cal=document.getElementById('tcal');let fd=new Date(Date.UTC(2026,0,16));while(fd.getUTCDay()!==1)fd.setUTCDate(fd.getUTCDate()-1);
function lvl(v){if(v<=0)return'var(--muted)';if(v<1e6)return'color-mix(in oklab, var(--primary) 30%, var(--muted))';if(v<3e6)return'color-mix(in oklab, var(--primary) 55%, var(--muted))';if(v<8e6)return'color-mix(in oklab, var(--primary) 80%, var(--muted))';return'var(--primary)'}
const wd=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
for(let w=0;w<34;w++){const wk=document.createElement('div');wk.className='wk';for(let k=0;k<7;k++){const dt=new Date(fd.getTime());dt.setUTCDate(fd.getUTCDate()+w*7+k);const iso=dt.toISOString().slice(0,10);const c=document.createElement('div');c.className='cell';c.dataset.tip='1';c.style.width='13px';c.style.height='13px';
if(iso<'2026-01-16'||iso>'2026-09-03'){c.style.visibility='hidden'}else{const e=DTOK[iso]||[0,0,0];const hrs=DHRS[iso]||0;c.style.background=lvl(e[0]);
bindTip(c,()=>`<b>${wd[dt.getUTCDay()]} ${iso}</b>`+row('Fresh tokens',fmtT(e[0]))+row('Active',hrs.toFixed(2)+' h')+row('Cost','$'+e[1].toFixed(2))+row('Sessions',String(e[2]))+(e[0]&&hrs?row('Tokens per hour',fmtT(Math.round(e[0]/hrs))):''))}
wk.appendChild(c)}cal.appendChild(wk)}})();
// ---------- tables ----------
function makeSortable(tableId,rowsFn){const table=document.getElementById(tableId);const body=table.querySelector('tbody');const ths=[...table.querySelectorAll('th.sortable')];let key=ths.findIndex(t=>t.hasAttribute('data-sort'));if(key<0)key=1;let dir=ths[key]?.dataset.dir||'desc';
function render(){const rows=rowsFn();const t=ths[key].dataset.t==='s';rows.sort((a,b)=>{const x=a.v[key],y=b.v[key];const c=t?String(x).localeCompare(String(y)):(x-y);return dir==='asc'?c:-c});body.innerHTML='';rows.forEach(r=>body.appendChild(r.tr));ths.forEach((th,i)=>{if(i===key){th.setAttribute('data-sort','');th.dataset.dir=dir}else{th.removeAttribute('data-sort');th.removeAttribute('data-dir')}})}
ths.forEach((th,i)=>{th.onclick=()=>{if(key===i)dir=dir==='asc'?'desc':'asc';else{key=i;dir=th.dataset.t==='s'?'asc':'desc'}render()};bindTip(th,()=>`<b>Sort by ${th.textContent.trim()}</b><div class="dim">Click to toggle direction</div>`)});
render();return render}
const lbRows=LB.map(r=>{const c=COST[r[0]]||[0,0,0,0];const per=r[3]>0?c[0]/r[3]:0;const tr=document.createElement('tr');tr.dataset.s=shortName(r[0]);
tr.innerHTML=`<td class="mono">${r[0]}</td><td class="mono">${r[3].toFixed(2)}</td><td class="mono">${r[4].toFixed(1)}%</td><td class="mono">${r[1]}</td><td class="mono">$${c[0].toLocaleString(undefined,{maximumFractionDigits:0})}</td><td class="mono">${r[3]>0?'$'+per.toFixed(2):'—'}</td><td class="mono">${(c[1]/1e6).toFixed(1)}M</td><td class="mono">+${(c[2]/1000).toFixed(0)}k / -${(c[3]/1000).toFixed(0)}k</td>`;
tr.onmouseenter=()=>setHot(tr.dataset.s);tr.onmouseleave=()=>setHot(null);
bindTip(tr,()=>`<b>${r[0]}</b>`+row('Active',r[3].toFixed(2)+' h · '+r[4].toFixed(1)+'%')+row('Sessions',r[1].toLocaleString())+row('Messages',r[2].toLocaleString())+row('Msgs per session',(r[2]/r[1]).toFixed(1))+row('Cost','$'+c[0].toLocaleString(undefined,{maximumFractionDigits:2}))+row('Cost per hour',r[3]>0?'$'+per.toFixed(2):'—')+row('Fresh tokens',fmtT(c[1]))+row('Lines changed','+'+c[2].toLocaleString()+' / -'+c[3].toLocaleString()));
return {tr,v:[r[0],r[3],r[4],r[1],c[0],per,c[1],c[2]-c[3]]}});
makeSortable('lbt',()=>lbRows.slice());
let showAll=false;const sa=document.getElementById('showall');
const dpRows=LB.map(r=>{const mps=r[2]/r[1],mns=r[3]*60/r[1];const dd=DEPTH[r[0]]||['—','—',0];const tr=document.createElement('tr');tr.dataset.s=shortName(r[0]);
tr.innerHTML=`<td class="mono">${r[0]}</td><td class="mono">${mps.toFixed(1)}</td><td class="mono">${mns.toFixed(1)}</td><td class="mono">${dd[2]}</td><td class="mono">${dd[0]}</td><td class="mono">${dd[1]}</td>`;
tr.onmouseenter=()=>setHot(tr.dataset.s);tr.onmouseleave=()=>setHot(null);
const span=(dd[0]!=='—')?Math.round((new Date(dd[1])-new Date(dd[0]))/864e5)+1:0;
bindTip(tr,()=>`<b>${r[0]}</b>`+row('Sessions',String(r[1]))+row('Messages per session',mps.toFixed(1))+row('Active minutes per session',mns.toFixed(1))+row('Compactions',String(dd[2]))+row('Span',span?span+' days':'—'));
return {tr,v:[r[0],mps,mns,dd[2],dd[0],dd[1]]}});
const renderDepth=makeSortable('dpt',()=>showAll?dpRows.slice():dpRows.slice(0,14));
sa.onclick=()=>{showAll=!showAll;sa.textContent=showAll?'Show top 14':'Show all 24 projects';sa.setAttribute('aria-pressed',String(showAll));renderDepth()};
// ---------- agents/models ----------
const am=document.getElementById('am');const agTot=AGENTS.reduce((a,b)=>a+b[1],0),moTot=2405;
function bars(list,max,total){return list.map(a=>`<div class="hb" data-n="${a[0]}" data-v="${a[1]}" data-t="${total}" style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><span class="mono" style="width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${a[0]}</span><div class="hbar" style="flex:1"><i style="width:${(a[1]/max*100).toFixed(1)}%"></i></div><span class="mono">${a[1]}</span></div>`).join('')}
am.innerHTML='<p class="dim">Agents</p>'+bars(AGENTS,954,2405)+'<p class="dim" style="margin-top:12px">Models (last used per session)</p>'+bars(MODELS,883,2405);
am.querySelectorAll('.hb').forEach(el=>bindTip(el,()=>`<b>${el.dataset.n}</b>`+row('Sessions',el.dataset.v)+row('Share of all sessions',(el.dataset.v/el.dataset.t*100).toFixed(1)+'%')));
// ---------- rhythm ----------
const rhy=document.getElementById('rhy');const days=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];const mx=Math.max(...RHY.flat());const rhyTot=RHY.flat().reduce((a,b)=>a+b,0);
const dayTot=RHY.map(r=>r.reduce((a,b)=>a+b,0));const hourTot=Array.from({length:24},(_,h)=>RHY.reduce((a,r)=>a+r[h],0));
rhy.innerHTML='<span></span>'+Array.from({length:24},(_,h)=>`<span class="mono dim" style="text-align:center">${String(h).padStart(2,'0')}</span>`).join('');
RHY.forEach((r,wi)=>{const lab=document.createElement('span');lab.className='dim';lab.textContent=days[wi];rhy.appendChild(lab);
r.forEach((v,hi)=>{const t=v/mx;const c=document.createElement('div');c.className='cell';c.dataset.tip='1';c.style.background=t<=0?'var(--muted)':`color-mix(in oklab, var(--primary) ${Math.round(15+t*85)}%, var(--muted))`;
bindTip(c,()=>`<b>${days[wi]} ${String(hi).padStart(2,'0')}:00 UTC</b>`+row('Messages',v.toLocaleString())+row('Share of all',(v/rhyTot*100).toFixed(2)+'%')+row('Share of '+days[wi],dayTot[wi]?(v/dayTot[wi]*100).toFixed(1)+'%':'0%')+row('Share of '+String(hi).padStart(2,'0')+':00',hourTot[hi]?(v/hourTot[hi]*100).toFixed(1)+'%':'0%'));
rhy.appendChild(c)})});
"""
render=render.replace("__DHRS__", json.dumps(DHRS))
h=h[:start]+data_block+render+h[mid_end:]
open(p,"w").write(h)
print("bytes:",len(h))
