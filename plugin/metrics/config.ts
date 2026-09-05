// Extract knobs. One place for constants — plugin/ledger.ts imports EDIT_TOOLS from here.
import { homedir } from "node:os";
import { join } from "node:path";

export const DB_PATH =
  process.env.OC_DB ??
  join(homedir(), ".local", "share", "opencode", "opencode.db");
export const DEV_ROOT = process.env.OC_DEV_ROOT ?? join(homedir(), "dev");
export const GIT_AUTHORS = new Set(
  (process.env.OC_GIT_AUTHORS ?? "Jud Saoud,judsd").split(",").filter(Boolean),
);
export const WINDOW_DAYS = 90; // daily charts (hours by project, models per day)
export const HEARTBEAT_CAP_MS = 600_000; // gap between messages credited as active, max
export const HEARTBEAT_SEED_MS = 60_000; // credit for the first message of a session
export const LINES_CAP = 10_000; // per-session line cap for the legacy line-count column
export const LINES_CUTOFF = "2026-06-06"; // summary_additions stopped being written at opencode 1.16.2
export const COMMIT_WINDOW_H = 72; // a commit's attribution window, capped
export const COMMIT_GRACE_S = 300; // messages up to this long after a commit still count
export const SHIP_DAYS = 7; // a session "shipped" if its edits landed in a commit within this many days
export const LEDGER_PATH =
  process.env.OC_EDIT_LEDGER ??
  join(homedir(), ".local", "share", "ocProductivity", "edits.jsonl");
export const PART_BACKFILL = true; // read edit paths from the legacy `part` table (Feb–Aug 2026)
export const BUILD_AGENTS = new Set([
  "build",
  "Sisyphus-Junior",
  "Sisyphus (Ultraworker)",
  "BuildAgent",
  "beads-task-agent",
  "general",
]);
export const PLAN_AGENTS = new Set(["plan", "Metis (Plan Consultant)"]);
export const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "multiedit",
  "patch",
]);
export const VERIFY_RE =
  /\b(vitest|jest|pytest|playwright test|go (test|vet|build)|cargo (test|build|check|clippy)|(npm|pnpm|bun|yarn)( run)? (test|check|verify|lint|build|typecheck)|(bunx|npx) tsc|tsc|next build|bun build|eslint|biome|ruff|golangci|clippy|mypy|pyright|g?make|node verify|verify\.mjs)\b/;
export const COMMIT_RE = /\bgit\s+commit\b/;
export const AGENT_RE = /"agent":"([^"]+)"/;
// state.error.message on tool parts the human stopped: aborts, interrupts,
// cancels, permission rejections/declines. Counted as abort, not as terr/eerr.
export const ABORT_RE =
  /Tool execution aborted|Tool execution (was )?interrupted|Task cancelled|The user (rejected|declined)/i;
// "Tool execution was interrupted before VN migration" is a backfill artefact,
// not a human act and not a model error: neither abort nor terr/eerr.
export const MIGRATION_RE = /before .*migration/i;
