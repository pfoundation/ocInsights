import { existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import {
  BUILD_AGENTS,
  DB_PATH,
  HEARTBEAT_CAP_MS,
  LEDGER_PATH,
  LINES_CAP,
  LINES_CUTOFF,
  SHIP_DAYS,
  WINDOW_DAYS,
} from "./config.ts";
import { attributeCommits } from "./commits.ts";
import { scanMessages, type Sess } from "./scan.ts";
import { ledgerEdits, loadSessions, partEdits } from "./sessions.ts";
import {
  bisectRight,
  Counter,
  dayOf,
  daysBetween,
  firstMaxKey,
  isoMs,
  mapToObj,
  median,
  minWhere,
  pyRound,
  roleOf,
  sum,
  topPair,
  truncMs,
  unitKey,
} from "./util.ts";

function modelLabel(mj: string | null | undefined): string {
  if (!mj) return "(unset)";
  try {
    const o = JSON.parse(mj) as { id?: string; variant?: string };
    return `${o.id ?? "?"} (${o.variant ?? "?"})`;
  } catch {
    return mj.slice(0, 40);
  }
}

function addAgg(g: Record<string, number>, k: string, n: number): void {
  g[k] = (g[k] ?? 0) + n;
}

function run(db: Database): Record<string, unknown> {
  const meta = loadSessions(db);
  const range = db
    .query(
      `SELECT MIN(time_created) AS lo, MAX(time_created) AS hi
       FROM session_message WHERE type IN ('user','assistant')`,
    )
    .get() as { lo: number; hi: number };
  const start_day = dayOf(range.lo);
  const end_day = dayOf(range.hi);
  const all_days = daysBetween(start_day, end_day);
  const win_start = new Date(isoMs(end_day) - (WINDOW_DAYS - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  const win_start_ms = isoMs(win_start);
  const lines_cut = isoMs(LINES_CUTOFF);

  const X = scanMessages(db, meta, win_start_ms);
  const {
    S,
    day_wt_ms,
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
  } = X;

  const HM = new Map<string, Map<string, number>>();
  const HD: Record<string, Record<string, number>> = {};
  const DHRS: Record<string, number> = {};
  const wt_ms = new Counter<string>();
  const wt_sess = new Map<string, Set<string>>();
  const wt_msgs = new Counter<string>();
  for (const [day, per] of day_wt_ms) {
    DHRS[day] = pyRound(sum(per.values()) / 3.6e6, 2);
    for (const [wt, ms] of per.entries()) {
      const month = day.slice(0, 7);
      let hm = HM.get(month);
      if (!hm) {
        hm = new Map();
        HM.set(month, hm);
      }
      hm.set(wt, (hm.get(wt) ?? 0) + ms / 3.6e6);
      if (day >= win_start) {
        let hd = HD[day];
        if (!hd) {
          hd = {};
          HD[day] = hd;
        }
        hd[wt] = pyRound(ms / 3.6e6, 2);
      }
      wt_ms.add(wt, ms);
    }
  }
  for (const [sid, s] of S) {
    const wt = meta.get(sid)!.wt;
    let set = wt_sess.get(wt);
    if (!set) {
      set = new Set();
      wt_sess.set(wt, set);
    }
    set.add(sid);
    wt_msgs.add(wt, s.u + s.a);
  }
  const HM_obj: Record<string, Record<string, number>> = {};
  for (const [m, per] of HM) {
    const inner: Record<string, number> = {};
    for (const [w, h] of per) inner[w] = pyRound(h, 2);
    HM_obj[m] = inner;
  }
  const PORDER = wt_ms.mostCommon().map(([w]) => w);
  const total_ms = sum(wt_ms.values());
  const LB = PORDER.map((w) => [
    w,
    wt_sess.get(w)?.size ?? 0,
    wt_msgs.get(w),
    pyRound(wt_ms.get(w) / 3.6e6, 2),
    pyRound((100 * wt_ms.get(w)) / total_ms, 1),
  ]);

  const COST = new Map<string, [number, number, number, number]>();
  for (const m of meta.values()) {
    let c = COST.get(m.wt);
    if (!c) {
      c = [0, 0, 0, 0];
      COST.set(m.wt, c);
    }
    c[0] += m.cost;
    c[1] += m.fresh;
    c[2] += m.add;
    c[3] += m.dele;
  }
  const COST_obj = mapToObj(COST, (v) => [pyRound(v[0], 2), v[1], v[2], v[3]]);

  const agentC = new Counter<string>();
  for (const m of meta.values()) agentC.add(m.agent);
  const AGENTS = agentC.mostCommon(8);
  const modelC = new Counter<string>();
  for (const m of meta.values()) modelC.add(modelLabel(m.model));
  const MODELS = modelC.mostCommon(8);

  const sess_day_ms = new Map<string, Counter<string>>();
  for (const [sid, s] of S) {
    const c = new Counter<string>();
    sess_day_ms.set(sid, c);
    for (const [ts, inc] of s.ev) c.add(dayOf(truncMs(ts)), inc);
  }
  const acc = new Map<string, [number, number, Set<string>]>();
  for (const [sid, days] of sess_day_ms) {
    const m = meta.get(sid)!;
    const tot = sum(days.values());
    for (const [day, ms] of days.entries()) {
      let e = acc.get(day);
      if (!e) {
        e = [0, 0, new Set()];
        acc.set(day, e);
      }
      e[0] += (m.fresh * ms) / tot;
      e[1] += (m.cost * ms) / tot;
      e[2].add(sid);
    }
  }
  const DTOK: Record<string, [number, number, number]> = {};
  for (const [d, v] of acc) {
    DTOK[d] = [pyRound(v[0]), pyRound(v[1], 2), v[2].size];
  }

  const editSets = new Map<string, Map<string, [number, string]>>();
  const putEdit = (sid: string, ts: number, f: string) => {
    let m = editSets.get(sid);
    if (!m) {
      m = new Map();
      editSets.set(sid, m);
    }
    m.set(`${ts}\0${f}`, [ts, f]);
  };
  for (const [sid, s] of S) {
    for (const [ts, f] of s.edit_ev) putEdit(sid, ts, f);
  }
  const part_src = partEdits(db, meta);
  const [ledger_src, ledger] = ledgerEdits(meta);
  for (const src of [part_src, ledger_src]) {
    for (const [sid, evs] of src) {
      for (const [ts, f] of evs) putEdit(sid, ts, f);
    }
  }
  const edits = new Map<string, [number, string][]>();
  for (const [sid, v] of editSets) {
    if (v.size === 0) continue;
    edits.set(
      sid,
      [...v.values()].sort((a, b) =>
        a[0] !== b[0] ? a[0] - b[0] : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
      ),
    );
  }
  const edits_cyc = new Map<string, [number, string][]>();
  for (const [sid, s] of S) {
    if (!s.cyc.length || !edits.has(sid)) continue;
    const firsts = s.cyc.map((cy) => cy.first);
    for (const [ts, f] of edits.get(sid)!) {
      const ci = Math.min(
        Math.max(bisectRight(firsts, ts) - 1, 0),
        firsts.length - 1,
      );
      const k = unitKey(sid, ci);
      let list = edits_cyc.get(k);
      if (!list) {
        list = [];
        edits_cyc.set(k, list);
      }
      list.push([ts, f]);
    }
  }
  const PSRC: Record<string, [number, number, number, number]> = {};
  for (const [mo, [n, p]] of month_edits) PSRC[mo] = [n, p, 0, 0];
  const extra: [number, Map<string, [number, string][]>][] = [
    [2, part_src],
    [3, ledger_src],
  ];
  for (const [col, src] of extra) {
    for (const evs of src.values()) {
      for (const [ts] of evs) {
        const mo = dayOf(truncMs(ts)).slice(0, 7);
        if (!PSRC[mo]) PSRC[mo] = [0, 0, 0, 0];
        PSRC[mo]![col] += 1;
      }
    }
  }
  const PSRC_sorted: Record<string, [number, number, number, number]> = {};
  for (const mo of Object.keys(PSRC).sort()) PSRC_sorted[mo] = PSRC[mo]!;
  const path_cov = [...S].filter(
    ([sid, s]) => s.edits > 0 && edits.has(sid),
  ).length;
  const editing = [...S.values()].filter((s) => s.edits > 0).length;

  const [CM, shipped, repoInfo] = attributeCommits(
    S,
    meta,
    start_day,
    edits_cyc,
  );

  const AGG = new Map<string, Record<string, number>>();
  const ship_lag = new Map<string, number[]>();
  const per_cyc_ship = new Map<string, [number, number, number]>();
  for (const [sid, s] of S) {
    s.cyc.forEach((cy, ci) => {
      const k = unitKey(sid, ci);
      const fc = minWhere(shipped.get(k) ?? [], (t) => t >= (cy.first || 0));
      const shc = fc !== null && fc - cy.first <= SHIP_DAYS * 86400;
      per_cyc_ship.set(k, [
        shc ? 1 : 0,
        shc ? pyRound((fc - cy.first) / 3600, 2) : -1,
        cy.edits > 0 && edits_cyc.has(k) ? 1 : 0,
      ]);
    });
  }
  const per_sess_ship = new Map<string, [number, number, number]>();
  for (const [sid, s] of S) {
    if (!s.a) continue;
    const m = meta.get(sid)!;
    const [model, prov] = topPair(s.mp)!;
    const b = BUILD_AGENTS.has(m.agent) ? 1 : 0;
    const key = `${model}\x1f${prov}\x1f${b}`;
    let g = AGG.get(key);
    if (!g) {
      g = {};
      AGG.set(key, g);
    }
    addAgg(g, "sess", 1);
    addAgg(g, "hrs", s.ms / 3.6e6);
    addAgg(g, "u", s.u);
    addAgg(g, "a", s.a);
    addAgg(g, "err", s.err);
    addAgg(g, "cost", m.cost);
    addAgg(g, "edits", s.edits);
    addAgg(g, "eerr", s.eerr);
    addAgg(g, "files", s.files.size);
    addAgg(g, "reads", s.reads);
    addAgg(g, "bash", s.bash);
    addAgg(g, "tools", s.tools);
    addAgg(g, "terr", s.terr);
    addAgg(g, "vercalls", s.ver);
    addAgg(g, "commits", s.commit);
    if (s.edits > 0) addAgg(g, "coded", 1);
    if (m.has_lines && m.created < lines_cut) {
      addAgg(g, "lsess", 1);
      addAgg(g, "lhrs", s.ms / 3.6e6);
      addAgg(g, "lines", Math.min(m.add + m.dele, LINES_CAP));
    }
    const union: number[] = [];
    for (let ci = 0; ci < s.cyc.length; ci++) {
      const ts = shipped.get(unitKey(sid, ci));
      if (ts) union.push(...ts);
    }
    const first_commit = minWhere(union, (t) => t >= (s.first || 0));
    const sh =
      first_commit !== null && first_commit - s.first! <= SHIP_DAYS * 86400;
    const ed = s.edits > 0;
    const v = s.ver > 0;
    addAgg(g, "s_noedit", ed ? 0 : 1);
    addAgg(g, "s_edit", ed && !v && !sh ? 1 : 0);
    addAgg(g, "s_ver", ed && v && !sh ? 1 : 0);
    addAgg(g, "s_commit", ed && sh ? 1 : 0);
    addAgg(g, "s_paths", ed && edits.has(sid) ? 1 : 0);
    if (sh) {
      let lag = ship_lag.get(key);
      if (!lag) {
        lag = [];
        ship_lag.set(key, lag);
      }
      lag.push((first_commit - s.first!) / 3600);
    }
    per_sess_ship.set(sid, [
      sh ? 1 : 0,
      sh ? pyRound((first_commit - s.first!) / 3600, 2) : -1,
      ed && edits.has(sid) ? 1 : 0,
    ]);
  }
  const FLOAT_KEYS = new Set(["hrs", "cost", "lhrs"]);
  const PROD: Record<string, unknown>[] = [];
  for (const [k, g] of AGG) {
    const parts = k.split("\x1f");
    const rec: Record<string, unknown> = {
      m: parts[0],
      p: parts[1],
      b: Number(parts[2]),
    };
    for (const [x, val] of Object.entries(g)) {
      rec[x] = FLOAT_KEYS.has(x) ? pyRound(val, 3) : val;
    }
    const lag = ship_lag.get(k) ?? [];
    lag.sort((a, b) => a - b);
    rec.ship_lag_med = lag.length
      ? pyRound(lag[Math.floor(lag.length / 2)]!, 2)
      : null;
    PROD.push(rec);
  }

  const children = new Map<string, string[]>();
  for (const [sid, m] of meta) {
    if (m.parent && meta.has(m.parent)) {
      let list = children.get(m.parent);
      if (!list) {
        list = [];
        children.set(m.parent, list);
      }
      list.push(sid);
    }
  }
  const tree = new Map<
    string,
    [number, number, number, number, number, number, number, number, number]
  >();
  for (const sid of meta.keys()) {
    let ted = 0;
    let teerr = 0;
    let tship = 0;
    let tpaths = 0;
    let tcost = 0;
    let tms = 0;
    let tedit: number | null = null;
    let tver: number | null = null;
    let tabort = 0;
    const stack = [sid];
    while (stack.length) {
      const n = stack.pop()!;
      const ch = children.get(n);
      if (ch) stack.push(...ch);
      const sn = S.get(n);
      if (sn) {
        ted += sn.edits;
        teerr += sn.eerr;
        tms += sn.ms;
        if (sn.abort > 0) tabort = 1;
        if (sn.last_edit !== null)
          tedit = tedit === null ? sn.last_edit : Math.max(tedit, sn.last_edit);
        if (sn.last_ver !== null)
          tver = tver === null ? sn.last_ver : Math.max(tver, sn.last_ver);
      }
      const mn = meta.get(n);
      if (mn) tcost += mn.cost;
      const trip = per_sess_ship.get(n) ?? ([0, -1, 0] as const);
      tship = tship || trip[0];
      tpaths = tpaths || trip[2];
    }
    const kids = (children.get(sid) ?? []).filter((c) => S.has(c)).length;
    tree.set(sid, [
      kids,
      ted,
      teerr,
      pyRound(tcost, 4),
      tship,
      ted ? tpaths : 0,
      pyRound(tms / 3.6e6, 3),
      tedit !== null && tver !== null && tver > tedit ? 1 : 0,
      tabort,
    ]);
  }
  const cyc_tree = new Map<
    string,
    [number, number, number, number, number, number, number, number, number]
  >();
  for (const [sid, s] of S) {
    if (!s.cyc.length) continue;
    const firsts = s.cyc.map((cy) => cy.first);
    const accC: [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ][] = [];
    const treeEdit: (number | null)[] = [];
    const treeVer: (number | null)[] = [];
    s.cyc.forEach((cy, ci) => {
      const own = s.ms ? (meta.get(sid)!.cost * cy.ms) / s.ms : 0;
      const [shc, , pac] = per_cyc_ship.get(unitKey(sid, ci))!;
      accC.push([
        0,
        cy.edits,
        cy.eerr,
        own,
        shc,
        pac,
        cy.ms,
        0,
        cy.abort > 0 ? 1 : 0,
      ]);
      treeEdit.push(cy.last_edit);
      treeVer.push(cy.last_ver);
    });
    const stack = [...(children.get(sid) ?? [])];
    while (stack.length) {
      const n = stack.pop()!;
      const ch = children.get(n);
      if (ch) stack.push(...ch);
      const sn = S.get(n);
      const ts0 = sn && sn.first !== null ? sn.first : null;
      const ci =
        ts0 !== null
          ? Math.min(Math.max(bisectRight(firsts, ts0) - 1, 0), accC.length - 1)
          : 0;
      const a = accC[ci]!;
      if (sn) {
        a[1] += sn.edits;
        a[2] += sn.eerr;
        a[6] += sn.ms;
        if (sn.abort > 0) a[8] = 1;
        if (sn.last_edit !== null)
          treeEdit[ci] =
            treeEdit[ci] === null
              ? sn.last_edit
              : Math.max(treeEdit[ci]!, sn.last_edit);
        if (sn.last_ver !== null)
          treeVer[ci] =
            treeVer[ci] === null
              ? sn.last_ver
              : Math.max(treeVer[ci]!, sn.last_ver);
      }
      a[3] += meta.get(n)!.cost;
      const [shn, , pan] = per_sess_ship.get(n) ?? ([0, -1, 0] as const);
      a[4] = a[4] || shn;
      a[5] = a[5] || pan;
      if ((children.get(sid) ?? []).includes(n) && S.has(n)) a[0] += 1;
    }
    accC.forEach((a, ci) => {
      a[3] = pyRound(a[3], 4);
      a[5] = a[1] ? a[5] : 0;
      a[6] = pyRound(a[6] / 3.6e6, 3);
      const le = treeEdit[ci];
      const lv = treeVer[ci];
      a[7] =
        le !== null &&
        le !== undefined &&
        lv !== null &&
        lv !== undefined &&
        lv > le
          ? 1
          : 0;
      cyc_tree.set(unitKey(sid, ci), [...a]);
    });
  }

  // Ship-judged exclusion per cycle tree (0 ship-judged, 1 pending,
  // 2 unshippable). A shipped tree is always ship-judged: its outcome was
  // observed. An unshipped tree is pending while its SHIP_DAYS window is still
  // open past the latest scanned commit, and unshippable when the window
  // closed on a worktree outside the scanned repos or with no attributable
  // commit in it. Excluded trees stay in every process axis; only the ship
  // rate and the per-ship costs divide by ship-judged cycles.
  const WIN_S = SHIP_DAYS * 86400;
  const hasCommitIn = (ts: number[], lo: number, hi: number): boolean => {
    const i = bisectRight(ts, hi) - 1;
    return i >= 0 && ts[i]! >= lo;
  };
  const shipExcl = (
    first: number | null,
    wt: string,
    tsh: number,
  ): 0 | 1 | 2 => {
    if (tsh || !first) return 0;
    if (first + WIN_S > CM.latest) return 1;
    const ts = repoInfo.commits.get(wt);
    if (!ts) return 2;
    return hasCommitIn(ts, first, first + WIN_S) ? 0 : 2;
  };
  const per_cyc_shipe = new Map<string, 0 | 1 | 2>();
  for (const [sid, s] of S) {
    if (!s.cyc.length) continue;
    const wt = meta.get(sid)!.wt;
    s.cyc.forEach((cy, ci) => {
      const tsh = cyc_tree.get(unitKey(sid, ci))![4];
      per_cyc_shipe.set(
        unitKey(sid, ci),
        shipExcl(cy.first || s.first || 0, wt, tsh),
      );
    });
  }
  const per_sess_shipe = new Map<string, 0 | 1 | 2>();
  for (const [sid, m] of meta) {
    per_sess_shipe.set(
      sid,
      shipExcl(S.get(sid)?.first ?? null, m.wt, tree.get(sid)![4]),
    );
  }

  const IDX = {
    wt: [] as string[],
    agent: [] as string[],
    model: [] as string[],
    prov: [] as string[],
    lmodel: [] as string[],
  };
  const ix = {
    wt: new Map<string, number>(),
    agent: new Map<string, number>(),
    model: new Map<string, number>(),
    prov: new Map<string, number>(),
    lmodel: new Map<string, number>(),
  };
  const idx = (kind: keyof typeof IDX, v: string): number => {
    let i = ix[kind].get(v);
    if (i === undefined) {
      i = IDX[kind].length;
      ix[kind].set(v, i);
      IDX[kind].push(v);
    }
    return i;
  };
  const SESS: unknown[][] = [];
  const SESS_KEY: string[] = [];
  const PH: unknown[][] = [];
  const phaseModels = (s: Sess | undefined): number[] => {
    const out: number[] = [];
    for (const r of [1, 2]) {
      const ph = s?.ph.get(r);
      if (ph && ph.mp.size) {
        const pm = topPair(ph.mp)!;
        out.push(idx("model", pm[0]), idx("prov", pm[1]));
      } else out.push(-1, -1);
    }
    return out;
  };
  for (const [sid, m] of meta) {
    const s = S.get(sid);
    let model: string;
    let prov: string;
    if (s && s.mp.size) {
      [model, prov] = topPair(s.mp)!;
    } else {
      model = "(none)";
      prov = "(none)";
    }
    const day = (s && s.day0) || dayOf(m.created);
    const lines =
      m.has_lines && m.created < lines_cut
        ? Math.min(m.add + m.dele, LINES_CAP)
        : -1;
    const [sh, lag, paths] = per_sess_ship.get(sid) ?? [0, -1, 0];
    const [tk, ted, tee, tco, tsh, tpa, thr, tvr, tbr] = tree.get(sid)!;
    const slat = s ? median(s.lat) : null;
    SESS.push([
      day,
      idx("wt", m.wt),
      idx("agent", m.agent),
      roleOf(m.agent),
      m.child ? 1 : 0,
      idx("model", model),
      idx("prov", prov),
      idx("lmodel", modelLabel(m.model)),
      pyRound((s ? s.ms : 0) / 3.6e6, 3),
      s ? s.u : 0,
      s ? s.a : 0,
      s ? s.err : 0,
      pyRound(m.cost, 4),
      m.fresh,
      m.cache_r,
      m.cache_w,
      s ? s.edits : 0,
      s ? s.eerr : 0,
      s ? s.files.size : 0,
      s ? s.reads : 0,
      s ? s.bash : 0,
      s ? s.tools : 0,
      s ? s.terr : 0,
      s ? s.ver : 0,
      s ? s.commit : 0,
      lines,
      s ? s.comp : 0,
      sh,
      lag,
      paths,
      m.add,
      m.dele,
      ...phaseModels(s),
      tk,
      ted,
      tee,
      tco,
      tsh,
      tpa,
      thr,
      tvr,
      tbr,
      slat === null ? -1 : pyRound(slat / 1000, 2),
      per_sess_shipe.get(sid)!,
    ]);
    // Opaque per-session key for contributions (build.ts never injects it into
    // the deck). The raw session id must not leave data.json.
    SESS_KEY.push(createHash("sha256").update(sid).digest("hex"));
    if (s) {
      for (const [r, ph] of s.ph) {
        if (!(ph.a || ph.u)) continue;
        const pm = ph.mp.size ? topPair(ph.mp)! : ([model, prov] as const);
        const share = ph.ms / Math.max(s.ms, 1);
        PH.push([
          SESS.length - 1,
          r,
          idx("model", pm[0]),
          idx("prov", pm[1]),
          pyRound(ph.ms / 3.6e6, 3),
          ph.u,
          ph.a,
          ph.err,
          pyRound(m.cost * share, 4),
          ph.edits,
          ph.eerr,
          ph.files.size,
          ph.reads,
          ph.bash,
          ph.tools,
          ph.terr,
          ph.ver,
          ph.commit,
        ]);
      }
    }
  }
  const SESS_COLS = [
    "day",
    "wt",
    "agent",
    "role",
    "child",
    "model",
    "prov",
    "lmodel",
    "hrs",
    "u",
    "a",
    "err",
    "cost",
    "fresh",
    "cacheR",
    "cacheW",
    "edits",
    "eerr",
    "files",
    "reads",
    "bash",
    "tools",
    "terr",
    "ver",
    "commit",
    "lines",
    "comp",
    "shipped",
    "lag",
    "paths",
    "add",
    "dele",
    "pm",
    "pp",
    "bm",
    "bp",
    "kids",
    "tedits",
    "teerr",
    "tcost",
    "tship",
    "tpaths",
    "thrs",
    "tver",
    "tabort",
    "latmed",
    "tshipe",
  ];
  const PH_COLS = [
    "sess",
    "role",
    "model",
    "prov",
    "hrs",
    "u",
    "a",
    "err",
    "cost",
    "edits",
    "eerr",
    "files",
    "reads",
    "bash",
    "tools",
    "terr",
    "ver",
    "commit",
  ];
  const CYC_COLS = [
    "sess",
    "i",
    "hrs",
    "u",
    "a",
    "err",
    "cost",
    "edits",
    "eerr",
    "files",
    "reads",
    "tools",
    "terr",
    "ver",
    "lines",
    "pm",
    "pp",
    "bm",
    "bp",
    "shipped",
    "lag",
    "paths",
    "kids",
    "tedits",
    "teerr",
    "tcost",
    "tship",
    "tpaths",
    "thrs",
    "tver",
    "tabort",
    "latmed",
    "platmed",
    "blatmed",
    "pu",
    "pa",
    "pedits",
    "bu",
    "ba",
    "bedits",
    "tshipe",
  ];
  const CYC: unknown[][] = [];
  const sess_idx = new Map<string, number>();
  let si = 0;
  for (const sid of meta.keys()) sess_idx.set(sid, si++);
  const sc_lines = SESS_COLS.indexOf("lines");
  for (const [sid, s] of S) {
    if (!s.cyc.length) continue;
    const m = meta.get(sid)!;
    const slines = SESS[sess_idx.get(sid)!]![sc_lines] as number;
    s.cyc.forEach((cy, ci) => {
      const share = s.ms ? cy.ms / s.ms : 0;
      const pair: number[] = [];
      for (const r of [1, 2]) {
        const ph = cy.ph.get(r);
        if (ph && ph.mp.size) {
          const dm = topPair(ph.mp)!;
          pair.push(idx("model", dm[0]), idx("prov", dm[1]));
        } else pair.push(-1, -1);
      }
      const [sh, lag, paths] = per_cyc_ship.get(unitKey(sid, ci))!;
      const [tk, ted, tee, tco, tsh, tpa, thr, tvr, tbr] = cyc_tree.get(
        unitKey(sid, ci),
      )!;
      const p1 = cy.ph.get(1);
      const p2 = cy.ph.get(2);
      const clat = (v: number[] | undefined): number => {
        const m = v ? median(v) : null;
        return m === null ? -1 : pyRound(m / 1000, 2);
      };
      CYC.push([
        sess_idx.get(sid)!,
        ci,
        pyRound(cy.ms / 3.6e6, 3),
        cy.u,
        cy.a,
        cy.err,
        pyRound(m.cost * share, 4),
        cy.edits,
        cy.eerr,
        cy.files.size,
        cy.reads,
        cy.tools,
        cy.terr,
        cy.ver,
        slines < 0 ? -1 : pyRound(slines * share, 2),
        ...pair,
        sh,
        lag,
        paths,
        tk,
        ted,
        tee,
        tco,
        tsh,
        tpa,
        thr,
        tvr,
        tbr,
        clat(cy.lat),
        clat(cy.ph.get(1)?.lat),
        clat(cy.ph.get(2)?.lat),
        p1 ? p1.u : 0,
        p1 ? p1.a : 0,
        p1 ? p1.edits : 0,
        p2 ? p2.u : 0,
        p2 ? p2.a : 0,
        p2 ? p2.edits : 0,
        per_cyc_shipe.get(unitKey(sid, ci))!,
      ]);
    });
  }
  const DAYW = mapToObj(day_wt_role, (per) =>
    mapToObj(per, (v) => [
      pyRound(v[0] / 3.6e6, 3),
      pyRound(v[1] / 3.6e6, 3),
      pyRound(v[2] / 3.6e6, 3),
    ]),
  );
  const DAYM = mapToObj(models_day_role, (per) => {
    const o: Record<string, [number, number, number]> = {};
    for (const [k, v] of per) o[k] = v;
    return o;
  });
  const DAYU = mapToObj(day_u);
  const RHYD = mapToObj(rhythm_day);

  const fresh = sum([...meta.values()].map((m) => m.fresh));
  let u_top = 0;
  let u_child = 0;
  let a_all = 0;
  for (const [sid, s] of S) {
    a_all += s.a;
    if (meta.get(sid)!.child) u_child += s.u;
    else u_top += s.u;
  }
  const busiest = firstMaxKey(Object.keys(DHRS), (d) => DHRS[d]!);
  const day_msgs = new Counter<string>();
  for (const s of S.values()) {
    for (const [ts] of s.ev) day_msgs.add(dayOf(truncMs(ts)));
  }
  const peak_month = firstMaxKey(Object.keys(HM_obj), (m) =>
    sum(Object.values(HM_obj[m]!)),
  );
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const data = {
    meta: {
      generated: now,
      db: DB_PATH,
      start: start_day,
      end: end_day,
      win_start,
      window_days: WINDOW_DAYS,
      span_days: all_days.length,
      active_days: Object.keys(DHRS).length,
      sessions: meta.size,
      cycles: CYC.length,
      messages: n_msgs,
      total_hr: pyRound(total_ms / 3.6e6, 2),
      cost: pyRound(sum([...meta.values()].map((m) => m.cost)), 2),
      fresh_tokens: fresh,
      cache_read: sum([...meta.values()].map((m) => m.cache_r)),
      cache_write: sum([...meta.values()].map((m) => m.cache_w)),
      prompts_top: u_top,
      prompts_child: u_child,
      replies: a_all,
      busiest_day: busiest,
      busiest_hr: DHRS[busiest],
      busiest_msgs: day_msgs.get(busiest),
      peak_month,
      peak_month_hr: pyRound(sum(Object.values(HM_obj[peak_month]!)), 1),
      top_project: PORDER[0],
      top_hr: LB[0]![3],
      top_pct: LB[0]![4],
      top_sessions: LB[0]![1],
      repos: CM.repos,
      lines_cutoff: LINES_CUTOFF,
      heartbeat_cap_min: Math.floor(HEARTBEAT_CAP_MS / 60000),
      ship_days: SHIP_DAYS,
      basis: CM.basis,
      sessions_editing: editing,
      sessions_with_paths: path_cov,
      ledger_present: existsSync(LEDGER_PATH),
    },
    LEDGER: {
      path: LEDGER_PATH,
      lines: ledger.lines,
      sessions: ledger.sessions,
      first: ledger.first,
      last: ledger.last,
      last_edit: last_edit_ms,
    },
    MONTHS: Object.keys(HM_obj).sort(),
    HM: HM_obj,
    HD,
    PORDER,
    LB,
    COST: COST_obj,
    DEPTH: mapToObj(depth),
    AGENTS,
    MODELS,
    RHY: rhythm,
    DMODELS: {
      day: mapToObj(models_day, (c) => {
        const o: Record<string, number> = {};
        for (const [k, v] of c.entries()) o[k] = v;
        return o;
      }),
    },
    DTOK,
    UA: mapToObj(ua_wt),
    UAM: (() => {
      const o: Record<string, [number, number, number]> = {};
      for (const k of [...ua_month.keys()].sort()) o[k] = ua_month.get(k)!;
      return o;
    })(),
    PROD,
    SHIP: PROD,
    CM,
    DHRS,
    PSRC: PSRC_sorted,
    DAYW,
    DAYM,
    DAYU,
    RHYD,
    SESS,
    SESS_COLS,
    SESS_KEY,
    IDX,
    PH,
    PH_COLS,
    CYC,
    CYC_COLS,
  };
  return data;
}

export function extract(): Record<string, unknown> {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 600000");
    return run(db);
  } finally {
    db.close();
  }
}

export function extractToFile(out: string): string {
  const t0 = Date.now();
  const data = extract();
  writeFileSync(out, JSON.stringify(data));
  const mt = data.meta as Record<string, unknown>;
  const CM = data.CM as {
    total: number;
    repos: number;
    basis: Record<string, number>;
  };
  const b = CM.basis;
  const ledger = data.LEDGER as {
    lines: number;
    sessions: number;
    last: number | null;
  };
  const last = ledger.last ? dayOf(ledger.last) : "never";
  const summary =
    `${out}: ${mt.start} → ${mt.end}, ${mt.sessions} sessions in ${mt.cycles} cycles, ${Number(mt.messages).toLocaleString("en-US")} msgs, ${mt.total_hr} h, ` +
    `${CM.total} commits in ${CM.repos} repos — by files ${b.files ?? 0}, by window ${b.window ?? 0}, ` +
    `advised only ${b.advised ?? 0}, manual ${b.manual ?? 0} · edit paths for ${mt.sessions_with_paths}/${mt.sessions_editing} editing sessions` +
    ` · ledger: ${ledger.lines} edits in ${ledger.sessions} sessions, last ${last}` +
    `${ledger.lines ? "" : " (run make install-plugin, then restart opencode)"} · ${Math.round((Date.now() - t0) / 1000)}s`;
  return summary;
}
