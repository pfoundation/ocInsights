# AGENTS.md - Coding Agent Guidelines for ocProductivity

## Project Overview

Static analytics deck over the opencode session database (`~/.local/share/opencode/opencode.db`, SQLite) and the git history of the projects under `~/dev`. Output is one self-contained HTML file published to a GitHub gist. Two Python scripts do all the work; the deck itself is vanilla HTML + JS with no framework and no runtime dependencies.

Read `README.md` first — it holds the metric definitions. This file is about working on the code.

## Build / Run / Verify Commands

```bash
make                 # extract + build + verify (~20 s)
make extract         # python3 extract.py --out data.json      (read-only DB pass + git log)
make build           # python3 build.py                        (data.json + template.html -> deck)
make verify          # node verify.mjs opencode_time_full.html (headless Chromium, 24 checks)
make publish         # ./publish.sh                            (gh gist edit; prints rendered URL)
make template        # tools/make_template.py — only after hand-editing a built deck
make install-plugin  # symlink plugin/editLedger.ts into ~/.config/opencode/plugin/ (restart opencode)
make ledger          # what the edit ledger has collected
```

No test framework beyond `verify.mjs`. No linter configured. A quick JS syntax gate you can run after editing the template:
`node -e "const h=require('fs').readFileSync('opencode_time_full.html','utf8');new (require('vm').Script)(h.match(/<script>([\s\S]*)<\/script>/)[1])"`.

## Language Choice

Python, not the workspace default of Bun/TypeScript. Deliberate: the pipeline is SQLite + JSON parsing + `subprocess git`, all stdlib, and it is what the analysis was actually developed in. Do not port it unless there is a concrete reason. The deck's JS is plain ES2020 in `template.html`; keep it dependency-free so htmlpreview keeps working.

## Code Style

- 4-space Python, `from __future__ import annotations`, stdlib only. Config constants live at the top of `extract.py` with a comment each; do not scatter magic numbers.
- Template JS is dense by design (one file, no build step). Each chart is an IIFE or a factory (`stacked()`, `commitsCard()`); shared helpers are `bindTip`, `row`, `makeSortable`, `setHot`, `fmtT`. Reuse them.
- Placeholders in `template.html` are `@@NAME@@`. Data constants are `const NAME=@@NAME@@;`. `build.py` asserts none are left unfilled; `publish.sh` refuses to ship a file containing `@@`.
- Design language is the PF Console one (`~/dev/datastudio/.design-sync/conventions.md`): everything square (`border-radius:0` is enforced globally), burnt-amber primary, semantic tokens, IBM Plex Sans for copy and Inconsolata for every machine value, sentence case, no emoji. Charts use `--chart-1..5` and family hues; nothing neon.

## Architecture

`extract.py` → `data.json` → `build.py` → `opencode_time_full.html`.

`extract.py` does one ordered pass over `session_message` (`ORDER BY session_id, time_created`) and computes everything per session in a single dict: heartbeat credit, dominant model/provider, prompt and reply counts, tool calls, verify and commit commands. All datasets are rolled up from that pass, then `attribute_commits()` joins git commits to sessions by time window. Adding a metric means adding a field in `scan_messages()` and rolling it up in `main()`.

`build.py` formats `meta` into KPI strings and injects each dataset as JSON. `RANGE` (start, end, window start, calendar weeks, session count) is injected too so the JS has no hard-coded dates.

Raw records injected into the deck: `SESS` (one row per session; columns in `SESS_COLS`, names resolved through `IDX`), `DAYW` (day → worktree → hours by role code `[all, plan, build]`), `DAYM` (day → `model|provider` → messages by role code), `DAYU` (day → your prompts / subagent prompts / replies), `RHYD` (day → 24 hourly counts), `DTOK` (day → tokens, cost, sessions), `CM` (commits with attribution), `RANGE`.

Render-time derivation (`derive()` in the template) turns those into the per-card datasets under `FILTER = {win, role, small}`: `HM`/`HMR`/`PORDER` monthly hours (by project / by role) · `HD` daily hours · `DMODELS` models per day · `PROD` = `SHIP` per-model records for productivity, shipping and the funnel · `UA`/`UAM` who is talking · `DHRS` for the tokens grid · `LB`/`COST`/`DEPTH` tables · `AGENTS`/`MODELS`/`RHY` sidebar cards · `KPI` for the header. `renderAll()` clears every container (`resetDom`) and re-runs the card code; local card state survives in `UI`. `extract.py` still emits the legacy pre-aggregated datasets in `data.json`, but `build.py` only injects the raw ones.

## Data Facts and Gotchas (each of these cost real time)

- **Line counts end on 2026-06-05.** `session_v2.summary_additions/deletions` are populated through opencode 1.15.13 and never after 1.16.2. Any per-model chart on lines silently shows recent models as producing nothing. Use edits (tool calls) as output; lines are a legacy column only.
- **Line counts on child sessions are wrong anyway.** 153 subagent sessions show lines they never edited — the summary reflects the shared worktree, not the session's own work. Another reason edits are the output metric.
- **Per-message tokens exist on ~10% of messages** (recent versions only). Day-level tokens come from splitting `session_v2` totals across message days by active time.
- **`session_v2.model` is last-used only.** Per-message `model` fields are the truth (125 mid-session model switches). Always parse the message JSON.
- **Tool parts are `{"type":"tool","id":...,"name":...}`** — the key is `name`, not `tool`, and `providerState` nests braces, so regex on message JSON undercounts by ~70%. Parse with `json.loads`; the full pass is ~7 s.
- **Model ids come in four spellings** across providers (`claude-opus-4-6`, `claude-opus-4.6`, `anthropic/claude-opus-4.6`, `claude-opus-46`). `canon()` is the single normaliser; use it everywhere a model id is read.
- **GPT/OpenAI providers do not record edited file paths**, so edits-per-file is blanked for them (`files < edits/20` rule), their shipped column is blank, and their commit credit comes only through the time fallback (the tooltip says so).
- **Edit paths vanished from message JSON in September 2026** (0.0.0-beta series): 597 September edits, 0 with a path. Feb–Aug paths live in the legacy `part` table (`part_edits()`), and from September the only source is our own ledger (`plugin/editLedger.ts` → `~/.local/share/ocProductivity/edits.jsonl`, `ledger_edits()`). If the ledger is missing, September commits silently fall to the time fallback — `extract.py` prints "no ledger yet".
- **Paths must be made relative to `session_v2.directory`, not the project worktree.** 473 datastudio sessions ran in `/home/ubuntu/dev/v0-dashboard` before the rename, and some ran in opencode's temporary worktrees under `~/.local/share/opencode/worktree/`. `rel_file()` is the single place this is done; using `project.worktree` as the base zeroed file-overlap for all of them.
- **Commit attribution is by file overlap** (`attribute_commits`): a session gets credit only if its recorded edits touched files in the commit. Active-but-untouching sessions are *advised only* and get nothing — a deliberate decision, not a gap. `recs[i][4]` is the basis (`files`/`window`); `manual[i][2]` is 1 for advised-only. The funnel's `s_commit` field now means *shipped* (edits landed in a commit within `SHIP_DAYS`), and `s_paths` is its denominator.
- **`git log --numstat` rename syntax**: `dir/{old => new}.ts` and bare `old => new`; `git_commits()` resolves to the new path.
- **`idle_outcome` and `revert` are too sparse to use** (172 and 2 sessions).
- **The database is live.** Sessions in progress (including the one editing this repo) change totals between runs. Diffs against a published deck will drift by a few hours; commit attribution should match exactly for the same git state.
- **Commit dates:** author date is used; only 1 of 753 commits in the two big repos was rebased by more than an hour. "Now" for the window filters is the latest commit, not the wall clock, so the deck is stable.
- **CSS class collisions.** The sticky page header is `.bar`; the funnel bars had to become `.fbar`. Check `grep -c` before adding a class.
- **SVG in Playwright:** `<text>` needs `textContent`, not `innerText`; decorative rings carry `pointer-events="none"`, so target `circle[data-s]:not([pointer-events])` when hovering.
- **Re-render discipline.** Every card runs inside `renderAll()`. Anything that appends to the DOM must be cleared in `resetDom()`; anything that registers a listener on a persistent element must assign (`el.onclick=`) or guard (`th.dataset.tb`), never `addEventListener` unguarded, or listeners stack on each filter change. Cross-highlight extensions go in `hotHooks[name]=fn`, not by wrapping `setHot`.
- **Session day.** A session belongs to the day of its first message for windowing; hours are still credited to the exact message day (`DAYW`). The two agree to within rounding over any window longer than a day.
- **Template literals:** `prefix + cond ? a : b` parses as `(prefix + cond) ? a : b`. Parenthesise ternaries when concatenating (it broke a summary line once).

## Publishing

The gist id is in `publish.sh` (`GIST_ID` env overrides). htmlpreview renders raw gist URLs; the URL changes with every revision, so re-copy it after publishing. The deck contains cost figures and project paths — it is on a public gist by choice; check before pointing it at a different audience.
