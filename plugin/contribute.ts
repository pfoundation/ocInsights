// Contribution payload: the minimal per-cycle facts the global scorecard needs.
// One code path for the CLI, the live HTTP routes, the RPC methods, the agent
// tool and the auto scheduler. Contract mirror: ../../pragmaServer/src/validate.ts
// — the two CONTRIB_COLS lists must stay identical. Never add session ids,
// paths, prompts or tokens.
//
// Sends are diff-based: contributed.json remembers a hash per sent row and only
// new/changed rows go out. Cycle facts are not final at session end (tship flips
// when a commit lands within SHIP_DAYS), so the diff is what keeps the pool
// current without resending history.
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTRIB_URL, REPO_ROOT, SHARE_DIR } from "./config.ts";
import { getData } from "./extract.ts";

export const CONTRIB_SCHEMA = 2;

// Auto-send cadence, shared by the scheduler and the status computation.
// FIRST_DELAY is the first-install grace window: nothing auto-sends until
// 15 min after load, so a new user has time to turn contribution off.
export const FIRST_DELAY_MS = 15 * 60 * 1000;
export const SEND_INTERVAL_MS = 6 * 3600 * 1000;
export const QUIET_MS = 10 * 60 * 1000;
export const FAIL_BACKOFF_MS = 3600 * 1000;

export const CONTRIB_COLS = [
  "cycle_key",
  "day",
  "model",
  "prov",
  "role",
  "pm",
  "pp",
  "bm",
  "bp",
  "u",
  "a",
  "tedits",
  "tpaths",
  "teerr",
  "tcost",
  "tship",
  "thrs",
  "tver",
  "tabort",
  "latmed",
  "tshipe",
] as const;

export type ContribPayload = {
  schema: number;
  extractor: string;
  install: string;
  generated: string;
  cols: readonly string[];
  rows: (string | number)[][];
};

export type ContribSummary = {
  rows: number;
  dayMin: string;
  dayMax: string;
  models: number;
};

export type ContribResult = {
  ok: boolean;
  dryRun: boolean;
  install: string;
  rows: number;
  changed: number;
  sent: number;
  dayMin: string;
  dayMax: string;
  models: number;
  status?: number;
  snapshot?: string;
  error?: string;
};

export type ContribSource = "env" | "options" | "file" | "default";

export type ContributeStatus = {
  enabled: boolean;
  source: ContribSource;
  lastSent: string | null;
  rowsTotal: number;
  nextDue: string | null;
};

export type ContributorFile = {
  install: string;
  enabled: boolean;
};

export type ContributedFile = {
  schema: number;
  extractor: string;
  url: string;
  generated: string | null;
  lastSent: string | null;
  lastFail: string | null;
  rows: Record<string, string>;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTRIBUTOR_PATH = join(SHARE_DIR, "contributor.json");
const CONTRIBUTED_PATH = join(SHARE_DIR, "contributed.json");
const CONTRIBUTOR_DOC = "set enabled:false to stop contributing";

/** Extractor version, read from package.json so it cannot drift. */
export async function loadExtractor(): Promise<string> {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { version?: unknown };
  if (typeof pkg.version !== "string" || !pkg.version) {
    throw new Error("contribute: package.json has no version");
  }
  return pkg.version;
}

/** Stable random install id plus the on/off switch; created on first use. */
export function loadContributor(): ContributorFile {
  try {
    const raw = JSON.parse(readFileSync(CONTRIBUTOR_PATH, "utf8")) as {
      install?: unknown;
      enabled?: unknown;
    };
    if (typeof raw.install === "string" && UUID_RE.test(raw.install)) {
      return { install: raw.install, enabled: raw.enabled !== false };
    }
  } catch {
    // Missing or corrupt: fall through and mint a fresh id.
  }
  const fresh = { install: randomUUID(), enabled: true };
  mkdirSync(SHARE_DIR, { recursive: true });
  writeFileSync(
    CONTRIBUTOR_PATH,
    JSON.stringify({ ...fresh, _doc: CONTRIBUTOR_DOC }) + "\n",
  );
  return fresh;
}

export function loadInstallId(): string {
  return loadContributor().install;
}

export function setContributeEnabled(on: boolean): ContributorFile {
  const cur = loadContributor();
  const next = { install: cur.install, enabled: on };
  writeFileSync(
    CONTRIBUTOR_PATH,
    JSON.stringify({ ...next, _doc: CONTRIBUTOR_DOC }) + "\n",
  );
  return next;
}

const TRUTHY = /^(1|true|yes|on)$/i;
const FALSY = /^(0|false|no|off)$/i;

/**
 * Effective switch, first hit wins: env, plugin options, contributor.json,
 * default on. Read-only: never creates files, so every tick/surface can call it.
 */
export function resolveContribute(
  options?: Readonly<Record<string, unknown>>,
): { enabled: boolean; source: ContribSource } {
  const env = process.env.OC_INSIGHTS_CONTRIBUTE;
  if (typeof env === "string" && env !== "") {
    if (FALSY.test(env)) return { enabled: false, source: "env" };
    if (TRUTHY.test(env)) return { enabled: true, source: "env" };
  }
  if (options && typeof options.contribute === "boolean") {
    return { enabled: options.contribute, source: "options" };
  }
  try {
    const raw = JSON.parse(readFileSync(CONTRIBUTOR_PATH, "utf8")) as {
      enabled?: unknown;
    };
    if (typeof raw.enabled === "boolean") {
      return { enabled: raw.enabled, source: "file" };
    }
  } catch {
    // Missing or corrupt: default on.
  }
  return { enabled: true, source: "default" };
}

export function loadContributed(): ContributedFile | null {
  try {
    const raw = JSON.parse(
      readFileSync(CONTRIBUTED_PATH, "utf8"),
    ) as ContributedFile | null;
    if (
      raw &&
      typeof raw === "object" &&
      raw.rows &&
      typeof raw.rows === "object"
    ) {
      return raw;
    }
  } catch {
    // Missing or corrupt: full resend.
  }
  return null;
}

function hashRow(row: (string | number)[]): string {
  return createHash("sha256")
    .update(JSON.stringify(row.slice(1)))
    .digest("hex");
}

/** Rows the server does not already have. A schema/extractor/url mismatch resends all. */
export function diffPayload(payload: ContribPayload): {
  changed: (string | number)[][];
  total: number;
} {
  const prev = loadContributed();
  if (
    !prev ||
    prev.schema !== CONTRIB_SCHEMA ||
    prev.extractor !== payload.extractor ||
    prev.url !== CONTRIB_URL
  ) {
    return { changed: payload.rows, total: payload.rows.length };
  }
  const changed = payload.rows.filter(
    (r) => prev.rows[r[0] as string] !== hashRow(r),
  );
  return { changed, total: payload.rows.length };
}

function recordSent(payload: ContribPayload): void {
  const rows: Record<string, string> = {};
  for (const r of payload.rows) rows[r[0] as string] = hashRow(r);
  mkdirSync(SHARE_DIR, { recursive: true });
  writeFileSync(
    CONTRIBUTED_PATH,
    JSON.stringify({
      schema: CONTRIB_SCHEMA,
      extractor: payload.extractor,
      url: CONTRIB_URL,
      generated: payload.generated,
      lastSent: new Date().toISOString(),
      lastFail: null,
      rows,
    }),
  );
}

export function recordFail(): void {
  const prev = loadContributed();
  const now = new Date().toISOString();
  mkdirSync(SHARE_DIR, { recursive: true });
  writeFileSync(
    CONTRIBUTED_PATH,
    JSON.stringify(
      prev
        ? { ...prev, lastFail: now }
        : {
            schema: CONTRIB_SCHEMA,
            extractor: "",
            url: CONTRIB_URL,
            generated: null,
            lastSent: null,
            lastFail: now,
            rows: {},
          },
    ),
  );
}

/** Cheap status: files only, never extracts. startMs is the scheduler's start (null off-plugin). */
export function contributeFileStatus(
  nowMs: number,
  startMs: number | null,
  options?: Readonly<Record<string, unknown>>,
): ContributeStatus {
  const { enabled, source } = resolveContribute(options);
  const prev = loadContributed();
  const lastSent = prev?.lastSent ?? null;
  const rowsTotal = prev ? Object.keys(prev.rows).length : 0;
  let nextDue: string | null = null;
  if (enabled) {
    const due = Math.max(
      lastSent
        ? Date.parse(lastSent) + SEND_INTERVAL_MS
        : (startMs ?? nowMs) + FIRST_DELAY_MS,
      prev?.lastFail ? Date.parse(prev.lastFail) + FAIL_BACKOFF_MS : 0,
    );
    nextDue = new Date(due).toISOString();
  }
  return { enabled, source, lastSent, rowsTotal, nextDue };
}

function colMap(names: unknown, what: string): Record<string, number> {
  if (!Array.isArray(names)) throw new Error(`contribute: ${what} missing`);
  return Object.fromEntries(names.map((c, i) => [c, i]));
}

function need(
  cols: Record<string, number>,
  names: string[],
  what: string,
): void {
  for (const n of names) {
    if (cols[n] === undefined) {
      throw new Error(`contribute: ${what} column ${n} missing; re-extract`);
    }
  }
}

/** Pure: extract payload + install id + extractor version -> contribution. */
export function buildPayload(
  data: Record<string, unknown>,
  install: string,
  extractor: string,
): ContribPayload {
  const SC = colMap(data.SESS_COLS, "SESS_COLS");
  const CC = colMap(data.CYC_COLS, "CYC_COLS");
  need(SC, ["day", "role", "child", "model", "prov"], "SESS");
  need(
    CC,
    [
      "sess",
      "i",
      "u",
      "a",
      "tedits",
      "tpaths",
      "teerr",
      "tcost",
      "tship",
      "thrs",
      "tver",
      "tabort",
      "latmed",
      "tshipe",
      "pm",
      "pp",
      "bm",
      "bp",
    ],
    "CYC",
  );
  const SESS = data.SESS as (string | number)[][];
  const CYC = data.CYC as (string | number)[][];
  const KEY = data.SESS_KEY as unknown;
  if (!Array.isArray(KEY) || KEY.length !== SESS.length) {
    throw new Error("contribute: SESS_KEY missing or short; re-extract");
  }
  const idx = data.IDX as { model: string[]; prov: string[] };
  const meta = data.meta as { generated: string };
  const rows: (string | number)[][] = [];
  for (const c of CYC) {
    const s = SESS[c[CC.sess] as number]!;
    if (s[SC.child]) continue; // child sessions fold into the parent tree
    const key = createHash("sha256")
      .update(`${install}:${KEY[c[CC.sess] as number]}:${c[CC.i]}`)
      .digest("hex")
      .slice(0, 16);
    const pm = c[CC.pm] as number;
    const pp = c[CC.pp] as number;
    const bm = c[CC.bm] as number;
    const bp = c[CC.bp] as number;
    rows.push([
      key,
      s[SC.day] as string,
      idx.model[s[SC.model] as number]!,
      idx.prov[s[SC.prov] as number]!,
      s[SC.role] as number,
      pm >= 0 ? idx.model[pm]! : "",
      pp >= 0 ? idx.prov[pp]! : "",
      bm >= 0 ? idx.model[bm]! : "",
      bp >= 0 ? idx.prov[bp]! : "",
      c[CC.u] as number,
      c[CC.a] as number,
      c[CC.tedits] as number,
      c[CC.tpaths] ? 1 : 0,
      c[CC.teerr] as number,
      c[CC.tcost] as number,
      c[CC.tship] ? 1 : 0,
      c[CC.thrs] as number,
      c[CC.tver] ? 1 : 0,
      c[CC.tabort] ? 1 : 0,
      c[CC.latmed] as number,
      c[CC.tshipe] as number,
    ]);
  }
  return {
    schema: CONTRIB_SCHEMA,
    extractor,
    install,
    generated: meta.generated,
    cols: [...CONTRIB_COLS],
    rows,
  };
}

export function summarize(payload: ContribPayload): ContribSummary {
  let dayMin = "9999";
  let dayMax = "0000";
  const models = new Set<string>();
  for (const r of payload.rows) {
    const d = r[1] as string;
    if (d < dayMin) dayMin = d;
    if (d > dayMax) dayMax = d;
    models.add(r[2] as string);
  }
  return { rows: payload.rows.length, dayMin, dayMax, models: models.size };
}

export async function submit(
  payload: ContribPayload,
  url: string,
): Promise<{ status: number; ok: boolean; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON error page; status still tells the story.
  }
  return { status: res.status, ok: res.status === 202, json };
}

let sending = false;

/**
 * Shared by the CLI, the live HTTP routes, the RPC methods, the agent tool
 * and the scheduler. Sends only changed rows unless full is set; afterwards
 * every current row hash is recorded, so the next run is a no-op.
 */
export async function runContribute(opts: {
  dryRun: boolean;
  refresh: boolean;
  data?: Record<string, unknown>;
  url?: string;
  full?: boolean;
}): Promise<ContribResult> {
  const data = opts.data ?? (await getData(opts.refresh));
  const { install } = loadContributor();
  const extractor = await loadExtractor();
  const payload = buildPayload(data, install, extractor);
  const sum = summarize(payload);
  // Never regress: a payload extracted before the last successful send holds
  // stale-or-equal facts for every row (ReplacingMergeTree orders by
  // submitted_at, not data freshness). Applies to --full too.
  const prev = loadContributed();
  if (prev?.generated && payload.generated < prev.generated) {
    return {
      ok: true,
      dryRun: opts.dryRun,
      install,
      ...sum,
      changed: 0,
      sent: 0,
    };
  }
  const { changed } = opts.full
    ? { changed: payload.rows }
    : diffPayload(payload);
  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      install,
      ...sum,
      changed: changed.length,
      sent: 0,
    };
  }
  const target = opts.url || CONTRIB_URL;
  if (!target) {
    return {
      ok: false,
      dryRun: false,
      install,
      ...sum,
      changed: changed.length,
      sent: 0,
      error: "contribute URL not configured (--url or OC_INSIGHTS_CONTRIB_URL)",
    };
  }
  if (!changed.length) {
    return {
      ok: true,
      dryRun: false,
      install,
      ...sum,
      changed: 0,
      sent: 0,
    };
  }
  if (sending) {
    return {
      ok: false,
      dryRun: false,
      install,
      ...sum,
      changed: changed.length,
      sent: 0,
      error: "send already in progress",
    };
  }
  sending = true;
  try {
    const res = await submit({ ...payload, rows: changed }, target);
    if (res.ok) recordSent(payload);
    const snapshot = res.json.snapshot;
    const serverErr = res.json.error;
    return {
      ok: res.ok,
      dryRun: false,
      install,
      ...sum,
      changed: changed.length,
      sent: res.ok ? changed.length : 0,
      status: res.status,
      snapshot: typeof snapshot === "string" ? snapshot : undefined,
      error: res.ok
        ? undefined
        : typeof serverErr === "string"
          ? serverErr
          : `http ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      dryRun: false,
      install,
      ...sum,
      changed: changed.length,
      sent: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    sending = false;
  }
}
