// editLedger — record every file the agent edits, in a store opencode cannot take away.
//
// Why: opencode has silently dropped two data sources already (line counts after 1.15.13,
// edit file paths in the legacy part table after August). The productivity deck attributes
// git commits to sessions by file overlap, which needs exactly one fact per edit: when, which
// session, which file. This plugin appends that fact to an append-only JSONL file we own, so
// the deck keeps working even if the message JSON stops carrying paths again.
//
// Plugin API: opencode 1.18+ (the 0.0.0-beta line) loads `export default { id, setup(ctx) }`
// and registers hooks through `ctx.tool.hook("execute.after", …)`. The v1 shape
// (`export const X: Plugin = async ({directory}) => ({"tool.execute.after": …})`) is refused
// with "Plugin must export a default definition with an id and an effect or setup function".
//
// Install:  make install-plugin   (symlinks this file into ~/.config/opencode/plugin/)
// Smoke:    cd /tmp/opencode/ledger-smoke && opencode run "write hi to hello.txt" && make ledger
// Output:   ~/.local/share/ocProductivity/edits.jsonl   (override with OC_EDIT_LEDGER)
// Line:     {"ts":1788449813866,"session":"ses_…","agent":"build","call":"call_…",
//            "dir":"/home/ubuntu/dev/x","file":"/abs/path","tool":"edit"}
//
// `call` is the tool call id. opencode instantiates a plugin once per location (project
// directory), so a hook may fire more than once per edit; extract.py dedupes on `call`.
// `agent` is the role the tool ran under, the same field the deck reads from messages.
//
// Read by extract.py (ledger_edits). Never read by opencode. Safe to delete lines from; never rewrite in place.
import type { Plugin } from "@opencode-ai/plugin";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "multiedit",
  "patch",
]);
const LEDGER =
  process.env.OC_EDIT_LEDGER ??
  join(homedir(), ".local", "share", "ocProductivity", "edits.jsonl");
// apply_patch carries its files inside the patch text, one header per file.
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

const plugin: Plugin = {
  id: "edit-ledger",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const reg = await ctx.tool.hook("execute.after", async (ev) => {
      if (ev.status !== "completed" || !EDIT_TOOLS.has(ev.tool)) return;
      const files = pathsOf(ev.tool, ev.input);
      if (!files.length) return;
      const ts = Date.now();
      const lines = files.map((raw) =>
        JSON.stringify({
          ts,
          session: ev.sessionID,
          agent: ev.agent,
          call: ev.id,
          dir: directory,
          file: isAbsolute(raw) ? raw : resolve(directory, raw),
          tool: ev.tool,
        }),
      );
      try {
        await ensure();
        await appendFile(LEDGER, lines.join("\n") + "\n");
      } catch {
        // Never let bookkeeping break a tool call.
      }
    });
    return () => reg.dispose();
  },
};

export default plugin;
