// Auto-contribute scheduler: one ticking loop per process. First send ~3 min
// after load when quiet; then every 6 h. Quiet = no session activity for
// 10 min, tracked from the event stream. Cross-process coordination is the
// contributed.json lastSent on disk (sends are idempotent anyway).
//
// Hot-reload generations share their data (start, lastActive, parked) through
// globalThis but keep their own timer: the old generation's cleanup stops its
// loop, the new setup starts a fresh one. Refs keep one location's dispose
// from stopping another's loop.
import {
  QUIET_MS,
  contributeFileStatus,
  recordFail,
  resolveContribute,
  runContribute,
  type ContributeStatus,
} from "./contribute.ts";
import type { ContribEventName } from "./rpc.ts";

const TICK_MS = 60 * 1000;
const GATE = Symbol.for("oc.productivity.scheduler");
const ACTIVITY_PREFIXES = [
  "session.status",
  "session.idle",
  "session.execution",
  "session.tool",
  "session.step",
  "session.text",
  "session.reasoning",
  "session.message",
  "session.compaction",
];

export type Emitter = (
  name: ContribEventName,
  data: Record<string, unknown>,
) => Promise<void> | void;
export type Subscribe = (opts?: {
  signal?: AbortSignal;
}) => AsyncIterable<{ type: string }>;

type Shared = {
  start: number;
  lastActive: number;
  parked: string | null;
  waited: boolean;
};

let refs = 0;
let timer: ReturnType<typeof setInterval> | null = null;
let abort: AbortController | null = null;
let emitter: Emitter | null = null;
let options: Readonly<Record<string, unknown>> | undefined;

function shared(): Shared {
  const g = globalThis as Record<symbol, Shared | undefined>;
  let s = g[GATE];
  if (!s) {
    // Assume quiet before load: a mid-turn session emits within seconds and
    // pushes lastActive forward, so the first send waits for it anyway.
    s = {
      start: Date.now(),
      lastActive: Date.now() - QUIET_MS - 60_000,
      parked: null,
      waited: false,
    };
    g[GATE] = s;
  }
  return s;
}

function isActivity(t: string): boolean {
  return ACTIVITY_PREFIXES.some((p) => t === p || t.startsWith(`${p}.`));
}

export function schedulerOptions():
  Readonly<Record<string, unknown>> | undefined {
  return options;
}

export function getStatus(): ContributeStatus & { parked: boolean } {
  const s = shared();
  return {
    ...contributeFileStatus(Date.now(), s.start, options),
    parked: s.parked !== null,
  };
}

async function tick(): Promise<void> {
  const s = shared();
  if (s.parked) return;
  const { enabled } = resolveContribute(options);
  if (!enabled) {
    s.waited = false;
    return;
  }
  const st = contributeFileStatus(Date.now(), s.start, options);
  if (st.nextDue && Date.parse(st.nextDue) > Date.now()) {
    s.waited = false;
    return;
  }
  if (Date.now() - s.lastActive < QUIET_MS) {
    if (!s.waited) {
      s.waited = true;
      console.log(
        "[oc.productivity] contribution due, waiting for a quiet moment",
      );
    }
    return;
  }
  s.waited = false;
  try {
    const res = await runContribute({ dryRun: false, refresh: false });
    if (!res.ok && res.status === 400) {
      s.parked = res.error ?? "http 400";
      console.error(
        `[oc.productivity] contribute parked until restart: server rejected the payload (${s.parked})`,
      );
    } else if (!res.ok) {
      recordFail();
      console.error(
        `[oc.productivity] contribute failed (${res.error ?? "unknown"}); retrying later`,
      );
    } else if (res.sent > 0) {
      console.log(
        `[oc.productivity] contributed ${res.sent} of ${res.rows} cycles` +
          (res.snapshot ? `, snapshot ${res.snapshot}` : ""),
      );
      try {
        await emitter?.("contributed", {
          rows: res.sent,
          total: res.rows,
          snapshot: res.snapshot ?? "",
          auto: true,
        });
      } catch (err) {
        console.error("[oc.productivity] contribute event emit failed", err);
      }
    } else {
      console.log("[oc.productivity] contribute: no changes, skipping");
    }
  } catch (err) {
    recordFail();
    console.error(
      `[oc.productivity] contribute failed (${err instanceof Error ? err.message : String(err)}); retrying later`,
    );
  }
}

export function startScheduler(opts: {
  emit: Emitter;
  subscribe?: Subscribe;
  options?: Readonly<Record<string, unknown>>;
}): () => void {
  const s = shared();
  if (timer) {
    refs += 1;
    return stopScheduler;
  }
  refs = 1;
  emitter = opts.emit;
  options = opts.options;
  if (typeof opts.subscribe === "function") {
    const ctl = new AbortController();
    abort = ctl;
    const sub = opts.subscribe;
    void (async () => {
      try {
        for await (const ev of sub({ signal: ctl.signal })) {
          if (ev && typeof ev.type === "string" && isActivity(ev.type)) {
            s.lastActive = Date.now();
          }
        }
      } catch {
        // Aborted on unload.
      }
    })();
  }
  timer = setInterval(() => {
    void tick();
  }, TICK_MS);
  // Never hold a short-lived `opencode2 run` open; dispose clears the timer.
  const t = timer as unknown as { unref?: () => void };
  if (typeof t.unref === "function") t.unref();
  return stopScheduler;
}

export function stopScheduler(): void {
  refs -= 1;
  if (refs > 0) return;
  refs = 0;
  if (timer) clearInterval(timer);
  timer = null;
  abort?.abort();
  abort = null;
}
