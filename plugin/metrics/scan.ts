import type { Database } from "bun:sqlite";
import {
  ABORT_RE,
  AGENT_RE,
  COMMIT_RE,
  EDIT_TOOLS,
  HEARTBEAT_CAP_MS,
  HEARTBEAT_SEED_MS,
  MIGRATION_RE,
  VARIANT_NONE,
  VERIFY_RE,
} from "./config.ts";
import { canon, Counter, dayOf, pairKey, relFile, roleOf } from "./util.ts";
import type { SessionMeta } from "./sessions.ts";

export type Phase = {
  mp: Counter<string>;
  ms: number;
  u: number;
  a: number;
  err: number;
  edits: number;
  eerr: number;
  files: Set<string>;
  reads: number;
  bash: number;
  tools: number;
  terr: number;
  abort: number;
  ver: number;
  commit: number;
  lat: number[];
};

export type Cycle = Phase & {
  first: number;
  last: number;
  ev: [number, number][];
  edit_ev: [number, string][];
  has_build: boolean;
  ph: Map<number, Phase>;
  last_edit: number | null;
  last_ver: number | null;
};

export type Sess = {
  mp: Counter<string>;
  u: number;
  a: number;
  err: number;
  ms: number;
  last: number | null;
  ev: [number, number][];
  edits: number;
  eerr: number;
  files: Set<string>;
  reads: number;
  bash: number;
  tools: number;
  terr: number;
  abort: number;
  ver: number;
  commit: number;
  edit_ev: [number, string][];
  first: number | null;
  comp: number;
  day0: string | null;
  cur: number | null;
  cyc: Cycle[];
  prev_typ: string | null;
  ph: Map<number, Phase>;
  last_edit: number | null;
  last_ver: number | null;
  seq: number;
  lat: number[];
};

function newPhase(): Phase {
  return {
    mp: new Counter(),
    ms: 0,
    u: 0,
    a: 0,
    err: 0,
    edits: 0,
    eerr: 0,
    files: new Set(),
    reads: 0,
    bash: 0,
    tools: 0,
    terr: 0,
    abort: 0,
    ver: 0,
    commit: 0,
    lat: [],
  };
}

function newCycle(firstTs: number): Cycle {
  return {
    ...newPhase(),
    first: firstTs,
    last: firstTs,
    ev: [],
    edit_ev: [],
    has_build: false,
    ph: new Map(),
    last_edit: null,
    last_ver: null,
  };
}

function newSess(): Sess {
  return {
    ...newPhase(),
    last: null,
    ev: [],
    edit_ev: [],
    first: null,
    comp: 0,
    day0: null,
    cur: null,
    cyc: [],
    prev_typ: null,
    ph: new Map(),
    last_edit: null,
    last_ver: null,
    seq: 0,
  };
}

function getPh(map: Map<number, Phase>, r: number): Phase {
  let p = map.get(r);
  if (!p) {
    p = newPhase();
    map.set(r, p);
  }
  return p;
}

function getSess(S: Map<string, Sess>, sid: string): Sess {
  let s = S.get(sid);
  if (!s) {
    s = newSess();
    S.set(sid, s);
  }
  return s;
}

function nestTrio(
  outer: Map<string, Map<string, [number, number, number]>>,
  a: string,
  b: string,
): [number, number, number] {
  let inner = outer.get(a);
  if (!inner) {
    inner = new Map();
    outer.set(a, inner);
  }
  let t = inner.get(b);
  if (!t) {
    t = [0, 0, 0];
    inner.set(b, t);
  }
  return t;
}

function getHours(m: Map<string, number[]>, day: string): number[] {
  let h = m.get(day);
  if (!h) {
    h = Array.from({ length: 24 }, () => 0);
    m.set(day, h);
  }
  return h;
}

// state.error is {type, message} on tool parts; be liberal in what we accept.
function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const d = o.data as Record<string, unknown> | undefined;
    if (d && typeof d.message === "string") return d.message;
    if (typeof o.message === "string") return o.message;
    if (typeof o.name === "string") return o.name;
    try {
      return JSON.stringify(e);
    } catch {
      return "";
    }
  }
  return "";
}

function bump(
  targets: {
    tools?: boolean;
    terr?: boolean;
    abort?: boolean;
    edits?: boolean;
    eerr?: boolean;
    reads?: boolean;
    bash?: boolean;
    ver?: boolean;
    commit?: boolean;
  },
  s: Sess,
  ph: Phase,
  cy: Cycle,
  cyph: Phase,
): void {
  const keys = Object.keys(targets) as (keyof typeof targets)[];
  for (const k of keys) {
    if (!targets[k]) continue;
    (s[k as keyof Sess] as number) += 1;
    (ph[k as keyof Phase] as number) += 1;
    (cy[k as keyof Cycle] as number) += 1;
    (cyph[k as keyof Phase] as number) += 1;
  }
}

export type ScanResult = {
  S: Map<string, Sess>;
  day_wt_ms: Map<string, Counter<string>>;
  day_sess: Map<string, Set<string>>;
  rhythm: number[][];
  models_day: Map<string, Counter<string>>;
  ua_wt: Map<string, [number, number, number]>;
  ua_month: Map<string, [number, number, number]>;
  depth: Map<string, [string, string, number]>;
  n_msgs: number;
  day_wt_role: Map<string, Map<string, [number, number, number]>>;
  rhythm_day: Map<string, number[]>;
  day_u: Map<string, [number, number, number]>;
  models_day_role: Map<string, Map<string, [number, number, number]>>;
  month_edits: Map<string, [number, number]>;
  last_edit_ms: number;
};

type MsgRow = { sid: string; typ: string; data: string; tc: number };

export function scanMessages(
  db: Database,
  meta: Map<string, SessionMeta>,
  winStartMs: number,
): ScanResult {
  const S = new Map<string, Sess>();
  const day_wt_ms = new Map<string, Counter<string>>();
  const day_wt_role = new Map<string, Map<string, [number, number, number]>>();
  const rhythm_day = new Map<string, number[]>();
  const day_u = new Map<string, [number, number, number]>();
  const models_day_role = new Map<
    string,
    Map<string, [number, number, number]>
  >();
  const day_sess = new Map<string, Set<string>>();
  const rhythm = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0),
  );
  const models_day = new Map<string, Counter<string>>();
  const ua_wt = new Map<string, [number, number, number]>();
  const ua_month = new Map<string, [number, number, number]>();
  const depth = new Map<string, [string, string, number]>();
  const month_edits = new Map<string, [number, number]>();
  let last_edit_ms = 0;
  let n_msgs = 0;

  const q = db.query(
    `SELECT session_id AS sid, type AS typ, data, time_created AS tc
     FROM session_message
     WHERE type IN ('user','assistant','compaction')
     ORDER BY session_id, time_created, id`,
  );

  for (const row of q.iterate() as Iterable<MsgRow>) {
    const { sid, typ, data, tc } = row;
    const m = meta.get(sid);
    if (!m) continue;
    const wt = m.wt;
    const day = dayOf(tc);
    let d = depth.get(wt);
    if (!d) {
      d = [day, day, 0];
      depth.set(wt, d);
    }
    if (day < d[0]) d[0] = day;
    if (day > d[1]) d[1] = day;
    if (typ === "compaction") {
      d[2] += 1;
      getSess(S, sid).comp += 1;
      continue;
    }
    n_msgs += 1;
    const s = getSess(S, sid);
    const inc =
      s.last === null
        ? HEARTBEAT_SEED_MS
        : Math.min(tc - s.last, HEARTBEAT_CAP_MS);
    if (s.first === null) {
      s.first = tc / 1000;
      s.day0 = day;
    }
    const old_cur = s.cur;
    if (typ === "assistant") {
      const am = AGENT_RE.exec(data.slice(0, 400));
      if (am) s.cur = roleOf(am[1]!);
    }
    const r = s.cur !== null ? s.cur : roleOf(m.agent);
    if (s.cyc.length === 0) {
      s.cyc.push(newCycle(tc / 1000));
    } else if (
      typ === "assistant" &&
      r === 1 &&
      old_cur !== null &&
      old_cur !== 1 &&
      s.cyc[s.cyc.length - 1]!.has_build
    ) {
      const neu = newCycle(tc / 1000);
      if (s.prev_typ === "user") {
        const old = s.cyc[s.cyc.length - 1]!;
        old.u -= 1;
        if (old.ph.has(old_cur)) old.ph.get(old_cur)!.u -= 1;
        neu.u += 1;
        getPh(neu.ph, 1).u += 1;
      }
      s.cyc.push(neu);
    }
    const cy = s.cyc[s.cyc.length - 1]!;
    if (s.cur === 2) cy.has_build = true;
    const cyph = getPh(cy.ph, r);
    const ph = getPh(s.ph, r);
    ph.ms += inc;
    cy.ms += inc;
    cyph.ms += inc;
    cy.ev.push([tc / 1000, inc]);
    cy.last = tc / 1000;
    const dr = nestTrio(day_wt_role, day, wt);
    dr[0] += inc;
    if (r) dr[r] += inc;
    getHours(rhythm_day, day)[new Date(tc).getUTCHours()]! += 1;
    s.last = tc;
    s.ms += inc;
    s.ev.push([tc / 1000, inc]);
    let dwt = day_wt_ms.get(day);
    if (!dwt) {
      dwt = new Counter();
      day_wt_ms.set(day, dwt);
    }
    dwt.add(wt, inc);
    let ds = day_sess.get(day);
    if (!ds) {
      ds = new Set();
      day_sess.set(day, ds);
    }
    ds.add(sid);
    const t = new Date(tc);
    rhythm[t.getUTCDay()]![t.getUTCHours()]! += 1;
    const month = day.slice(0, 7);
    if (typ === "user") {
      s.u += 1;
      ph.u += 1;
      cy.u += 1;
      cyph.u += 1;
      const k = m.child ? 1 : 0;
      let ua = ua_wt.get(wt);
      if (!ua) {
        ua = [0, 0, 0];
        ua_wt.set(wt, ua);
      }
      ua[k] += 1;
      let uam = ua_month.get(month);
      if (!uam) {
        uam = [0, 0, 0];
        ua_month.set(month, uam);
      }
      uam[k] += 1;
      let du = day_u.get(day);
      if (!du) {
        du = [0, 0, 0];
        day_u.set(day, du);
      }
      du[k] += 1;
      s.prev_typ = "user";
      continue;
    }
    s.a += 1;
    ph.a += 1;
    cy.a += 1;
    cyph.a += 1;
    {
      let ua = ua_wt.get(wt);
      if (!ua) {
        ua = [0, 0, 0];
        ua_wt.set(wt, ua);
      }
      ua[2] += 1;
      let uam = ua_month.get(month);
      if (!uam) {
        uam = [0, 0, 0];
        ua_month.set(month, uam);
      }
      uam[2] += 1;
      let du = day_u.get(day);
      if (!du) {
        du = [0, 0, 0];
        day_u.set(day, du);
      }
      du[2] += 1;
    }
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const mm = (o.model ?? {}) as {
      id?: string;
      providerID?: string;
      variant?: string;
    };
    const model = canon(mm.id ?? "(unlisted)");
    const prov = mm.providerID ?? "(unlisted)";
    const pk = pairKey(model, prov, mm.variant ?? VARIANT_NONE);
    s.mp.add(pk);
    ph.mp.add(pk);
    cy.mp.add(pk);
    cyph.mp.add(pk);
    if (tc >= winStartMs) {
      let md = models_day.get(day);
      if (!md) {
        md = new Counter();
        models_day.set(day, md);
      }
      md.add(model + "|" + prov);
    }
    const mdr = nestTrio(models_day_role, day, model + "|" + prov);
    mdr[0] += 1;
    if (r) mdr[r] += 1;
    if (o.error) {
      s.err += 1;
      ph.err += 1;
      cy.err += 1;
      cyph.err += 1;
    }
    // Step latency: model time per assistant message. Valid steps only —
    // time.completed is a migration backfill before Mar 2026 and anything
    // over the heartbeat cap sat open on a human (permission/question wait).
    const tm = (o.time ?? {}) as { created?: number; completed?: number };
    if (typeof tm.created === "number" && typeof tm.completed === "number") {
      const stepMs = tm.completed - tm.created;
      if (stepMs > 0 && stepMs <= HEARTBEAT_CAP_MS) {
        s.lat.push(stepMs);
        cy.lat.push(stepMs);
        cyph.lat.push(stepMs);
      }
    }
    const content = (o.content as unknown[] | undefined) ?? [];
    for (const partRaw of content) {
      const part = partRaw as Record<string, unknown>;
      if (part.type !== "tool") continue;
      const name = (part.name as string | undefined) ?? "?";
      const st = (part.state ?? {}) as Record<string, unknown>;
      const status = st.status;
      s.seq += 1;
      // ordering within a message (and across same-ms messages) for last_edit/last_ver
      const tSec = tc / 1000 + s.seq * 1e-9;
      bump({ tools: true }, s, ph, cy, cyph);
      let isAbort = false;
      let isMigration = false;
      if (status === "error") {
        const msg = errMsg(st.error);
        if (MIGRATION_RE.test(msg)) isMigration = true;
        else if (ABORT_RE.test(msg)) isAbort = true;
        if (isAbort) bump({ abort: true }, s, ph, cy, cyph);
        else if (!isMigration) bump({ terr: true }, s, ph, cy, cyph);
      }
      if (EDIT_TOOLS.has(name)) {
        bump({ edits: true }, s, ph, cy, cyph);
        if (status === "error" && !isAbort && !isMigration)
          bump({ eerr: true }, s, ph, cy, cyph);
        if (s.last_edit === null || tSec > s.last_edit) s.last_edit = tSec;
        if (cy.last_edit === null || tSec > cy.last_edit) cy.last_edit = tSec;
        const input = (st.input ?? {}) as Record<string, unknown>;
        const f = (st.title || input.filePath || input.path) as
          string | undefined;
        let me = month_edits.get(month);
        if (!me) {
          me = [0, 0];
          month_edits.set(month, me);
        }
        me[0] += 1;
        last_edit_ms = Math.max(last_edit_ms, tc);
        if (f) {
          me[1] += 1;
          s.files.add(f);
          ph.files.add(f);
          cy.files.add(f);
          cyph.files.add(f);
          const rf = relFile(f, m.dir);
          if (rf) {
            s.edit_ev.push([tc / 1000, rf]);
            cy.edit_ev.push([tc / 1000, rf]);
          }
        }
      } else if (name === "read") {
        bump({ reads: true }, s, ph, cy, cyph);
      } else if (name === "bash" || name === "shell") {
        bump({ bash: true }, s, ph, cy, cyph);
        const c = String(
          ((st.input ?? {}) as Record<string, unknown>).command ?? "",
        );
        if (VERIFY_RE.test(c)) {
          bump({ ver: true }, s, ph, cy, cyph);
          if (s.last_ver === null || tSec > s.last_ver) s.last_ver = tSec;
          if (cy.last_ver === null || tSec > cy.last_ver) cy.last_ver = tSec;
        }
        if (COMMIT_RE.test(c)) bump({ commit: true }, s, ph, cy, cyph);
      }
    }
    s.prev_typ = "assistant";
  }

  return {
    S,
    day_wt_ms,
    day_sess,
    rhythm,
    models_day,
    ua_wt,
    ua_month,
    depth,
    n_msgs,
    day_wt_role,
    rhythm_day,
    day_u,
    models_day_role,
    month_edits,
    last_edit_ms,
  };
}
