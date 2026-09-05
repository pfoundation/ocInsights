// Process-wide singleton HTTP server. Plugins load once per location; only the first bind wins.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { clientHost, DEFAULT_HOST, DEFAULT_PORT, TEMPLATE } from "./config.ts";
import { renderDeck } from "./build.ts";
import {
  resolveContribute,
  runContribute,
  setContributeEnabled,
} from "./contribute.ts";
import { extractStatus, getData, getDataFile, peekCache } from "./extract.ts";
import { getStatus, schedulerOptions } from "./scheduler.ts";
import type { ContributeStatus } from "./contribute.ts";

export type Health = {
  ok: boolean;
  host: string;
  port: number | null;
  url: string;
  generated: string | null;
  sessions: number | null;
  age_s: number | null;
  extracting: boolean;
  error: string | null;
  cache: string;
  runner: string | null;
  contribute: ContributeStatus & { parked: boolean };
};

let server: Server | null = null;
let startPromise: Promise<void> | null = null;
let actualPort: number | null = null;
let bindHost = DEFAULT_HOST;
let owned = false;
let bindError: string | null = null;

export async function health(): Promise<Health> {
  await peekCache();
  const ex = extractStatus();
  const port = actualPort;
  return {
    ok: port !== null,
    host: bindHost,
    port,
    url: port !== null ? `http://${clientHost(bindHost)}:${port}` : "",
    generated: ex.generated,
    sessions: ex.sessions,
    age_s: ex.age_s,
    extracting: ex.extracting,
    error: bindError ?? ex.error,
    cache: ex.cache,
    runner: ex.runner,
    contribute: getStatus(),
  };
}

function isLoopback(req: IncomingMessage): boolean {
  const peer = req.socket.remoteAddress ?? "";
  return peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  type: string,
): void {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "content-length": buf.length,
  });
  res.end(buf);
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", `http://${clientHost(bindHost)}`);
  try {
    if (method === "GET" && url.pathname === "/health") {
      send(
        res,
        200,
        JSON.stringify(await health()),
        "application/json; charset=utf-8",
      );
      return;
    }
    if (method === "GET" && url.pathname === "/data.json") {
      const buf = await getDataFile(false);
      send(res, 200, buf, "application/json; charset=utf-8");
      return;
    }
    if (method === "POST" && url.pathname === "/refresh") {
      await getData(true);
      send(
        res,
        200,
        JSON.stringify(await health()),
        "application/json; charset=utf-8",
      );
      return;
    }
    // Loopback only even when bound to 0.0.0.0: contributing is the local
    // user's explicit act, and the install id must not leave the machine.
    if (method === "POST" && url.pathname === "/contribute") {
      if (!isLoopback(req)) {
        send(
          res,
          403,
          JSON.stringify({ ok: false, error: "loopback only" }),
          "application/json; charset=utf-8",
        );
        return;
      }
      const out = await runContribute({
        dryRun: url.searchParams.get("dry") === "1",
        refresh: false,
      });
      send(res, 200, JSON.stringify(out), "application/json; charset=utf-8");
      return;
    }
    if (method === "POST" && url.pathname === "/contribute-toggle") {
      if (!isLoopback(req)) {
        send(
          res,
          403,
          JSON.stringify({ ok: false, error: "loopback only" }),
          "application/json; charset=utf-8",
        );
        return;
      }
      // The file switch is meaningless when env/options override it; say so
      // instead of pretending to toggle.
      const before = resolveContribute(schedulerOptions());
      if (before.source === "env" || before.source === "options") {
        send(
          res,
          200,
          JSON.stringify({
            ok: false,
            ...getStatus(),
            error: `overridden by ${before.source}`,
          }),
          "application/json; charset=utf-8",
        );
        return;
      }
      setContributeEnabled(!before.enabled);
      send(
        res,
        200,
        JSON.stringify({ ok: true, ...getStatus() }),
        "application/json; charset=utf-8",
      );
      return;
    }
    if (
      method === "GET" &&
      (url.pathname === "/" || url.pathname === "/index.html")
    ) {
      const data = await getData(false);
      const html = await renderDeck(data, TEMPLATE, true);
      send(res, 200, html, "text/html; charset=utf-8");
      return;
    }
    send(res, 404, "not found\n", "text/plain; charset=utf-8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send(
      res,
      503,
      JSON.stringify({ error: msg }),
      "application/json; charset=utf-8",
    );
  }
}

function listen(port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      void handle(req, res);
    });
    const onError = (err: NodeJS.ErrnoException) => {
      s.off("listening", onListen);
      reject(err);
    };
    const onListen = () => {
      s.off("error", onError);
      const addr = s.address();
      actualPort = typeof addr === "object" && addr ? addr.port : port;
      bindHost = host;
      server = s;
      owned = true;
      bindError = null;
      const local = `http://${clientHost(host)}:${actualPort}`;
      console.log(
        host === "0.0.0.0"
          ? `[oc.productivity] listening on ${host}:${actualPort} (${local})`
          : `[oc.productivity] listening on ${local}`,
      );
      resolve();
    };
    s.once("error", onError);
    s.once("listening", onListen);
    s.listen(port, host);
  });
}

export async function ensureServer(opts?: {
  port?: number;
  host?: string;
}): Promise<void> {
  if (actualPort !== null) return;
  if (startPromise) return startPromise;
  const port = opts?.port ?? DEFAULT_PORT;
  const host = opts?.host ?? DEFAULT_HOST;
  startPromise = listen(port, host)
    .catch((err: NodeJS.ErrnoException) => {
      if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
        actualPort = port;
        bindHost = host;
        owned = false;
        bindError = null;
        console.log(`[oc.productivity] ${host}:${port} already bound, reusing`);
        return;
      }
      bindError = err instanceof Error ? err.message : String(err);
      actualPort = null;
      throw err;
    })
    .finally(() => {
      startPromise = null;
    });
  return startPromise;
}

export async function stopServer(): Promise<void> {
  if (!owned || !server) return;
  const s = server;
  server = null;
  owned = false;
  actualPort = null;
  bindHost = DEFAULT_HOST;
  await new Promise<void>((resolve, reject) => {
    s.close((err) => (err ? reject(err) : resolve()));
  });
}
