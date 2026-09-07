// Private file logger — plugin diagnostics must never reach the host terminal.
//
// OpenCode renders plugin stdout/stderr into the TUI, so every runtime log
// call in this package goes here instead of console.*. Destination:
//   <SHARE_DIR>/logs/plugin.log   (+ plugin.log.1 rotation backup)
// config.ts wires the directory after the legacy share-dir migration; until
// then records are buffered in memory (bounded) and flushed on configure.
//
// Guarantees: log calls never throw, never touch the terminal (not even as a
// fallback), never await I/O, and never hold the process open. Rotation takes
// a short-lived lock file so concurrent hosts don't clobber each other; if
// the lock or the filesystem is unavailable the record is dropped, not stalled.
//
// Level via OC_INSIGHTS_LOG_LEVEL (debug|info|warn|error|off, default info);
// invalid values fall back to info. Privacy: callers must not pass secrets,
// prompts, or the install id — details are truncated, not filtered.
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const ORDER: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MAX_MESSAGE = 1000; // chars per message
const MAX_DETAIL = 4000; // chars per serialized detail
const MAX_BUFFER = 200; // early records held before configure
const MAX_BYTES = 1_048_576; // rotate plugin.log at 1 MiB, keep one backup
const LOCK_STALE_MS = 5000; // a rotation lock older than this is abandoned
const SERVICE = "oc.insights";

type Rec = { time: string; level: string; message: string; detail?: unknown };

let dir: string | null = null;
let minLevel = 1;
let muted = false;
let buffer: Rec[] = [];

function parseLevel(v: string | undefined): { n: number; off: boolean } {
  const s = (v ?? "").trim().toLowerCase();
  if (s === "off") return { n: 4, off: true };
  const n = ORDER[s];
  return n === undefined ? { n: 1, off: false } : { n, off: false };
}

const initial = parseLevel(process.env.OC_INSIGHTS_LOG_LEVEL);
minLevel = initial.n;
muted = initial.off;

function detailOf(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v instanceof Error) {
    return { error: v.name, message: v.message.slice(0, MAX_DETAIL) };
  }
  if (typeof v === "string") return v.slice(0, MAX_DETAIL);
  try {
    return (JSON.stringify(v) ?? String(v)).slice(0, MAX_DETAIL);
  } catch {
    return "[unserializable]";
  }
}

function format(r: Rec): string {
  const o: Record<string, unknown> = {
    time: r.time,
    level: r.level,
    service: SERVICE,
    pid: process.pid,
    message: r.message.slice(0, MAX_MESSAGE),
  };
  if (r.detail !== undefined) o.detail = r.detail;
  return JSON.stringify(o) + "\n";
}

function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return; // missing file: nothing to rotate
  }
  if (size < MAX_BYTES) return;
  const lock = join(dir as string, ".plugin.log.lock");
  let mine = false;
  try {
    try {
      writeFileSync(lock, `${process.pid}:${Date.now()}`, { flag: "wx" });
      mine = true;
    } catch {
      // Locked: steal only if stale, otherwise skip rotation (the append
      // below still lands — an oversized log beats a stalled plugin).
      try {
        const ts = Number(readFileSync(lock, "utf8").split(":")[1]);
        if (!Number.isFinite(ts) || Date.now() - ts < LOCK_STALE_MS) return;
        unlinkSync(lock);
        writeFileSync(lock, `${process.pid}:${Date.now()}`, { flag: "wx" });
        mine = true;
      } catch {
        return;
      }
    }
    // Re-check under the lock: another host may have rotated already.
    try {
      if (statSync(file).size < MAX_BYTES) return;
    } catch {
      return;
    }
    try {
      unlinkSync(`${file}.1`);
    } catch {
      // No previous backup.
    }
    renameSync(file, `${file}.1`);
  } catch {
    // Rotation is best-effort.
  } finally {
    if (mine) {
      try {
        unlinkSync(lock);
      } catch {
        // Already gone.
      }
    }
  }
}

function write(rec: Rec): void {
  if (!dir) {
    if (buffer.length >= MAX_BUFFER) buffer.shift();
    buffer.push(rec);
    return;
  }
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "plugin.log");
    rotateIfNeeded(file);
    appendFileSync(file, format(rec));
  } catch {
    // Filesystem unavailable: drop the record. Never the terminal.
  }
}

function emit(level: string, message: string, detail: unknown): void {
  if (muted || ORDER[level]! < minLevel) return;
  write({
    time: new Date().toISOString(),
    level,
    message,
    detail: detailOf(detail),
  });
}

export const log = {
  debug: (message: string, detail?: unknown): void =>
    emit("debug", message, detail),
  info: (message: string, detail?: unknown): void =>
    emit("info", message, detail),
  warn: (message: string, detail?: unknown): void =>
    emit("warn", message, detail),
  error: (message: string, detail?: unknown): void =>
    emit("error", message, detail),
};

/** Wire the destination (config.ts calls this after migration) and flush the
 * early buffer through the current level filter. Safe to call again to
 * redirect (tests) or change the level; drops, never stalls. */
export function configureLog(opts: { dir?: string; level?: string }): void {
  if (typeof opts.level === "string") {
    const p = parseLevel(opts.level);
    minLevel = p.n;
    muted = p.off;
  }
  if (opts.dir) dir = opts.dir;
  if (!dir || buffer.length === 0) return;
  const pending = buffer;
  buffer = [];
  for (const r of pending) {
    if (muted || ORDER[r.level]! < minLevel) continue;
    write(r);
  }
}
