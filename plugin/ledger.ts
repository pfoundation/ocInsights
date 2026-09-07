// Edit ledger hook — record every file the agent edits, in a store opencode cannot take away.
//
// Why: opencode has silently dropped two data sources already (line counts after 1.15.13,
// edit file paths in the legacy part table after August). The productivity deck attributes
// git commits to sessions by file overlap, which needs exactly one fact per edit: when, which
// session, which file. This appends that fact to an append-only JSONL file we own.
//
// Output:   ~/.local/share/ocInsights/edits.jsonl   (override with OC_EDIT_LEDGER)
// Line:     {"ts":…,"session":"ses_…","agent":"build","call":"call_…",
//            "dir":"/home/ubuntu/dev/x","file":"/abs/path","tool":"edit"}
//
// `call` is the tool call id. opencode instantiates a plugin once per location, so a hook
// may fire more than once per edit; extract dedupes on `call`.
//
// appendLedgerEdit is the shared writer for both host APIs: the v2 setup path
// (ctx.tool.hook) and the v1 server path ("tool.execute.after", whose input
// carries no agent or status — agent is "" there and every call is recorded).
import type { Plugin } from "@opencode-ai/plugin";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { EDIT_TOOLS, LEDGER_PATH } from "./metrics/config.ts";

const LEDGER = LEDGER_PATH;
const PATCH_FILE_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gm;

let ready: Promise<void> | null = null;
const ensure = () =>
  (ready ??= mkdir(dirname(LEDGER), { recursive: true }).then(() => undefined));

function pathsOf(tool: string, input: unknown): string[] {
  const args = (input ?? {}) as Record<string, unknown>;
  const single = args.filePath ?? args.path ?? args.file;
  if (typeof single === "string" && single) return [single];
  const out: string[] = [];
  for (const v of Object.values(args)) {
    if (typeof v !== "string" || !v.includes("*** ")) continue;
    for (const m of v.matchAll(PATCH_FILE_RE)) out.push(m[1]);
  }
  if (!out.length && tool === "apply_patch") return [];
  return out;
}

export type LedgerEdit = {
  directory: string;
  sessionID: string;
  agent: string;
  callID: string;
  tool: string;
  input: unknown;
};

export async function appendLedgerEdit(e: LedgerEdit): Promise<void> {
  const files = pathsOf(e.tool, e.input);
  if (!files.length) return;
  const ts = Date.now();
  const lines = files.map((raw) =>
    JSON.stringify({
      ts,
      session: e.sessionID,
      agent: e.agent,
      call: e.callID,
      dir: e.directory,
      file: isAbsolute(raw) ? raw : resolve(e.directory, raw),
      tool: e.tool,
    }),
  );
  try {
    await ensure();
    await appendFile(LEDGER, lines.join("\n") + "\n");
  } catch {
    // Never let bookkeeping break a tool call.
  }
}

export async function setupLedger(ctx: Plugin.Context): Promise<() => void> {
  const directory = ctx.location.directory;
  const reg = await ctx.tool.hook("execute.after", async (ev) => {
    if (ev.status !== "completed" || !EDIT_TOOLS.has(ev.tool)) return;
    await appendLedgerEdit({
      directory,
      sessionID: ev.sessionID,
      agent: ev.agent,
      callID: ev.id,
      tool: ev.tool,
      input: ev.input,
    });
  });
  return () => {
    void reg.dispose();
  };
}
