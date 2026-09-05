import { existsSync, readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import { LEDGER_PATH, PART_BACKFILL } from "./config.ts";
import { relFile } from "./util.ts";

export type SessionMeta = {
  wt: string;
  agent: string;
  child: boolean;
  cost: number;
  fresh: number;
  cache_r: number;
  cache_w: number;
  add: number;
  dele: number;
  has_lines: boolean;
  model: string | null;
  created: number;
  dir: string;
  parent: string | null;
};

export type EditEv = [number, string];

type SessRow = {
  id: string;
  wt: string;
  agent: string;
  child: number;
  cost: number;
  fresh: number;
  cache_r: number;
  cache_w: number;
  adds: number;
  dels: number;
  has_lines: number;
  model: string | null;
  created: number;
  dir: string;
  parent: string | null;
};

export function loadSessions(db: Database): Map<string, SessionMeta> {
  const rows = db
    .query(
      `SELECT s.id AS id, p.worktree AS wt,
              COALESCE(NULLIF(s.agent,''),'(unset)') AS agent,
              s.parent_id IS NOT NULL AS child,
              COALESCE(s.cost,0) AS cost,
              COALESCE(s.tokens_input,0)+COALESCE(s.tokens_output,0)+COALESCE(s.tokens_reasoning,0) AS fresh,
              COALESCE(s.tokens_cache_read,0) AS cache_r,
              COALESCE(s.tokens_cache_write,0) AS cache_w,
              COALESCE(s.summary_additions,0) AS adds,
              COALESCE(s.summary_deletions,0) AS dels,
              s.summary_additions IS NOT NULL AS has_lines,
              s.model AS model, s.time_created AS created,
              COALESCE(s.directory, p.worktree) AS dir, s.parent_id AS parent
       FROM session_v2 s JOIN project p ON p.id=s.project_id
       ORDER BY s.time_created, s.id`,
    )
    .all() as SessRow[];
  const meta = new Map<string, SessionMeta>();
  for (const r of rows) {
    meta.set(r.id, {
      wt: r.wt,
      agent: r.agent,
      child: Boolean(r.child),
      cost: r.cost,
      fresh: r.fresh,
      cache_r: r.cache_r,
      cache_w: r.cache_w,
      add: r.adds,
      dele: r.dels,
      has_lines: Boolean(r.has_lines),
      model: r.model,
      created: r.created,
      dir: r.dir,
      parent: r.parent,
    });
  }
  return meta;
}

export function partEdits(
  db: Database,
  meta: Map<string, SessionMeta>,
): Map<string, EditEv[]> {
  const out = new Map<string, EditEv[]>();
  if (!PART_BACKFILL) return out;
  try {
    const rows = db
      .query(
        `SELECT session_id AS sid, time_created AS tc, data FROM part
         WHERE (data LIKE '%"tool":"edit"%' OR data LIKE '%"tool":"write"%' OR data LIKE '%"tool":"apply_patch"%')
           AND data LIKE '%"filePath"%'`,
      )
      .all() as { sid: string; tc: number; data: string }[];
    for (const { sid, tc, data } of rows) {
      const m = meta.get(sid);
      if (!m) continue;
      let st: Record<string, unknown> = {};
      try {
        const o = JSON.parse(data) as { state?: Record<string, unknown> };
        st = o.state ?? {};
      } catch {
        continue;
      }
      const input = (st.input ?? {}) as Record<string, unknown>;
      const raw = (input.filePath ?? input.path) as string | undefined;
      const f = relFile(raw, m.dir);
      if (f) {
        let list = out.get(sid);
        if (!list) {
          list = [];
          out.set(sid, list);
        }
        list.push([tc / 1000, f]);
      }
    }
  } catch {
    return out;
  }
  return out;
}

export type LedgerInfo = {
  lines: number;
  first: number | null;
  last: number | null;
  sessions: number;
};

export function ledgerEdits(
  meta: Map<string, SessionMeta>,
): [Map<string, EditEv[]>, LedgerInfo] {
  const out = new Map<string, EditEv[]>();
  const info: LedgerInfo = { lines: 0, first: null, last: null, sessions: 0 };
  if (!existsSync(LEDGER_PATH)) return [out, info];
  const seen = new Set<string>();
  const sess = new Set<string>();
  const raw = readFileSync(LEDGER_PATH, "utf8");
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const key = e.call
      ? `${e.call}\x1f${e.file}`
      : `${e.session}\x1f${e.ts}\x1f${e.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    info.lines += 1;
    const ts = e.ts as number;
    info.first = Math.min(info.first ?? ts, ts);
    info.last = Math.max(info.last ?? 0, ts);
    sess.add(e.session as string);
    const m = meta.get(e.session as string);
    if (!m) continue;
    const f = relFile(
      e.file as string | undefined,
      (e.dir as string | undefined) || m.dir,
    );
    if (f) {
      let list = out.get(e.session as string);
      if (!list) {
        list = [];
        out.set(e.session as string, list);
      }
      list.push([ts / 1000, f]);
    }
  }
  info.sessions = sess.size;
  return [out, info];
}
