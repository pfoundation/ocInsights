// Derive template.html from a built deck by replacing embedded data with placeholders.
import { readFileSync, writeFileSync } from "node:fs";
const DATA_CONSTS = [
  "MONTHS",
  "HM",
  "HD",
  "PORDER",
  "LB",
  "COST",
  "DEPTH",
  "AGENTS",
  "MODELS",
  "RHY",
  "DMODELS",
  "DTOK",
  "UA",
  "UAM",
  "PROD",
  "SHIP",
  "CM",
  "DHRS",
];
const DROP_CONSTS = ["TOP"];

function jsonEnd(s: string, i: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let j = i;
  while (j < s.length) {
    const c = s[j]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0) return j + 1;
    } else if (depth === 0 && c === ";") return j;
    j += 1;
  }
  throw new Error("unterminated value");
}

export function makeTemplate(src: string, dst: string): string {
  let h = readFileSync(src, "utf8");
  for (const name of [...DATA_CONSTS, ...DROP_CONSTS]) {
    const key = `const ${name}=`;
    const i = h.indexOf(key);
    const count = h.split(key).length - 1;
    if (count !== 1) throw new Error(`${name}: expected 1, found ${count}`);
    const j = jsonEnd(h, i + key.length);
    if (h[j] !== ";") throw new Error(`${name}: ${h.slice(j, j + 20)}`);
    const repl = DROP_CONSTS.includes(name) ? "" : `const ${name}=@@${name}@@`;
    h =
      h.slice(0, i) + repl + h.slice(j + (DROP_CONSTS.includes(name) ? 1 : 0));
  }

  const rep = (old: string, neu: string, n = 1) => {
    const c = h.split(old).length - 1;
    if (c !== n)
      throw new Error(
        `${JSON.stringify(old.slice(0, 60))}: expected ${n}, found ${c}`,
      );
    h = h.replaceAll(old, neu);
  };

  // Tolerant variant: newer markup the legacy reference predates.
  const repOpt = (old: string, neu: string) => {
    const c = h.split(old).length - 1;
    if (c > 1)
      throw new Error(
        `${JSON.stringify(old.slice(0, 60))}: expected 0-1, found ${c}`,
      );
    h = h.replaceAll(old, neu);
  };

  rep(
    "const MONTHS=@@MONTHS@@;",
    "const RANGE=@@RANGE@@;\nconst MONTHS=@@MONTHS@@;",
  );
  rep(
    "let t=Date.UTC(2026,5,6);const end=Date.UTC(2026,8,3);",
    "let t=Date.parse(RANGE.winStart);const end=Date.parse(RANGE.end);",
    2,
  );
  rep(
    "let fd=new Date(Date.UTC(2026,0,16));",
    "let fd=new Date(Date.parse(RANGE.start));",
  );
  rep("for(let w=0;w<34;w++)", "for(let w=0;w<RANGE.weeks;w++)");
  rep(
    "if(iso<'2026-01-16'||iso>'2026-09-03')",
    "if(iso<RANGE.start||iso>RANGE.end)",
  );
  rep("bars(AGENTS,954,2405)", "bars(AGENTS,AGENTS[0][1],RANGE.sessions)");
  rep("bars(MODELS,883,2405)", "bars(MODELS,MODELS[0][1],RANGE.sessions)");
  rep("moTot=2405;", "moTot=RANGE.sessions;");
  rep("818.35 h · 2,405 sess · $14,737 · 202.6M tok", "@@badge@@");
  rep("2026-01-16 to 2026-09-03.", "@@start@@ to @@end@@.");
  rep("173 active days of 231", "@@active_days@@ active days of @@span_days@@");
  rep(
    '<div class="kpi">818.35 h</div>',
    '<div class="kpi">@@total_hr@@ h</div>',
  );
  rep("91,313 messages", "@@messages@@ messages");
  rep(
    '<div class="kpi">12.7&times;</div>',
    '<div class="kpi">@@autonomy@@&times;</div>',
  );
  rep(
    "6,538 prompts by you &middot; 83,312 by agents",
    "@@prompts_top@@ prompts by you &middot; @@replies@@ by agents",
  );
  rep('<div class="kpi">202.6M</div>', '<div class="kpi">@@fresh@@</div>');
  rep(
    "13.6B cache reads · 947M cache writes",
    "@@cache_read@@ cache reads · @@cache_write@@ cache writes",
  );
  rep(
    '<p class="cdesc mono">/home/ubuntu/dev/datastudio</p>',
    '<p class="cdesc mono">@@top_project@@</p>',
  );
  rep('<div class="kpi">402.79 h</div>', '<div class="kpi">@@top_hr@@ h</div>');
  rep("49.2% · 1,092 sessions", "@@top_pct@@% · @@top_sessions@@ sessions");
  rep('<div class="kpi">$14,732</div>', '<div class="kpi">$@@cost@@</div>');
  rep(
    "202.6M fresh tokens · $18.01 per active hour",
    "@@fresh@@ fresh tokens · $@@cost_per_hr@@ per active hour",
  );
  rep(
    '<p class="cdesc mono">2026-03-20</p>',
    '<p class="cdesc mono">@@busiest_day@@</p>',
  );
  rep(
    '<div class="kpi">24.02 h</div>',
    '<div class="kpi">@@busiest_hr@@ h</div>',
  );
  rep(
    "3,189 messages · March peak",
    "@@busiest_msgs@@ messages · @@busiest_month@@ peak",
  );
  rep(
    "March is the peak at 164.4 h",
    "@@peak_month_name@@ is the peak at @@peak_month_hr@@ h",
  );
  rep("2026-06-06 to 2026-09-03", "@@win_start@@ to @@end@@", 2);
  rep(
    "read straight from the 21 repositories",
    "read straight from the @@repos@@ repositories",
  );
  repOpt(
    '<button class="btn" id="contrib" style="display:none" title="Share anonymised cycle facts with the global scorecard">',
    '<button class="btn" id="contrib" @@LIVE@@ title="Share anonymised cycle facts with the global scorecard">',
  );
  repOpt(
    '<div id="cpanel" class="cpanel" style="display:none">',
    '<div id="cpanel" class="cpanel" @@LIVE@@>',
  );

  const body = h.slice(0, h.indexOf("<script>"));
  const left = [...new Set(body.match(/20\d\d-\d\d-\d\d/g) ?? [])].sort();
  if (left.length)
    throw new Error(`dates still baked into the page body: ${left.join(", ")}`);
  writeFileSync(dst, h);
  const n = (h.match(/@@[a-zA-Z_]+@@/g) ?? []).length;
  return `${dst}: ${h.length.toLocaleString("en-US")} bytes, ${n} placeholders`;
}
