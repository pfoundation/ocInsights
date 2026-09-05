// Spawn extract.py on request, coalesce concurrent runs, cache on disk.
import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CACHE_PATH,
  DEFAULT_TTL_MS,
  EXTRACT_PY,
  EXTRACT_TIMEOUT_MS,
  REPO_ROOT,
} from "./config.ts";

type Cache = {
  data: Record<string, unknown>;
  at: number;
};

let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;
let extracting = false;
let lastError: string | null = null;
let ttlMs = DEFAULT_TTL_MS;

export function configureExtract(opts: { ttlMs?: number }): void {
  if (
    opts.ttlMs !== undefined &&
    Number.isFinite(opts.ttlMs) &&
    opts.ttlMs >= 0
  ) {
    ttlMs = opts.ttlMs;
  }
}

function metaOf(data: Record<string, unknown>): {
  generated: string | null;
  sessions: number | null;
} {
  const meta = data.meta as
    | { generated?: unknown; sessions?: unknown }
    | undefined;
  return {
    generated: typeof meta?.generated === "string" ? meta.generated : null,
    sessions: typeof meta?.sessions === "number" ? meta.sessions : null,
  };
}

export function extractStatus(): {
  generated: string | null;
  sessions: number | null;
  age_s: number | null;
  extracting: boolean;
  error: string | null;
  cache: string;
  ttl_ms: number;
} {
  const meta = cache ? metaOf(cache.data) : { generated: null, sessions: null };
  return {
    generated: meta.generated,
    sessions: meta.sessions,
    age_s: cache
      ? Math.max(0, Math.round((Date.now() - cache.at) / 1000))
      : null,
    extracting,
    error: lastError,
    cache: CACHE_PATH,
    ttl_ms: ttlMs,
  };
}

async function loadDisk(): Promise<Cache | null> {
  try {
    const [raw, st] = await Promise.all([
      readFile(CACHE_PATH, "utf8"),
      stat(CACHE_PATH),
    ]);
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== "object") return null;
    return { data, at: st.mtimeMs };
  } catch {
    return null;
  }
}

export async function peekCache(): Promise<void> {
  if (cache) return;
  cache = await loadDisk();
}

function runExtract(): Promise<Cache> {
  extracting = true;
  const started = Date.now();
  console.log("[oc.productivity] extract started");
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [EXTRACT_PY, "--out", CACHE_PATH], {
      cwd: REPO_ROOT,
      env: process.env,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("extract.py timed out"));
    }, EXTRACT_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        void loadDisk().then((disk) => {
          if (!disk) {
            reject(new Error("extract.py wrote no cache"));
            return;
          }
          console.log(
            `[oc.productivity] extract done in ${Date.now() - started}ms`,
          );
          resolve(disk);
        }, reject);
        return;
      }
      reject(
        new Error(stderr.trim() || `extract.py exited ${code ?? "unknown"}`),
      );
    });
  }).finally(() => {
    extracting = false;
  }) as Promise<Cache>;
}

async function getCache(refresh: boolean): Promise<Cache> {
  if (inflight) return inflight;
  if (!refresh) {
    if (cache && Date.now() - cache.at < ttlMs) return cache;
    if (!cache) {
      const disk = await loadDisk();
      if (disk) {
        cache = disk;
        if (Date.now() - disk.at < ttlMs) return disk;
      }
    }
  }
  inflight = mkdir(dirname(CACHE_PATH), { recursive: true })
    .then(() => runExtract())
    .then((next) => {
      cache = next;
      lastError = null;
      return next;
    })
    .catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      console.error("[oc.productivity] extract failed", lastError);
      if (cache) return cache;
      throw err instanceof Error ? err : new Error(lastError);
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export async function getData(
  refresh = false,
): Promise<Record<string, unknown>> {
  const next = await getCache(refresh);
  return next.data;
}

export async function getDataFile(refresh = false): Promise<Buffer> {
  await getCache(refresh);
  return readFile(CACHE_PATH);
}
