# ocProductivity

A single-file productivity deck built from the opencode session store and the git history of every project it touched. It answers: where did the time go, what did it cost, which models were used, and — the part that took the most care — which models actually ship work.

Live deck (while OpenCode is running, after `make install-plugin`): http://127.0.0.1:4173/

Snapshot gist: https://gist.github.com/judsd/65ad8796a952e875bb72a1be19fbd052 (open `opencode_time_full.html` through htmlpreview; `publish.sh` prints the link).

## Run it

```bash
make install-plugin   # add this repo to global opencode plugins; restart opencode
# then open http://127.0.0.1:4173/   (first request runs extract.py, ~15 s)

make                  # extract -> build -> verify   (about 20 seconds; gist snapshot)
make publish          # push the snapshot to the gist, print the rendered URL
make serve            # HTTP server without OpenCode (same port)
```

Requirements: python3 (stdlib only), git, bun (for the plugin), `gh` authenticated with the gist scope, and node with playwright for `verify` (it falls back to `~/dev/datastudio/node_modules/playwright` if none is installed here). The database is opened read-only; nothing here writes to opencode.

Environment overrides: `OC_DB` (default `~/.local/share/opencode/opencode.db`), `OC_DEV_ROOT` (default `~/dev`, where the git repos live), `OC_GIT_AUTHORS` (comma-separated author names counted as yours, default `Jud Saoud,judsd`), `GIST_ID`, `OC_PRODUCTIVITY_PORT` (default `4173`), `OC_PRODUCTIVITY_HOST` (default `127.0.0.1`; set `0.0.0.0` to listen on all interfaces — unauthenticated, LAN-visible), `OC_PRODUCTIVITY_TTL_MS` (default `300000`), `OC_PRODUCTIVITY_CACHE` (default `~/.local/share/ocProductivity/data.json`). The same host/port/ttl live in `~/.local/share/ocProductivity/http.json` (env wins). Plugin options `port` / `host` / `ttlMs` override both. A local path in the `{ "package", "options" }` plugins form is ignored by OpenCode — keep the plugin as a string path and put `host` in `http.json`.

## How it fits together

```
plugin/          OpenCode plugin (id oc.productivity)
  ledger hook    every edit/write/patch -> ~/.local/share/ocProductivity/edits.jsonl
  HTTP singleton 127.0.0.1:4173 (or 0.0.0.0)  GET /  GET /data.json  GET /health  POST /refresh
  on request     python3 extract.py --out ~/.local/share/ocProductivity/data.json  (~15 s, cached 5 min)

extract.py   one read-only pass over opencode.db + `git log` per repo  ->  data.json
build.py     data.json + template.html                                ->  opencode_time_full.html
verify.mjs   opens the built deck in headless Chromium, 82 checks
publish.sh   gh gist edit + rendered URL  (offline snapshot; htmlpreview cannot fetch localhost)
template.html  the deck's CSS and JS with @@PLACEHOLDERS@@ where data goes
tools/make_template.py  how template.html was derived from a built deck (rarely needed)
legacy/      the earlier one-off scripts and decks this replaced; superseded, kept for history
```

Every number in the deck is computed in `extract.py`. The plugin spawns that script on request and injects the result into `template.html` (same job as `build.py`). If you want to change what is measured, edit `extract.py`; if you want to change how it looks or behaves, edit `template.html` (it is plain HTML + vanilla JS, no framework, no dependencies).

## What the deck contains

A global filter bar and section nav under the header, then header KPIs (active hours · turns to ship · file edits · commits shipped · cost · tokens), then in pipeline order: **Time** — monthly hours by project (all worktrees, no "other" bucket; can stack by session role instead) · daily hours by project · tokens per day · work rhythm. **Inputs** — models per day with group-by model / family / provider · who is talking (your prompts vs subagent prompts vs agent replies) · agents and models. **Output** — human turns to ship (your prompts per shipped session tree; metric strips with a radar toggle) · productivity by model (edits vs cost) · shipping by model (edits vs steering, plus a funnel of how far work got). **Outcome** — shipping in commits (one card; y-axis toggles median lines vs commit count). **Projects** — every worktree, with session depth columns. **Method** — the four judgment calls.

## Global filters

Three controls in the sticky header apply to every card at once and to the KPIs:

- **Window** — all time, or the last 90 / 45 / 30 / 7 days, anchored to the latest day with activity (not the wall clock, so the deck is stable).
- **Sessions** — all, build, plan, or other agent types. Hours, models per day and every per-model card follow it. Day-level series that have no session role (tokens per day, work rhythm) stay unfiltered by role.
- **Hide small entries** — under 5 commits on the commit card, under 5 sessions on the model cards, under 5 judged sessions on the turns card, under 5 hours for projects, under 5 active days for models per day. Totals and shares are still computed on the full set.

Per-card controls (group by, metric toggles, the commit card's plan-vs-build split, planner→builder combos and y-axis, the productivity and shipping cards' build-only toggle) stay local and remember their state across filter changes. When a global session role is set, the local build-only toggles hide, because the global scope already decides.

The deck ships raw records (`SESS`, one row per session; `DAYW`, `DAYM`, `DAYU`, `RHYD`, one entry per day) and derives every chart and KPI in the browser from those under the current filter (`derive()` in `template.html`). `extract.py` still writes the pre-aggregated legacy datasets to `data.json` for anyone scripting against it, but the deck no longer reads them.

## Definitions

These are the judgment calls. They are printed on the relevant cards too, so a reader of the deck can question them.

**Active hours (heartbeat).** Messages are ordered per session; each message credits `min(gap to previous message, 10 min)` and the first message credits 60 s. Only `user` and `assistant` messages count. This is an estimate of attention, not wall clock: a session left open overnight contributes nothing for the idle span.

**Attribution to a model.** A session belongs to the model that produced most of its assistant messages. 96% of sessions have one model at 80% or more, so this loses little. Model ids are canonicalised first (`claude-opus-4-6`, `claude-opus-4.6`, `anthropic/claude-opus-4.6` and `claude-opus-46` are one model) — that is dedup, not grouping; nothing is ever bucketed as "other".

**Output = file edits.** Every `edit`, `write` or `patch` tool call, parsed from message content. It is the one output signal recorded consistently across every opencode version. Line counts (`summary_additions`) stopped being written after 1.15.13 on 2026-06-05 and appear only as a supplementary column, capped at 10,000 lines per session.

**Roles and phases.** Build agents are `build`, `Sisyphus-Junior`, `Sisyphus (Ultraworker)`, `BuildAgent`, `beads-task-agent`, `general`; plan agents are `plan` and `Metis (Plan Consultant)`. A session's `agent` column is only the *last* agent it ran under, and 601 sessions switched from plan to build mid-way, so roles are taken from each message's own `agent` field. A session therefore has **phases**: its plan-phase hours, prompts, tools and (by hours share) cost, and its build-phase ones. Plan time is 293 h of 826, not the 107 h a last-agent reading gives. The global session filter selects phases; the productivity, shipping and commit cards default to group by family and pair the dominant planner with the dominant builder where available. The build-sessions-only scope applies when role is off, because explore, plan and librarian work reads by design and would make any model used for exploring look unproductive.

**Plan vs build, and planner→builder combos (productivity and shipping cards).** *Plan vs build* draws each model twice — its plan-phase work with a dashed border, its build-phase work solid. *Combos* pair the model that dominated a session's plan phase with the model that dominated its build phase, drawn with a double ring and labelled `plan → build`; the pair is credited with the whole session's output. Cross-model pairs are the interesting ones (fable-5 → grok-4.6 is the most common). On the commit cards the pairing is per commit window: the dominant plan phase among sessions active in the window (including plan-only sessions, kept as zero-credit advisors) and the dominant build phase among the sessions credited by file overlap. Planners never take shipping credit — file-overlap attribution is unchanged — they are only kept visible so the pairing exists.

**Verified / shipped (shipping card).** A session is verified if any shell command matched a build, test, type-check or lint tool. A session **shipped** if its edits landed in one of your git commits within 7 days of its start — read from the repositories, not from anything the agent ran. Shipping is judged only for sessions whose edit paths were recorded (see the ledger below); the column is blank for OpenAI providers, which never record them. Time to ship is the median hours from session start to that commit.

**Human turns to ship (turns card).** A session tree is a top-level session plus every subagent session it spawned. The tree's turns are your prompts on the parent — child sessions carry exactly one `user` message, the delegation, so human engagement is `u` on top-level rows — while its edits, errors, cost and shipping come from the whole tree. Turns to ship is all your turns over judged trees divided by shipped trees: an unshipped tree's turns count against its model, and trees with no edits are excluded outright, which is what keeps few-turn failures from looking good. Steer share is the share of your turns after the first per session; one-shot is shipped trees that needed a single turn. The per-10-shipped-edits toggle adjusts for task size. The profile charts default to a relative-to-pool scale: every value is a log2 ratio to its pooled value on one shared range, so ×2 right of the pool line means twice as good on every row and every radar spoke (the middle ring is the pool, 50 on the core score). Ship % and edit OK % cannot exceed 100 %, so their right side is short by nature. Min–max is one click away and keeps the old per-axis extremes. The three primary axes are turns to ship, ship rate and edits per turn — cost per delivery, reliability of delivery, output per turn; the core score is their normalised mean, 0 to 100. Agent quality (edit reliability, replies per turn) explains them; dollars per shipped tree sits last and is never primary. **Evidence weighting.** Small groups are shrunk toward the pooled value: `adjusted = (n·value + 10·pooled)/(n + 10)` with `n` = shipped trees for turns and dollars, judged trees otherwise, so a 2-session group nearly vanishes into the population while a 100-session group barely moves. The card opens weighted; raw is one click away and tooltips show both. The header KPI is the pool itself, so it stays raw. Everywhere in the deck a prompt is one of your turns on a top-level session; subagent delegation prompts are excluded. The default strips view draws the same six axes as raw-value rows — better to the right, or ascending with the better end arrowed — with connector lines joining each of the top 8 groups' dots; the radar toggle keeps the polygonal view with direction-explicit labels. In the radar, raw draws outward-is-more on every axis (a rim turns vertex is worse); core stays better = 100 either way.

**Commits (commit cards).** Your own commits, all branches, merges and bots excluded, read from each repo with `git log --numstat`. A commit's window runs from the previous commit in the same repo to the commit, capped at 72 h, plus 5 min grace. The commit is credited to the sessions whose recorded edits inside the window touched files in it, weighted by how many of its files each touched; each share goes to the session's dominant model. Sessions that were active but touched none of the commit's files get **no credit** — they advised, they did not ship — and are counted as *advised only*. Sessions that edited in the window but never had a path recorded fall back to a split by active minutes, flagged *by time* in the summary line and in each model's tooltip. Commits with no agent activity at all are the manual bucket. Prompts per commit credits session prompts to the window in proportion to active time. Lines come from git, so they cover every era.

**Edit paths — the edit ledger.** File-overlap attribution needs one fact per edit: when, which session, which file. opencode records it in the message JSON (still, through September 2026), and also recorded it in the legacy `part` table from February to August. opencode has already dropped two data sources without notice (line counts, the part table), so the `oc.productivity` plugin appends that same fact to `~/.local/share/ocProductivity/edits.jsonl` on every edit/write/patch tool call, in a directory opencode does not own. `make install-plugin` adds this repo to global `plugins` (and removes the old `editLedger.ts` symlink); `make smoke` proves the hook records through a fresh `opencode2 run`; `make smoke-http` proves `/health` answers; `make ledger` shows what it has collected and the last plugin load line from opencode's log. `extract.py` unions all three sources per session; paths are made relative to the directory each session ran in, which also handles the `v0-dashboard → datastudio` rename and opencode's temporary git worktrees. The **edit-path coverage** strip on the commit card shows each source's share of the month's edits, and the header carries a chip when the ledger is inactive or more than a day behind the database — so if opencode's record stops carrying paths, the deck says so instead of silently falling back to the time split.

**Tokens per day.** Fresh tokens = input + output + reasoning; cache reads are reported separately because they are 67× larger and would flatten everything. Per-message token blocks exist on only ~10% of messages, so each session's tokens are split across the days its messages fall on, weighted by active time.

## Caveats that do not go away

Selection bias: heavy models get hard tasks, cheap models get lookups. Models were used in different eras with different tooling. Task size confounds turns to ship — thirty turns for a feature beats two for a typo — which is why the turns card also reads turns per 10 shipped edits. Commit attribution is evidence-based but still not proof — a commit can include hand edits made alongside the agent, a window can hold more than one feature, and files changed by shell commands (generated code, lockfiles) do not appear as edits. Read every per-model number as "how this model performed on the work it was given", not as a benchmark.
