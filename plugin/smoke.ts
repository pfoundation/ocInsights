// Prove the HTTP singleton binds and /health answers. Does not run extract.py.
import { clientHost, DEFAULT_HOST, DEFAULT_PORT } from "./config.ts";
import { ensureServer, health, stopServer } from "./server.ts";

await ensureServer({ port: DEFAULT_PORT, host: DEFAULT_HOST });
const h = await health();
const port = h.port ?? DEFAULT_PORT;
const res = await fetch(`http://${clientHost(h.host)}:${port}/health`);
const body = (await res.json()) as {
  ok?: boolean;
  url?: string;
  error?: string;
};
if (!res.ok || !body.ok) {
  console.error("health failed", res.status, body);
  process.exit(1);
}
console.log(`plugin ok: ${body.url ?? h.url}`);
await stopServer();
