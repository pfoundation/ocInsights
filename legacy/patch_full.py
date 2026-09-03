import json
p="/tmp/opencode/opencode_time_full.html"
h=open(p).read()
nd=json.load(open("/tmp/opencode/new_data.json"))

def rep(old, new):
    global h
    assert old in h, "ANCHOR MISSING: "+old[:70]
    h=h.replace(old, new, 1)

# 1. grid cols
rep(".kpis{grid-template-columns:repeat(4,1fr)}", ".kpis{grid-template-columns:repeat(5,1fr)}")
rep("@media(max-width:950px){.kpis{grid-template-columns:1fr 1fr}",
    "@media(max-width:1100px){.kpis{grid-template-columns:repeat(3,1fr)}}@media(max-width:700px){.kpis{grid-template-columns:1fr 1fr}")
# 2. badge
rep("818.35 h · 2,404 sess · $14,732", "818.35 h · 2,405 sess · $14,737 · 202.6M tok")
# 3. KPI: add tokens card after Total active card, refresh cost sub
rep('<div class="ksub mono">91,241 messages</div></div></div>',
    '<div class="ksub mono">91,241 messages</div></div></div>\n<div class="card"><div class="chead"><p class="ctitle">Fresh tokens</p><p class="cdesc">Input + output + reasoning</p></div><div class="cbody"><div class="kpi">202.6M</div><div class="ksub mono">13.6B cache reads · 947M cache writes</div></div></div>')
rep("196.7 M tokens · $18.00 per active hour", "202.6M fresh tokens · $18.01 per active hour")
# 4. new cards before two-col section
rep('<div class="grid two">', '''<div class="card" style="margin-top:12px"><div class="chead"><p class="ctitle">Models over time</p><p class="cdesc">Assistant message share per month, grouped by model family. January ran on OpenRouter and Gemini; September runs on Grok, Fable and Spark.</p></div><div class="cbody"><div id="dleg"></div><svg id="dchart" viewBox="0 0 940 260" width="100%"></svg></div></div>
<div class="card" style="margin-top:12px"><div class="chead"><p class="ctitle">Tokens per day</p><p class="cdesc">Fresh tokens per day by session creation day. Sessions spanning midnight (7%) attribute to their start day.</p></div><div class="cbody"><div class="cal" id="tcal" style="flex-wrap:wrap"></div><p class="dim" style="margin:10px 0 0">Scale: none · &lt;1M · &lt;3M · &lt;8M · 8M or more fresh tokens</p></div></div>
<div class="grid two">''')
# 5. JS data + renderers before rhythm section
rep("// leaderboard",
"""const DMODELS="""+json.dumps(nd["models"])+""";
const DTOK="""+json.dumps(nd["tok"])+""";
const DFAMS=["claude-opus-4-6","claude-opus-4-7","claude-opus-4-8","claude-opus-5","claude-fable","grok-","other"];
const DCOLS=["var(--chart-1)","var(--chart-2)","var(--chart-3)","var(--chart-4)","var(--chart-5)","#6b7280","#9ca3af"];
const DMONTHS=Object.keys(DMODELS).sort();
(function(){const svg=document.getElementById('dchart'),NS='http://www.w3.org/2000/svg',W=940,H=260,PL=44,PB=30,PT=10;
const bw=(W-PL-20)/DMONTHS.length;
const lg=document.getElementById('dleg');
DFAMS.forEach((f,i)=>{const s=document.createElement('span');s.className='lg';s.innerHTML=`<i style="background:${DCOLS[i]}"></i><span class="mono">${f}</span>`;lg.appendChild(s)});
DMONTHS.forEach((m,i)=>{const tot=DFAMS.reduce((a,f)=>a+DMODELS[m][f],0);let y0=0;const X=PL+i*bw+8;
DFAMS.forEach((f,j)=>{const sh=tot?DMODELS[m][f]/tot:0;const hh=sh*(H-PT-PB);const r=document.createElementNS(NS,'rect');r.setAttribute('x',X);r.setAttribute('y',H-PB-y0-hh);r.setAttribute('width',bw-16);r.setAttribute('height',Math.max(hh,0));r.setAttribute('fill',DCOLS[j]);const t=document.createElementNS(NS,'title');t.textContent=`${m} ${f}: ${DMODELS[m][f].toLocaleString()} msgs (${(sh*100).toFixed(1)}%)`;r.appendChild(t);svg.appendChild(r);y0+=hh});
const t=document.createElementNS(NS,'text');t.setAttribute('x',X+(bw-16)/2);t.setAttribute('y',H-10);t.setAttribute('font-size','11');t.setAttribute('text-anchor','middle');t.setAttribute('fill','currentColor');t.setAttribute('opacity','.65');t.textContent=m.slice(2);svg.appendChild(t)})})();
(function(){const cal=document.getElementById('tcal');let fd=new Date('2026-01-16');while(fd.getDay()!==1)fd.setDate(fd.getDate()-1);
function lvl(v){if(v<=0)return'var(--muted)';if(v<1e6)return'color-mix(in oklab, var(--primary) 30%, var(--muted))';if(v<3e6)return'color-mix(in oklab, var(--primary) 55%, var(--muted))';if(v<8e6)return'color-mix(in oklab, var(--primary) 80%, var(--muted))';return'var(--primary)'}
for(let w=0;w<34;w++){const wk=document.createElement('div');wk.className='wk';for(let k=0;k<7;k++){const dt=new Date(fd);dt.setDate(fd.getDate()+w*7+k);const iso=dt.toISOString().slice(0,10);const c=document.createElement('div');c.className='cell';c.style.width='13px';c.style.height='13px';
if(iso<'2026-01-16'||iso>'2026-09-03'){c.style.visibility='hidden'}else{const e=DTOK[iso]||[0,0,0];c.style.background=lvl(e[0]);c.title=`${iso}: ${(e[0]/1e6).toFixed(2)}M tokens · $${e[1].toFixed(2)} · ${e[2]} sess`}
wk.appendChild(c)}cal.appendChild(wk)}})();
// leaderboard""")
# 6. footnote: document token definition + per-message note
rep("Cost and token sums come straight from session records.",
    "Cost and token sums come straight from session records. Fresh tokens equal input plus output plus reasoning; cache reads (13.6B) are reported separately. Models over time counts assistant messages by the model field on each message (session records only keep the last model used).")
open(p,"w").write(h)
print("patched bytes:", len(h))
