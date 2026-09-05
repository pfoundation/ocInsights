/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui";
import { Productivity } from "./rpc.ts";

type Share = {
  enabled: boolean;
  source: string;
  lastSent: string;
  rowsTotal: number;
  nextDue: string;
};

const EMPTY: Share = {
  enabled: true,
  source: "default",
  lastSent: "",
  rowsTotal: 0,
  nextDue: "",
};

// The RPC client returns unknown for JSON-schema defs; adapt defensively.
function asShare(v: unknown): Share {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    source: typeof o.source === "string" ? o.source : "default",
    lastSent: typeof o.lastSent === "string" ? o.lastSent : "",
    rowsTotal: typeof o.rowsTotal === "number" ? o.rowsTotal : 0,
    nextDue: typeof o.nextDue === "string" ? o.nextDue : "",
  };
}

function asUrl(v: unknown): string {
  const o = (v ?? {}) as Record<string, unknown>;
  return typeof o.url === "string" && o.url ? o.url : "http://127.0.0.1:4173/";
}

function asContrib(v: unknown): { sent: number; rows: number } {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    sent: typeof o.sent === "number" ? o.sent : 0,
    rows: typeof o.rows === "number" ? o.rows : 0,
  };
}

async function refresh(
  context: Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0],
): Promise<Share> {
  try {
    return asShare(await context.client.rpc(Productivity).contributeStatus({}));
  } catch {
    return { ...EMPTY };
  }
}

async function openInsights(
  context: Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0],
): Promise<void> {
  let url = "http://127.0.0.1:4173/";
  try {
    const raw = asUrl(await context.client.rpc(Productivity).status({}));
    url = raw.endsWith("/") ? raw : `${raw}/`;
  } catch {
    // Fall through to the default URL.
  }
  try {
    const plat = process.platform;
    const cmd =
      plat === "darwin"
        ? ["open", url]
        : plat === "win32"
          ? ["cmd", "/c", "start", "", url]
          : [
              ...(process.env.BROWSER
                ? process.env.BROWSER.split(" ")
                : ["xdg-open"]),
              url,
            ];
    Bun.spawn(cmd, {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    }).unref();
  } catch {
    // No opener (SSH, no display): the toast below carries the URL.
  }
  context.ui.toast.show({ message: `Insights: ${url}` });
}

export default Plugin.define({
  id: "oc.productivity.tui",
  setup(context) {
    const openDialog = async (): Promise<void> => {
      const st = await refresh(context);
      const picked = await context.ui.dialog.select({
        title: "Insight contribution",
        options: [
          {
            title: st.enabled
              ? "Turn insight contribution off"
              : "Turn insight contribution on",
            value: "toggle",
          },
          { title: "Send now", value: "send" },
          { title: "Open insights", value: "open" },
          { title: "Show status", value: "status" },
        ],
      });
      if (picked === "toggle") {
        try {
          const next = asShare(
            await context.client
              .rpc(Productivity)
              .setContribute({ enabled: !st.enabled }),
          );
          await refresh(context);
          context.ui.toast.show({
            message:
              next.enabled === st.enabled
                ? `Insight contribution is forced ${next.enabled ? "on" : "off"} by ${next.source}; change that instead`
                : `Insight contribution ${next.enabled ? "on" : "off"}`,
          });
        } catch {
          context.ui.toast.show({ message: "Toggle failed" });
        }
      } else if (picked === "send") {
        try {
          const r = asContrib(
            await context.client.rpc(Productivity).contribute({}),
          );
          await refresh(context);
          context.ui.toast.show({
            message: r.sent
              ? `Sent ${r.sent} of ${r.rows} cycles`
              : "Nothing new: already contributed",
          });
        } catch {
          context.ui.toast.show({ message: "Send failed" });
        }
      } else if (picked === "open") {
        await openInsights(context);
      } else if (picked === "status") {
        const cur = await refresh(context);
        await context.ui.dialog.alert({
          title: "Insight contribution",
          message:
            `Insight contribution ${cur.enabled ? "on" : "off"} (source: ${cur.source})\n` +
            `Last sent: ${cur.lastSent || "never"}\n` +
            `Rows: ${cur.rowsTotal}\n` +
            `Next due: ${cur.nextDue || "—"}`,
        });
      }
    };

    // One layer per command: a rejected keybind must not take down the other.
    const insightsLayer = () => ({
      mode: "global" as const,
      priority: 10,
      commands: [
        {
          id: "oc.productivity.insights",
          title: "Open insights",
          group: "Productivity",
          bind: "ctrl+alt+i" as const,
          palette: true as const,
          slash: { name: "insights" },
          run: () => void openInsights(context),
        },
      ],
    });
    try {
      context.keymap.layer(insightsLayer);
    } catch {
      // Keymap not ready yet; retry once the app slot renders.
      context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(insightsLayer);
          return null;
        },
      });
    }
    const contributeLayer = () => ({
      mode: "global" as const,
      priority: 10,
      commands: [
        {
          id: "oc.productivity.contribute",
          title: "Insight contribution settings",
          group: "Productivity",
          palette: true as const,
          slash: { name: "contribute" },
          run: () => void openDialog(),
        },
      ],
    });
    try {
      context.keymap.layer(contributeLayer);
    } catch {
      context.ui.slot({
        append: "app",
        render: () => {
          context.keymap.layer(contributeLayer);
          return null;
        },
      });
    }

    let stopContributed = () => {};
    try {
      stopContributed = context.client
        .rpc(Productivity)
        .events.on("contributed", (event) => {
          const d = (event as { data?: unknown })?.data as
            Record<string, unknown> | undefined;
          if (d?.auto === true) {
            const rows = typeof d.rows === "number" ? d.rows : 0;
            const total = typeof d.total === "number" ? d.total : 0;
            context.ui.toast.show({
              message: `Contributed ${rows} of ${total} cycles to the global scorecard`,
            });
          }
        });
    } catch {
      // RPC may not be ready yet; dialogs refresh on open anyway.
    }

    return () => {
      stopContributed();
    };
  },
});
