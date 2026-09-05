# AGENTS.md - Coding Agent Guidelines for ocProductivity

## Project Overview

Analytics deck over the opencode session database (`~/.local/share/opencode/opencode.db`, SQLite) and the git history of the projects under `~/dev`. Live path: an OpenCode plugin (`oc.productivity`) that exposes the data on `http://127.0.0.1:4173/` by spawning `extract.py` on request. Snapshot path: one self-contained HTML file published to a GitHub gist. Two Python scripts still do all the measurement; the deck itself is vanilla HTML + JS with no framework and no runtime dependencies.

Read `README.md` first — it holds the metric definitions. This file is about working on the code.

## Build / Run / Verify Commands

```bash
make                 # extract + build + verify (~20 s)
make extract         # python3 extract.py --out data.json      (read-only DB pass + git log)
make build           # python3 build.py                        (data.json + template.html -> deck)
make verify          # node verify.mjs opencode_time_full.html (headless Chromium, 82 checks)
make publish         # ./publish.sh                            (gh gist edit; prints rendered URL)
make template        # tools/make_template.py — only after hand-editing a built deck
make install-plugin  # bun install + add this repo to global plugins; removes old editLedger.ts symlink
make serve           # bun plugin/serve.ts — HTTP without OpenCode (http://127.0.0.1:4173/)
make ledger          # what the edit ledger has collected, plus the last plugin load/fail line from opencode.log
make smoke           # one write through a fresh `opencode2 run` in /tmp; proves the ledger hook records
make smoke-http      # bun plugin/smoke.ts — HTTP /health only, no extract
```

No test framework beyond `verify.mjs`. No linter configured. A quick JS syntax gate you can run after editing the template:
`node -e "const h=require('fs').readFileSync('opencode_time_full.html','utf8');new (require('vm').Script)(h.match(/<script>([\s\S]*)<\/script>/)[1])"`.

## Language Choice

Python, not the workspace default of Bun/TypeScript, for `extract.py` / `build.py`. Deliberate: the pipeline is SQLite + JSON parsing + `subprocess git`, all stdlib, and it is what the analysis was actually developed in. Do not port extract.py unless there is a concrete reason. The OpenCode plugin in `plugin/` is TypeScript because that is what OpenCode loads; it spawns `extract.py` and ports only `build.py` (string replace). The deck's JS is plain ES2020 in `template.html`; keep it dependency-free so htmlpreview keeps working.

## Code Style

- 4-space Python, `from __future__ import annotations`, stdlib only. Config constants live at the top of `extract.py` with a comment each; do not scatter magic numbers.
- Plugin TypeScript is 2-space, matching the OpenCode plugin examples. Keep `@opencode-ai/plugin` as a runtime dependency (RPC). The HTTP server is a process-wide singleton (`plugin/server.ts`); do not listen in every location's `setup`.
- Template JS is dense by design (one file, no build step). Each chart is an IIFE or a factory (`stacked()`, `commitsCard()`); shared helpers are `bindTip`, `row`, `makeSortable`, `setHot`, `fmtT`. Reuse them.
- Placeholders in `template.html` are `@@NAME@@`. Data constants are `const NAME=@@NAME@@;`. `build.py` asserts none are left unfilled; `publish.sh` refuses to ship a file containing `@@`.
- Design language is the PF Console one (`~/dev/datastudio/.design-sync/conventions.md`): everything square (`border-radius:0` is enforced globally), burnt-amber primary, semantic tokens, IBM Plex Sans for copy and Inconsolata for every machine value, sentence case, no emoji. Charts use `--chart-1..5` and family hues; nothing neon.

## Architecture

Live: OpenCode loads `plugin/index.ts` (`oc.productivity`). `setup` registers the edit-ledger hook and a process-wide HTTP server on `127.0.0.1:4173` (`OC_PRODUCTIVITY_HOST=0.0.0.0` or plugin option `host` to listen on all interfaces). A request that misses the 5-minute cache spawns `python3 extract.py --out ~/.local/share/ocProductivity/data.json`, then serves that JSON or injects it into `template.html`. RPC `ocProductivity` `{status, refresh, get}` is a thin pointer at the same server. Do not extract in `setup`.

Snapshot: `extract.py` → `data.json` → `build.py` → `opencode_time_full.html`.

`extract.py` does one ordered pass over `session_message` (`ORDER BY session_id, time_created`) and computes everything per session in a single dict: heartbeat credit, dominant model/provider, prompt and reply counts, tool calls, verify and commit commands. All datasets are rolled up from that pass, then `attribute_commits()` joins git commits to sessions by time window. Adding a metric means adding a field in `scan_messages()` and rolling it up in `main()`.

`build.py` formats `meta` into KPI strings and injects each dataset as JSON. `RANGE` (start, end, window start, calendar weeks, session count) is injected too so the JS has no hard-coded dates.

Raw records injected into the deck: `SESS` (one row per session; columns in `SESS_COLS`, names resolved through `IDX`; `pm/pp/bm/bp` are the plan-phase and build-phase dominant model/provider), `PH` (one row per session phase, columns in `PH_COLS`; a phase is the part of a session run under one agent role), `DAYW` (day → worktree → hours by role code `[all, plan, build]`), `DAYM` (day → `model|provider` → messages by role code), `DAYU` (day → your prompts / subagent prompts / replies), `RHYD` (day → 24 hourly counts), `DTOK` (day → tokens, cost, sessions), `CM` (commits with attribution), `PSRC` (month → `[edit calls, with path in message JSON, part-table records, ledger records]`; sources overlap, never stack them), `LEDGER` (`{lines, sessions, first, last, last_edit}`), `RANGE`.

Render-time derivation (`derive()` in the template) turns those into the per-card datasets under `FILTER = {win, role, small}`: `HM`/`HMR`/`PORDER` monthly hours (by project / by role) · `HD` daily hours · `DMODELS` models per day · `PROD` = `SHIP` per-model records for productivity, shipping, the funnel and the turns card · `UA`/`UAM` who is talking · `DHRS` for the tokens grid · `LB`/`COST`/`DEPTH` the projects table · `AGENTS`/`MODELS`/`RHY` sidebar cards · `KPI` for the header (hours, autonomy, edits, commits, cost, tokens). `renderAll()` clears every container (`resetDom`) and re-runs the card code; local card state survives in `UI`. `extract.py` still emits the legacy pre-aggregated datasets in `data.json`, but `build.py` only injects the raw ones. The deck is ordered Time → Inputs → Output → Outcome → Projects → Method; the two commit views are one card with a y-axis toggle.

## Data Facts and Gotchas (each of these cost real time)

- **Line counts end on 2026-06-05.** `session_v2.summary_additions/deletions` are populated through opencode 1.15.13 and never after 1.16.2. Any per-model chart on lines silently shows recent models as producing nothing. Use edits (tool calls) as output; lines are a legacy column only.
- **Line counts on child sessions are wrong anyway.** 153 subagent sessions show lines they never edited — the summary reflects the shared worktree, not the session's own work. Another reason edits are the output metric.
- **Per-message tokens exist on ~10% of messages** (recent versions only). Day-level tokens come from splitting `session_v2` totals across message days by active time.
- **`session_v2.model` is last-used only.** Per-message `model` fields are the truth (125 mid-session model switches). Always parse the message JSON.
- **Tool parts are `{"type":"tool","id":...,"name":...}`** — the key is `name`, not `tool`, and `providerState` nests braces, so regex on message JSON undercounts by ~70%. Parse with `json.loads`; the full pass is ~7 s.
- **Model ids come in four spellings** across providers (`claude-opus-4-6`, `claude-opus-4.6`, `anthropic/claude-opus-4.6`, `claude-opus-46`). `canon()` is the single normaliser; use it everywhere a model id is read.
- **GPT/OpenAI providers do not record edited file paths**, so edits-per-file is blanked for them (`files < edits/20` rule), their shipped column is blank, and their commit credit comes only through the time fallback (the tooltip says so).
- **Edit paths: three sources, the message JSON is still primary.** `state.input.path` (not `filePath`) carries the path on every edit/write part through September 2026 (2,461 of 2,461 September parts). An earlier note here claimed September had none — that was a mis-measurement (`"filePath"` LIKE filter), not a schema change. Feb–Aug paths are also in the legacy `part` table (`part_edits()`, over-counts by up to 2x in Feb), and from September our own ledger records them too (`plugin/ledger.ts` → `~/.local/share/ocProductivity/edits.jsonl`, `ledger_edits()`). All three are unioned per session before `attribute_commits`; `PSRC` (month → `[edits, msg, part, ledger]`) and the deck's *edit-path coverage* strip show each source's share so the day the message JSON stops carrying paths is visible, not silent.
- **The plugin must use the v2 plugin API.** opencode 1.18+ / `0.0.0-beta` loads only `export default Plugin.define({ id, setup(ctx) })` (or the equivalent `{ id, setup }`) and hooks through `ctx.tool.hook("execute.after", ev)` (`ev = {tool, sessionID, agent, messageID, id, input, status, result|error}`); the v1 shape (`export const X: Plugin = async ({directory}) => ({"tool.execute.after": …})`) is refused with "Plugin must export a default definition with an id and an effect or setup function" and the failure is only visible in `~/.local/share/opencode/log/opencode.log`. The running server hot-reloads a plugin file on mtime change, so an edit takes effect without a restart — except imported modules: an edit to `plugin/build.ts` (or any file imported by the entry) is not picked up until opencode restarts, and the page fails with `unfilled placeholders` in the meantime. Plugins are instantiated once per location (project directory); the HTTP server is a module-level singleton so only the first location binds the port (`127.0.0.1` by default, or `0.0.0.0` via `OC_PRODUCTIVITY_HOST` / option `host`). `ledger_edits()` dedupes on the tool call id (`call`) in case a hook fires more than once. `make smoke` proves the ledger path; `make smoke-http` proves `/health`. `LEDGER` in `data.json` carries lines/first/last plus `last_edit` (newest edit in the DB); the deck shows a header chip when the ledger is inactive or more than a day behind the DB.
- **Paths must be made relative to `session_v2.directory`, not the project worktree.** 473 datastudio sessions ran in `/home/ubuntu/dev/v0-dashboard` before the rename, and some ran in opencode's temporary worktrees under `~/.local/share/opencode/worktree/`. `rel_file()` is the single place this is done; using `project.worktree` as the base zeroed file-overlap for all of them.
- **Commit attribution is by file overlap** (`attribute_commits`): a session gets credit only if its recorded edits touched files in the commit. Active-but-untouching sessions are *advised only* and get nothing — a deliberate decision, not a gap. `recs[i][4]` is the basis (`files`/`window`); `manual[i][2]` is 1 for advised-only. The funnel's `s_commit` field now means *shipped* (edits landed in a commit within `SHIP_DAYS`), and `s_paths` is its denominator.
- **Session trees: human turns live on the parent.** Child (subagent) sessions carry exactly one `user` message — the delegation prompt — so human engagement is `u` on `child=0` rows. `extract.py` folds each subtree into its top-level parent (`kids, tedits, teerr, tcost, tship, tpaths` on `SESS`); a tree ships if any session in it shipped. The turns card judges a tree only when it edited and has paths, and `phaseRow()` hands tree facts to the build phase (`ownerT`), so plan rows are mostly unjudged under a split.
- **`git log --numstat` rename syntax**: `dir/{old => new}.ts` and bare `old => new`; `git_commits()` resolves to the new path.
- **`idle_outcome` and `revert` are too sparse to use** (172 and 2 sessions).
- **The database is live.** Sessions in progress (including the one editing this repo) change totals between runs. Diffs against a published deck will drift by a few hours; commit attribution should match exactly for the same git state.
- **Commit dates:** author date is used; only 1 of 753 commits in the two big repos was rebased by more than an hour. "Now" for the window filters is the latest commit, not the wall clock, so the deck is stable.
- **CSS class collisions.** The sticky page header is `.bar`; the funnel bars had to become `.fbar`. Check `grep -c` before adding a class.
- **SVG in Playwright:** `<text>` needs `textContent`, not `innerText`; decorative rings carry `pointer-events="none"`, so target `circle[data-s]:not([pointer-events])` when hovering.
- **Re-render discipline.** Every card runs inside `renderAll()`. Anything that appends to the DOM must be cleared in `resetDom()`; anything that registers a listener on a persistent element must assign (`el.onclick=`) or guard (`th.dataset.tb`), never `addEventListener` unguarded, or listeners stack on each filter change. Cross-highlight extensions go in `hotHooks[name]=fn`, not by wrapping `setHot`.
- **Commit entries are per phase, and advisors are flagged.** `CM.recs[i][2]` entries are `[model, provider, role, share, prompts, hours, advisor]`. A credited session splits into its plan and build phases (share by phase time); plan-only sessions active in the window get an `advisor=1` entry with share 0. The off and split views must skip advisors; only the combo view reads them. Dropping planners from windows (which file-overlap credit does by construction) silently emptied the commit combos once — `verify.mjs` now guards it.
- **`session_v2.agent` is the LAST agent.** 595 of the 601 plan→build sessions carry `build`. Take roles from each assistant message's `agent` field (`AGENT_RE`), never from the session column, or plan time collapses from 293 h to 107 h. User messages take the phase in progress.
- **Session day.** A session belongs to the day of its first message for windowing; hours are still credited to the exact message day (`DAYW`). The two agree to within rounding over any window longer than a day.
- **Template literals:** `prefix + cond ? a : b` parses as `(prefix + cond) ? a : b`. Parenthesise ternaries when concatenating (it broke a summary line once).
- **Loading overlay.** `#loading` is static markup (paints before any JS) and is removed by `boot()` after the first `renderAll()`. The boot is deferred with `requestAnimationFrame` + `setTimeout(0)` (300 ms fallback for hidden tabs) because htmlpreview evaluates the script inside a microtask right after `document.write`, so a synchronous first render would never let the loader paint. It only covers parse + render (~0.1–0.5 s locally); the download phase on htmlpreview is a blank page we cannot touch. `window.onerror` writes the message into `.lmsg` instead of leaving it spinning; `verify.mjs` waits for the element to detach.

## Publishing

The gist id is in `publish.sh` (`GIST_ID` env overrides). htmlpreview renders raw gist URLs; the URL changes with every revision, so re-copy it after publishing. The deck contains cost figures and project paths — it is on a public gist by choice; check before pointing it at a different audience. The live plugin defaults to loopback for the same reason; `0.0.0.0` is opt-in and unauthenticated.
