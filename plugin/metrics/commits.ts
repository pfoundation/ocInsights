import { spawnSync } from "node:child_process";
import {
  COMMIT_GRACE_S,
  COMMIT_WINDOW_H,
  DEV_ROOT,
  GIT_AUTHORS,
} from "./config.ts";
import type { SessionMeta } from "./sessions.ts";
import type { Sess } from "./scan.ts";
import {
  bisectLeft,
  bisectRight,
  Counter,
  isoMs,
  pyRound,
  roleOf,
  splitUnit,
  topPair,
  topVariant,
  unitKey,
} from "./util.ts";
import { VARIANT_NONE } from "./config.ts";

export type GitCommit = {
  h: string;
  at: number;
  an: string;
  ins: number;
  dele: number;
  files: Set<string>;
};

const RENAME_BRACE = /^(.*)\{(.*) => (.*)\}(.*)$/;

export function gitCommits(repo: string): GitCommit[] {
  const r = spawnSync(
    "git",
    [
      "-C",
      repo,
      "log",
      "--all",
      "--since=2026-01-01",
      "--no-merges",
      "--format=%x1e%H|%at|%an",
      "--numstat",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const out = r.stdout ?? "";
  const cs: GitCommit[] = [];
  for (const raw of out.split("\x1e").slice(1)) {
    let blk = raw;
    while (blk.startsWith("\n")) blk = blk.slice(1);
    while (blk.endsWith("\n")) blk = blk.slice(0, -1);
    const lines = blk.split("\n");
    const head = lines[0]!;
    const i1 = head.indexOf("|");
    const i2 = head.indexOf("|", i1 + 1);
    const h = head.slice(0, i1);
    const at = head.slice(i1 + 1, i2);
    const an = head.slice(i2 + 1);
    const c: GitCommit = {
      h: h!,
      at: Number(at),
      an: an ?? "",
      ins: 0,
      dele: 0,
      files: new Set(),
    };
    for (const line of lines.slice(1)) {
      const parts = line.split("\t");
      if (parts.length !== 3) continue;
      const [a, d, rawF] = parts;
      let f = rawF!;
      c.ins += /^\d+$/.test(a!) ? Number(a) : 0;
      c.dele += /^\d+$/.test(d!) ? Number(d) : 0;
      if (f.includes(" => ")) {
        const m = f.match(RENAME_BRACE);
        f = m ? m[1]! + m[3]! + m[4]! : f.split(" => ").pop()!;
      }
      c.files.add(f);
    }
    cs.push(c);
  }
  return cs;
}

function isGitRepo(w: string): boolean {
  return (
    spawnSync("git", ["-C", w, "rev-parse", "--git-dir"], {
      encoding: "utf8",
    }).status === 0
  );
}

type Ev = { ts: number; unit: string; ms: number };
type Ed = { ts: number; unit: string; f: string };

export type CommitData = {
  models: string[];
  provs: string[];
  variants: string[];
  recs: unknown[];
  manual: unknown[];
  total: number;
  repos: number;
  latest: number;
  basis: Record<string, number>;
};

export function attributeCommits(
  S: Map<string, Sess>,
  meta: Map<string, SessionMeta>,
  startDay: string,
  editsCyc: Map<string, [number, string][]>,
): [
  CommitData,
  Map<string, number[]>,
  { repos: string[]; commits: Map<string, number[]> },
] {
  const since = isoMs(startDay) / 1000;
  const WT = new Map<string, Ev[]>();
  const ED = new Map<string, Ed[]>();
  for (const [sid, s] of S) {
    if (meta.has(sid) && s.mp.size > 0) {
      const wt = meta.get(sid)!.wt;
      s.cyc.forEach((cy, ci) => {
        const unit = unitKey(sid, ci);
        let wtl = WT.get(wt);
        if (!wtl) {
          wtl = [];
          WT.set(wt, wtl);
        }
        for (const [ts, ms] of cy.ev) wtl.push({ ts, unit, ms });
        const evs = editsCyc.get(unit);
        if (evs) {
          let edl = ED.get(wt);
          if (!edl) {
            edl = [];
            ED.set(wt, edl);
          }
          for (const [ts, f] of evs) edl.push({ ts, unit, f });
        }
      });
    }
  }
  const cmpTsUnit = (
    a: { ts: number; unit: string },
    b: { ts: number; unit: string },
  ) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    const [as, ac] = splitUnit(a.unit);
    const [bs, bc] = splitUnit(b.unit);
    if (as !== bs) return as < bs ? -1 : 1;
    return ac - bc;
  };
  for (const list of WT.values()) {
    list.sort((a, b) => cmpTsUnit(a, b) || a.ms - b.ms);
  }
  for (const list of ED.values()) {
    list.sort(
      (a, b) => cmpTsUnit(a, b) || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0),
    );
  }

  const repoSet = new Set<string>();
  for (const m of meta.values()) {
    if (m.wt.startsWith(DEV_ROOT + "/") && isGitRepo(m.wt)) repoSet.add(m.wt);
  }
  const repos = [...repoSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const models: string[] = [];
  const provs: string[] = [];
  const variants: string[] = [];
  const mi = new Map<string, number>();
  const pi = new Map<string, number>();
  const vi = new Map<string, number>();
  const idx = (lst: string[], d: Map<string, number>, v: string) => {
    let i = d.get(v);
    if (i === undefined) {
      i = lst.length;
      d.set(v, i);
      lst.push(v);
    }
    return i;
  };

  const recs: unknown[] = [];
  const manual: unknown[] = [];
  const seen = new Set<string>();
  let total = 0;
  const basis = new Counter<string>();
  const shipped = new Map<string, number[]>();
  // Attributable commit timestamps per scanned repo (author + since filters,
  // before the cross-repo hash dedup): the ship-judged gate checks whether a
  // cycle's window held any commit its edits could have landed in.
  const repoCommits = new Map<string, number[]>();

  for (const repo of repos) {
    const mine = gitCommits(repo)
      .filter((c) => GIT_AUTHORS.has(c.an) && c.at >= since)
      .sort((a, b) => a.at - b.at);
    repoCommits.set(
      repo,
      mine.map((c) => c.at),
    );
    const cs = mine.filter((c) => !seen.has(c.h));
    for (const c of cs) seen.add(c.h);
    const ev = WT.get(repo) ?? [];
    const ed = ED.get(repo) ?? [];
    const ts = ev.map((e) => e.ts);
    const ets = ed.map((e) => e.ts);
    let prev: number | null = null;
    for (const c of cs) {
      total += 1;
      const lo = Math.max(
        prev ?? c.at - 6 * 3600,
        c.at - COMMIT_WINDOW_H * 3600,
      );
      const hi = c.at + COMMIT_GRACE_S;
      prev = c.at;
      const lines = c.ins + c.dele;
      const mins = new Counter<string>();
      for (const e of ev.slice(bisectLeft(ts, lo), bisectRight(ts, hi))) {
        mins.add(e.unit, e.ms);
      }
      const touched = new Map<string, Set<string>>();
      for (const e of ed.slice(bisectLeft(ets, lo), bisectRight(ets, hi))) {
        if (c.files.has(e.f)) {
          let fs = touched.get(e.unit);
          if (!fs) {
            fs = new Set();
            touched.set(e.unit, fs);
          }
          fs.add(e.f);
        }
      }
      let weights: Map<string, number>;
      let how: string;
      if (touched.size > 0) {
        weights = new Map();
        for (const [unit, fs] of touched) weights.set(unit, fs.size);
        how = "files";
      } else {
        weights = new Map();
        for (const [unit, ms] of mins.entries()) {
          const [sid, ci] = splitUnit(unit);
          const cy = S.get(sid)!.cyc[ci]!;
          if (cy.edits > 0 && !editsCyc.has(unit)) weights.set(unit, ms);
        }
        how = "window";
      }
      const tot = sumMap(weights);
      if (!tot) {
        basis.add(mins.size ? "advised" : "manual");
        manual.push([c.at, lines, mins.size ? 1 : 0]);
        continue;
      }
      basis.add(how);
      const ent: unknown[] = [];
      for (const [unit, w] of weights) {
        const [sid, ci] = splitUnit(unit);
        const share = w / tot;
        const ms = mins.get(unit);
        const cy = S.get(sid)!.cyc[ci]!;
        const phases: [
          number,
          (typeof cy.ph extends Map<number, infer P> ? P : never) | null,
        ][] = [];
        for (const [role, ph] of cy.ph) {
          if (ph.mp.size > 0 && ph.ms > 0) phases.push([role, ph]);
        }
        const phaseList =
          phases.length > 0
            ? phases
            : ([[roleOf(meta.get(sid)!.agent), null]] as typeof phases);
        for (const [role, ph] of phaseList) {
          let model: string;
          let prov: string;
          let variant: string;
          let frac: number;
          if (ph === null) {
            const src = cy.mp.size ? cy.mp : S.get(sid)!.mp;
            const pair = topPair(src)!;
            model = pair[0];
            prov = pair[1];
            variant = topVariant(src, model, prov) ?? VARIANT_NONE;
            frac = 1.0;
          } else {
            const pair = topPair(ph.mp)!;
            model = pair[0];
            prov = pair[1];
            variant = topVariant(ph.mp, model, prov) ?? VARIANT_NONE;
            frac = ph.ms / Math.max(cy.ms, 1);
          }
          ent.push([
            idx(models, mi, model),
            idx(provs, pi, prov),
            role,
            pyRound(share * frac, 4),
            pyRound(((cy.u * ms) / Math.max(cy.ms, 1)) * frac, 3),
            pyRound((ms / 3.6e6) * frac, 3),
            0,
            idx(variants, vi, variant),
          ]);
        }
        if (how === "files") {
          let sh = shipped.get(unit);
          if (!sh) {
            sh = [];
            shipped.set(unit, sh);
          }
          sh.push(c.at);
        }
      }
      for (const [unit, ms] of mins.entries()) {
        if (weights.has(unit)) continue;
        const [sid, ci] = splitUnit(unit);
        const cy = S.get(sid)!.cyc[ci]!;
        const ph = cy.ph.get(1);
        if (ph && ph.mp.size > 0 && ph.ms > 0) {
          const [model, prov] = topPair(ph.mp)!;
          const frac = ph.ms / Math.max(cy.ms, 1);
          ent.push([
            idx(models, mi, model),
            idx(provs, pi, prov),
            1,
            0.0,
            pyRound(((cy.u * ms) / Math.max(cy.ms, 1)) * frac, 3),
            pyRound((ms / 3.6e6) * frac, 3),
            1,
            idx(variants, vi, topVariant(ph.mp, model, prov) ?? VARIANT_NONE),
          ]);
        }
      }
      recs.push([
        lines,
        pyRound(sum(mins.values()) / 3.6e6, 3),
        ent,
        c.at,
        how,
      ]);
    }
  }
  const latest = Math.max(
    0,
    ...recs.map((r) => (r as number[])[3] as number),
    ...manual.map((m) => (m as number[])[0] as number),
  );
  const basisObj: Record<string, number> = {};
  for (const [k, v] of basis.entries()) basisObj[k] = v;
  return [
    {
      models,
      provs,
      variants,
      recs,
      manual,
      total,
      repos: repos.length,
      latest,
      basis: basisObj,
    },
    shipped,
    { repos, commits: repoCommits },
  ];
}

function sumMap(m: Map<string, number>): number {
  let s = 0;
  for (const v of m.values()) s += v;
  return s;
}

function sum(xs: Iterable<number>): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}
