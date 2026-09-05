// Paths and knobs for the live HTTP plugin. extract.py still owns the metrics.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const EXTRACT_PY =
  process.env.OC_EXTRACT ?? join(REPO_ROOT, "extract.py");
export const TEMPLATE = join(REPO_ROOT, "template.html");
export const SHARE_DIR = join(homedir(), ".local", "share", "ocProductivity");
export const CACHE_PATH =
  process.env.OC_PRODUCTIVITY_CACHE ?? join(SHARE_DIR, "data.json");
export const HTTP_SETTINGS_PATH = join(SHARE_DIR, "http.json");

const fileSettings = loadHttpSettings();
export const DEFAULT_HOST = readHost(
  process.env.OC_PRODUCTIVITY_HOST ?? fileSettings.host,
);
export const DEFAULT_PORT = readNum(
  process.env.OC_PRODUCTIVITY_PORT ?? fileSettings.port,
  4173,
);
export const DEFAULT_TTL_MS = readNum(
  process.env.OC_PRODUCTIVITY_TTL_MS ?? fileSettings.ttlMs,
  5 * 60 * 1000,
);
export const EXTRACT_TIMEOUT_MS = 180_000;

export function readNum(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadHttpSettings(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(HTTP_SETTINGS_PATH, "utf8"));
    return raw && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readHost(value: unknown, fallback = "127.0.0.1"): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (s === "0.0.0.0" || s === "127.0.0.1") return s;
  return fallback;
}

/** 0.0.0.0 is a bind address, not a destination. */
export function clientHost(bind: string): string {
  return bind === "0.0.0.0" ? "127.0.0.1" : bind;
}
