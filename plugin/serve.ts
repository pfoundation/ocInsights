// Run the HTTP server without OpenCode: bun plugin/serve.ts
import { DEFAULT_HOST, DEFAULT_PORT } from "./config.ts";
import { ensureServer, health } from "./server.ts";

await ensureServer({ port: DEFAULT_PORT, host: DEFAULT_HOST });
const h = await health();
if (!h.ok) {
  console.error("[oc.insights] failed to listen", h.error);
  process.exit(1);
}
console.log(
  `[oc.insights] ${h.url}  (GET /  GET /data.json  GET /health  POST /refresh)`,
);
console.log(`[oc.insights] bind ${h.host}:${h.port}`);
