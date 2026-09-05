// oc.insights — live HTTP for the extract payload, plus the edit ledger.
//
// Plugin API: opencode 1.18+ / 0.0.0-beta loads `export default Plugin.define({ id, setup })`.
// Plugins are instantiated once per location; the HTTP server and the contribute
// scheduler are process-wide singletons.
// Extract runs in a Bun Worker on request (cached); setup never runs the pass.
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
import {
  loadContributor,
  resolveContribute,
  runContribute,
  setContributeEnabled,
} from "./contribute.ts";
import { Insights, type ContribEventName } from "./rpc.ts";
import { getStatus, startScheduler, stopScheduler } from "./scheduler.ts";
import { ensureServer, health } from "./server.ts";

export default Plugin.define({
  id: "oc.insights",
  async setup(ctx) {
    configureExtract({
      ttlMs: readNum(ctx.options.ttlMs, DEFAULT_TTL_MS),
    });
    const port = readNum(ctx.options.port, DEFAULT_PORT);
    const host = readHost(ctx.options.host, DEFAULT_HOST);
    loadContributor();
    const resolved = resolveContribute(ctx.options);
    console.log(
      `[oc.insights] contributions ${resolved.enabled ? "on" : "off"} (source: ${resolved.source})` +
        (resolved.enabled ? ", first check in ~15 min" : ""),
    );
    const ledgerDispose = await setupLedger(ctx);
    try {
      await ensureServer({ port, host });
    } catch (err) {
      console.error("[oc.insights] http server failed", err);
    }
    let emit:
      | ((
          name: ContribEventName,
          data: Record<string, unknown>,
        ) => Promise<void>)
      | null = null;
    const safeEmit = async (
      name: ContribEventName,
      data: Record<string, unknown>,
    ) => {
      try {
        await emit?.(name, data);
      } catch (err) {
        console.error("[oc.insights] event emit failed", err);
      }
    };
    let toolDispose: (() => void) | undefined;
    try {
      const toolReg = await ctx.tool.transform((ed) => {
        ed.add({
          name: "insights_contribute",
          description:
            "Manage anonymous contribution of per-cycle model stats to the global Pragmatikos scorecard: status, enable, disable, or send now. Only 20 numeric/model fields per cycle ever leave the machine.",
          input: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["status", "enable", "disable", "send"],
              },
            },
            required: ["action"],
          } as const,
          execute: async (input) => {
            const action = (input as { action?: string }).action;
            if (action === "enable" || action === "disable") {
              const on = action === "enable";
              const before = resolveContribute(ctx.options);
              if (before.source === "env" || before.source === "options") {
                return {
                  content: `Contributions are forced ${before.enabled ? "on" : "off"} by ${before.source === "env" ? "OC_INSIGHTS_CONTRIBUTE" : "plugin options"}; change that instead.`,
                };
              }
              setContributeEnabled(on);
              await safeEmit("settings", { enabled: on });
              return {
                content: `Contributions ${on ? "enabled" : "disabled"}.`,
              };
            }
            if (action === "send") {
              const r = await runContribute({ dryRun: false, refresh: false });
              if (r.ok && r.sent > 0) {
                await safeEmit("contributed", {
                  rows: r.sent,
                  total: r.rows,
                  snapshot: r.snapshot ?? "",
                  auto: false,
                });
                return {
                  content: `Sent ${r.sent} of ${r.rows} cycles (snapshot ${r.snapshot}).`,
                };
              }
              return {
                content: r.ok
                  ? `Nothing to send: all ${r.rows} cycles already contributed.`
                  : `Send failed: ${r.error ?? "unknown"}.`,
              };
            }
            const st = getStatus();
            return {
              content:
                `Contributions ${st.enabled ? "on" : "off"} (source: ${st.source}). ` +
                `Last sent: ${st.lastSent ?? "never"}. Rows: ${st.rowsTotal}. ` +
                `Next due: ${st.nextDue ?? "—"}.${st.parked ? " Auto-send parked until restart." : ""}`,
            };
          },
        });
      });
      await ctx.tool.reload().catch(() => {});
      toolDispose = () => {
        void toolReg.dispose();
      };
    } catch (err) {
      console.error("[oc.insights] tool register failed", err);
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
      const rpcStatus = () => {
        const st = getStatus();
        return {
          enabled: st.enabled,
          source: st.source,
          lastSent: st.lastSent ?? "",
          rowsTotal: st.rowsTotal,
          nextDue: st.nextDue ?? "",
          parked: st.parked,
        };
      };
      const registration = await ctx.rpc.register(Insights, {
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
        contribute: async (input) => {
          const args = (input ?? {}) as {
            dryRun?: boolean;
            refresh?: boolean;
          };
          const r = await runContribute({
            dryRun: Boolean(args.dryRun),
            refresh: Boolean(args.refresh),
          });
          const out: Record<string, unknown> = {
            ok: r.ok,
            dryRun: r.dryRun,
            install: r.install,
            rows: r.rows,
            changed: r.changed,
            sent: r.sent,
            dayMin: r.dayMin,
            dayMax: r.dayMax,
            models: r.models,
          };
          if (r.status !== undefined) out.status = r.status;
          if (r.snapshot !== undefined) out.snapshot = r.snapshot;
          if (r.error !== undefined) out.error = r.error;
          if (r.ok && !r.dryRun && r.sent > 0) {
            await safeEmit("contributed", {
              rows: r.sent,
              total: r.rows,
              snapshot: r.snapshot ?? "",
              auto: false,
            });
          }
          return out;
        },
        contributeStatus: async () => rpcStatus(),
        setContribute: async (input) => {
          const on = Boolean(
            (input as { enabled?: boolean } | undefined)?.enabled,
          );
          const before = resolveContribute(ctx.options);
          if (before.source === "env" || before.source === "options") {
            return rpcStatus();
          }
          setContributeEnabled(on);
          await safeEmit("settings", { enabled: on });
          return rpcStatus();
        },
      });
      emit = (name, data) => registration.events.emit(name, data);
      rpcDispose = () => {
        void registration.dispose();
      };
    } catch (err) {
      console.error("[oc.insights] rpc register failed", err);
    }
    const stopSchedulerFn = startScheduler({
      emit: (name, data) => safeEmit(name, data),
      subscribe: ctx.event?.subscribe,
      options: ctx.options,
    });
    return () => {
      stopSchedulerFn();
      toolDispose?.();
      ledgerDispose();
      rpcDispose?.();
    };
  },
});
