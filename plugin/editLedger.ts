// editLedger — record every file the agent edits, in a store opencode cannot take away.
//
// Why: opencode has silently dropped two data sources already (line counts after 1.15.13,
// edit file paths after the 0.0.0-beta series). The productivity deck attributes git commits
// to sessions by file overlap, which needs exactly one fact per edit: when, which session,
// which file. This plugin appends that fact to an append-only JSONL file we own.
//
// Install:  make install-plugin   (symlinks this file into ~/.config/opencode/plugin/)
// Output:   ~/.local/share/ocProductivity/edits.jsonl   (override with OC_EDIT_LEDGER)
// Line:     {"ts":1788449813866,"session":"ses_…","dir":"/home/ubuntu/dev/x","file":"/abs/path","tool":"edit"}
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

export const EditLedger: Plugin = async ({ directory }) => {
  let ready: Promise<void> | null = null;
  const ensure = () =>
    (ready ??= mkdir(dirname(LEDGER), { recursive: true }).then(
      () => undefined,
    ));
  return {
    "tool.execute.after": async (input, output) => {
      if (!EDIT_TOOLS.has(input.tool)) return;
      const args = (input.args ?? {}) as Record<string, unknown>;
      const raw = (args.filePath ??
        args.path ??
        args.file ??
        output?.title ??
        "") as string;
      if (!raw) return;
      const file = isAbsolute(raw) ? raw : resolve(directory, raw);
      const line = JSON.stringify({
        ts: Date.now(),
        session: input.sessionID,
        dir: directory,
        file,
        tool: input.tool,
      });
      try {
        await ensure();
        await appendFile(LEDGER, line + "\n");
      } catch {
        // Never let bookkeeping break a tool call.
      }
    },
  };
};
