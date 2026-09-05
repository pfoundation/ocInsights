// Run the metric extract in a Bun Worker (subprocess fallback), coalesce, cache on disk.
import { spawn } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CACHE_PATH,
  CLI_TS,
  DEFAULT_TTL_MS,
  EXTRACT_TIMEOUT_MS,
  REPO_ROOT,
} from "./config.ts";

type Cache = {
  data: Record<string, unknown>;
  at: number;
};

export type ExtractRunner = "worker" | "subprocess" | null;

let cache: Cache | null = null;
let inflight: Promise<Cache> | null = null;
let extracting = false;
let lastError: string | null = null;
let lastRunner: ExtractRunner = null;
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
    { generated?: unknown; sessions?: unknown } | undefined;
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
  runner: ExtractRunner;
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
    runner: lastRunner,
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

function bunBin(): string {
  if (process.env.OC_BUN) return process.env.OC_BUN;
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    return Bun.which("bun") ?? "bun";
  }
  return "bun";
}

type WorkerMsg = { ok?: boolean; summary?: string; error?: string };

function runWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let gotMessage = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        worker.terminate();
      } catch {
        /* already gone */
      }
      if (err) reject(err);
      else resolve();
    };
    let worker: Worker;
    try {
      worker = new Worker(new URL("./metrics/worker.ts", import.meta.url).href);
    } catch (err) {
      reject(
        Object.assign(err instanceof Error ? err : new Error(String(err)), {
          loadFailure: true,
        }),
      );
      return;
    }
    lastRunner = "worker";
    const timer = setTimeout(() => {
      finish(new Error("extract timed out"));
    }, EXTRACT_TIMEOUT_MS);
    worker.addEventListener("error", (ev) => {
      const msg = ev instanceof ErrorEvent ? ev.message : String(ev);
      finish(
        Object.assign(new Error(msg || "worker error"), {
          loadFailure: !gotMessage,
        }),
      );
    });
    worker.addEventListener("message", (ev: MessageEvent<WorkerMsg>) => {
      gotMessage = true;
      const msg = ev.data;
      if (msg && msg.ok) {
        if (msg.summary) console.log(`[oc.insights] ${msg.summary}`);
        finish();
        return;
      }
      finish(new Error(msg?.error || "extract failed"));
    });
    worker.postMessage({ out: CACHE_PATH });
  });
}

function runSubprocess(): Promise<void> {
  lastRunner = "subprocess";
  return new Promise((resolve, reject) => {
    const child = spawn(bunBin(), [CLI_TS, "extract", "--out", CACHE_PATH], {
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
      reject(new Error("extract timed out"));
    }, EXTRACT_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `extract exited ${code ?? "unknown"}`));
    });
  });
}

function runExtract(): Promise<Cache> {
  extracting = true;
  const started = Date.now();
  console.log("[oc.insights] extract started");
  return (
    typeof Worker === "undefined"
      ? runSubprocess()
      : runWorker().catch((err: Error & { loadFailure?: boolean }) => {
          if (err.loadFailure) {
            console.warn(
              "[oc.insights] worker failed to load, falling back to bun subprocess",
              err.message,
            );
            return runSubprocess();
          }
          throw err;
        })
  )
    .then(() => loadDisk())
    .then((disk) => {
      if (!disk) throw new Error("extract wrote no cache");
      console.log(`[oc.insights] extract done in ${Date.now() - started}ms`);
      return disk;
    })
    .finally(() => {
      extracting = false;
    });
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
      console.error("[oc.insights] extract failed", lastError);
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
