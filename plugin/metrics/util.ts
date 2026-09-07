// Shared helpers. pyRound matches CPython 3 half-to-even on the actual float.
import { isAbsolute, posix } from "node:path";
import { BUILD_AGENTS, PLAN_AGENTS } from "./config.ts";

const CANON: [RegExp, (m: RegExpMatchArray) => string][] = [
  [
    /^(claude-(?:opus|sonnet|haiku))-?(\d)[.-]?(\d)$/,
    (m) => `${m[1]}-${m[2]}.${m[3]}`,
  ],
  [
    /^(claude-(?:opus|sonnet|haiku))-(\d)(\d)$/,
    (m) => `${m[1]}-${m[2]}.${m[3]}`,
  ],
  [/^(claude-(?:opus|sonnet|haiku))-(\d)$/, (m) => `${m[1]}-${m[2]}`],
  [/^(claude-fable)-(\d)-(\d)$/, (m) => `${m[1]}-${m[2]}.${m[3]}`],
  [/^(claude-fable)-(\d)$/, (m) => `${m[1]}-${m[2]}`],
];

export function canon(modelId: string): string {
  let i = modelId.split("/").pop() ?? modelId;
  i = i.replace(/-\d{8}$/, "").replaceAll("antigravity-", "");
  for (const [pat, fmt] of CANON) {
    const m = i.match(pat);
    if (m) return fmt(m);
  }
  return i;
}

export function roleOf(agent: string): number {
  return BUILD_AGENTS.has(agent) ? 2 : PLAN_AGENTS.has(agent) ? 1 : 0;
}

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): string[] {
  const out: string[] = [];
  const d0 = Date.parse(`${a}T00:00:00Z`);
  const d1 = Date.parse(`${b}T00:00:00Z`);
  for (let t = d0; t <= d1; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** Python os.path.relpath(path, base); reject anything that walks above base. */
export function relFile(
  path: string | null | undefined,
  base: string,
): string | null {
  if (!path) return null;
  if (!isAbsolute(path)) return path.replace(/\\/g, "/");
  let rel = posix.relative(base, path);
  if (rel === "") rel = ".";
  return rel.startsWith("..") ? null : rel.replace(/\\/g, "/");
}

const _bits = new DataView(new ArrayBuffer(8));

/** Exact IEEE sign × num/den for a finite float. */
function floatRatio(x: number): { sign: number; num: bigint; den: bigint } {
  _bits.setFloat64(0, x);
  const hi = BigInt(_bits.getUint32(0));
  const lo = BigInt(_bits.getUint32(4));
  const bits = (hi << 32n) | lo;
  const sign = bits >> 63n !== 0n ? -1 : 1;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0xfffffffffffffn;
  if (expBits === 0) return { sign, num: frac, den: 1n << 1074n };
  const mantissa = (1n << 52n) + frac;
  const exp = BigInt(expBits - 1023 - 52);
  if (exp >= 0n) return { sign, num: mantissa << exp, den: 1n };
  return { sign, num: mantissa, den: 1n << -exp };
}

/** Python 3 round(x, ndigits): half-to-even on the exact float. */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  const { sign, num, den } = floatRatio(x);
  const scale = 10n ** BigInt(Math.abs(ndigits));
  let n = num;
  let d = den;
  if (ndigits >= 0) n *= scale;
  else d *= scale;
  const q = n / d;
  const r = n % d;
  let rounded = q;
  if (r * 2n > d) rounded = q + 1n;
  else if (r * 2n === d && q % 2n !== 0n) rounded = q + 1n;
  const mag = Number(rounded);
  if (ndigits > 0) return (sign * mag) / 10 ** ndigits;
  if (ndigits < 0) return sign * mag * 10 ** -ndigits;
  return sign * mag;
}

export class Counter<K> {
  readonly map = new Map<K, number>();
  add(key: K, n = 1): this {
    this.map.set(key, (this.map.get(key) ?? 0) + n);
    return this;
  }
  get(key: K): number {
    return this.map.get(key) ?? 0;
  }
  get size(): number {
    return this.map.size;
  }
  keys(): IterableIterator<K> {
    return this.map.keys();
  }
  values(): IterableIterator<number> {
    return this.map.values();
  }
  entries(): IterableIterator<[K, number]> {
    return this.map.entries();
  }
  mostCommon(n?: number): [K, number][] {
    const items = [...this.map.entries()];
    items.sort((a, b) => b[1] - a[1]);
    return n === undefined ? items : items.slice(0, n);
  }
}

export function pairKey(model: string, prov: string, variant = ""): string {
  return model + "\x1f" + prov + "\x1f" + variant;
}

export function splitPair(k: string): [string, string, string] {
  const [m = "", p = "", v = ""] = k.split("\x1f");
  return [m, p, v];
}

// Dominant pair, summed over variants so the pair is identical to the
// pre-variant count (first-seen wins ties). Destructure the first two.
export function topPair(mp: Counter<string>): [string, string] | null {
  if (mp.size === 0) return null;
  const tot = new Map<string, number>();
  for (const [k, n] of mp.entries()) {
    const [m, p] = splitPair(k);
    const pk = m + "\x1f" + p;
    tot.set(pk, (tot.get(pk) ?? 0) + n);
  }
  let best = "";
  let bestN = -1;
  for (const [pk, n] of tot) {
    if (n > bestN) {
      best = pk;
      bestN = n;
    }
  }
  const i = best.indexOf("\x1f");
  return [best.slice(0, i), best.slice(i + 1)];
}

// Most frequent variant within one pair (first-seen wins ties); null when
// the pair never occurs in the counter.
export function topVariant(
  mp: Counter<string>,
  model: string,
  prov: string,
): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [k, n] of mp.entries()) {
    const [m, p, v] = splitPair(k);
    if (m !== model || p !== prov) continue;
    if (n > bestN) {
      best = v;
      bestN = n;
    }
  }
  return best;
}

// Display bucket for session_v2.version: "1.18" for releases, "beta" for the
// 0.0.0-beta-N lineage, raw string for anything else.
export function versionBucket(v: string): string {
  if (/^0\.0\.0-beta/i.test(v)) return "beta";
  const m = v.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : v;
}

export function unitKey(sid: string, ci: number): string {
  return sid + "\x1f" + ci;
}

export function splitUnit(k: string): [string, number] {
  const i = k.lastIndexOf("\x1f");
  return [k.slice(0, i), Number(k.slice(i + 1))];
}

export function bisectLeft(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function bisectRight(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid]! <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function mapToObj<V, R = V>(
  m: Map<string, V>,
  mapVal?: (v: V) => R,
): Record<string, R> {
  const o: Record<string, R> = {};
  for (const [k, v] of m) o[k] = mapVal ? mapVal(v) : (v as unknown as R);
  return o;
}

export function sum(xs: Iterable<number>): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function firstMaxKey<K>(items: Iterable<K>, keyFn: (k: K) => number): K {
  let best: K | undefined;
  let bestV = -Infinity;
  for (const k of items) {
    const v = keyFn(k);
    if (best === undefined || v > bestV) {
      best = k;
      bestV = v;
    }
  }
  if (best === undefined) throw new Error("firstMaxKey of empty");
  return best;
}

/** Upper-middle median (matches the deck's medS); null when empty. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

export function minWhere(
  xs: Iterable<number>,
  pred: (x: number) => boolean,
): number | null {
  let best: number | null = null;
  for (const x of xs) {
    if (!pred(x)) continue;
    if (best === null || x < best) best = x;
  }
  return best;
}

export function isoMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function truncMs(tsSeconds: number): number {
  return Math.trunc(tsSeconds * 1000);
}
