// data.json + template.html -> HTML string. Formatting only.
import { readFile } from "node:fs/promises";
import { TEMPLATE } from "./config.ts";

const JSON_KEYS = [
  "RANGE",
  "DTOK",
  "CM",
  "DAYW",
  "DAYM",
  "DAYU",
  "RHYD",
  "SESS",
  "SESS_COLS",
  "IDX",
  "PH",
  "PH_COLS",
  "CYC",
  "CYC_COLS",
  "PSRC",
  "LEDGER",
] as const;

type Meta = {
  generated: string;
  start: string;
  end: string;
  win_start: string;
  sessions: number;
  messages: number;
  total_hr: number;
  cost: number;
  fresh_tokens: number;
  cache_read: number;
  cache_write: number;
  prompts_top: number;
  replies: number;
  active_days: number;
  span_days: number;
  top_project: string;
  top_hr: number;
  top_pct: number;
  top_sessions: number;
  busiest_day: string;
  busiest_hr: number;
  busiest_msgs: number;
  peak_month: string;
  peak_month_hr: number;
  repos: number;
  ship_days?: number;
};

function tokens(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}k`;
  return String(Math.trunc(v));
}

function commas(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function monthName(ym: string): string {
  const [y, mo] = ym.split("-").map(Number);
  return new Date(Date.UTC(y, (mo ?? 1) - 1, 1)).toLocaleString("en-US", {
    month: "long",
    timeZone: "UTC",
  });
}

function weeksBetween(start: string, end: string): number {
  const first = new Date(`${start}T00:00:00Z`);
  const weekday = (first.getUTCDay() + 6) % 7;
  const monday = first.getTime() - weekday * 86400000;
  const last = new Date(`${end}T00:00:00Z`).getTime();
  return Math.floor((last - monday) / 86400000 / 7) + 1;
}

export async function renderDeck(
  data: Record<string, unknown>,
  templatePath = TEMPLATE,
  live = false,
): Promise<string> {
  const m = data.meta as Meta;
  let h = await readFile(templatePath, "utf8");
  const payload: Record<string, unknown> = {
    ...data,
    RANGE: {
      start: m.start,
      end: m.end,
      winStart: m.win_start,
      weeks: weeksBetween(m.start, m.end),
      sessions: m.sessions,
    },
  };
  for (const name of JSON_KEYS) {
    const json = JSON.stringify(payload[name]);
    if (json === undefined) throw new Error(`missing dataset ${name}`);
    h = h.replaceAll(`@@${name}@@`, json);
  }
  const kpi: Record<string, string> = {
    badge: `${m.total_hr.toFixed(2)} h · ${commas(m.sessions)} sess · $${commas(m.cost)} · ${tokens(m.fresh_tokens)} tok`,
    start: m.start,
    end: m.end,
    win_start: m.win_start,
    active_days: String(m.active_days),
    span_days: String(m.span_days),
    total_hr: m.total_hr.toFixed(2),
    messages: commas(m.messages),
    autonomy: (m.replies / Math.max(m.prompts_top, 1)).toFixed(1),
    fresh: tokens(m.fresh_tokens),
    cache_read: tokens(m.cache_read),
    cache_write: tokens(m.cache_write),
    cost: commas(m.cost),
    cost_per_hr: (m.cost / Math.max(m.total_hr, 0.01)).toFixed(2),
    peak_month_name: monthName(m.peak_month),
    peak_month_hr: m.peak_month_hr.toFixed(1),
    repos: String(m.repos),
    ship_days: String(m.ship_days ?? 7),
    sessions: commas(m.sessions),
  };
  const sess = data.SESS as unknown[][];
  const cols = Object.fromEntries(
    (data.SESS_COLS as string[]).map((c, i) => [c, i]),
  );
  const edits = sess.reduce((a, r) => a + Number(r[cols.edits] ?? 0), 0);
  const editSess = sess.filter((r) => Number(r[cols.edits] ?? 0) > 0).length;
  const cm = data.CM as { recs: unknown[]; manual: [number, number, number][] };
  const recN = cm.recs.length;
  const manN = cm.manual.filter((x) => !x[2]).length;
  const commitN = recN + manN;
  kpi.edits = commas(edits);
  kpi.edits_per_hr = (edits / Math.max(m.total_hr, 0.01)).toFixed(1);
  kpi.edits_sess = commas(editSess);
  kpi.commits = String(recN);
  kpi.commits_share = ((100 * recN) / Math.max(commitN, 1)).toFixed(0);
  kpi.commits_total = String(commitN);
  kpi.commits_manual = String(manN);
  const cyc = data.CYC as unknown[][];
  const ccols = Object.fromEntries(
    (data.CYC_COLS as string[]).map((c, i) => [c, i]),
  );
  const judged = cyc.filter(
    (c) =>
      !sess[Number(c[ccols.sess] ?? 0)]?.[cols.child] &&
      Number(c[ccols.a] ?? 0) > 0 &&
      Number(c[ccols.tedits] ?? 0) > 0 &&
      c[ccols.tpaths],
  );
  const shipped = judged.filter((c) => c[ccols.tship]);
  kpi.tts = shipped.length
    ? (
        judged.reduce((a, c) => a + Number(c[ccols.u] ?? 0), 0) / shipped.length
      ).toFixed(1)
    : "—";
  kpi.tjudged = commas(judged.length);
  kpi.tshipped = commas(shipped.length);
  for (const [k, v] of Object.entries(kpi)) {
    h = h.replaceAll(`@@${k}@@`, v);
  }
  // The Contribute button only exists on the live server; the snapshot
  // hides it — there is no local endpoint to post to.
  h = h.replaceAll("@@LIVE@@", live ? "" : 'style="display:none"');
  const left = h.match(/@@[a-zA-Z_]+@@/g);
  if (left)
    throw new Error(
      `unfilled placeholders: ${[...new Set(left)].sort().join(", ")}`,
    );
  return h;
}
