// oc.productivity — live HTTP for the extract payload, plus the edit ledger.
//
// Plugin API: opencode 1.18+ / 0.0.0-beta loads `export default Plugin.define({ id, setup })`.
// Plugins are instantiated once per location; the HTTP server is a process-wide singleton.
// extract.py is spawned on request (cached); setup never runs the 15 s pass.
//
// Install:  make install-plugin
// Live:     http://127.0.0.1:4173/           (deck)
//           http://127.0.0.1:4173/data.json  (extract payload)
//           http://127.0.0.1:4173/health
import { Plugin } from "@opencode-ai/plugin";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TTL_MS,
  readHost,
  readNum,
} from "./config.ts";
import { configureExtract, getData } from "./extract.ts";
import { setupLedger } from "./ledger.ts";
import { Productivity } from "./rpc.ts";
import { ensureServer, health } from "./server.ts";

export default Plugin.define({
  id: "oc.productivity",
  async setup(ctx) {
    configureExtract({
      ttlMs: readNum(ctx.options.ttlMs, DEFAULT_TTL_MS),
    });
    const port = readNum(ctx.options.port, DEFAULT_PORT);
    const host = readHost(ctx.options.host, DEFAULT_HOST);
    const ledgerDispose = await setupLedger(ctx);
    try {
      await ensureServer({ port, host });
    } catch (err) {
      console.error("[oc.productivity] http server failed", err);
    }
    let rpcDispose: (() => void) | undefined;
    try {
      const rpcHealth = async () => {
        const h = await health();
        return {
          ok: h.ok,
          host: h.host,
          port: h.port ?? 0,
          url: h.url,
          generated: h.generated ?? "",
          sessions: h.sessions ?? 0,
          age_s: h.age_s ?? -1,
          extracting: h.extracting,
          error: h.error ?? "",
          cache: h.cache,
        };
      };
      const registration = await ctx.rpc.register(Productivity, {
        status: async () => rpcHealth(),
        refresh: async () => {
          await getData(true);
          return rpcHealth();
        },
        get: async (input) => {
          const refresh = Boolean(
            (input as { refresh?: boolean } | undefined)?.refresh,
          );
          if (refresh) await getData(true);
          const h = await health();
          return {
            url: h.url ? `${h.url}/data.json` : "",
            generated: h.generated ?? "",
            sessions: h.sessions ?? 0,
            extracting: h.extracting,
          };
        },
      });
      rpcDispose = () => {
        void registration.dispose();
      };
    } catch (err) {
      console.error("[oc.productivity] rpc register failed", err);
    }
    return () => {
      ledgerDispose();
      rpcDispose?.();
    };
  },
});
