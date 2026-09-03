# ocProductivity

A single-file productivity deck built from the opencode session store and the git history of every project it touched. It answers: where did the time go, what did it cost, which models were used, and — the part that took the most care — which models actually ship work.

Live deck: https://gist.github.com/judsd/65ad8796a952e875bb72a1be19fbd052 (open `opencode_time_full.html` through htmlpreview; `publish.sh` prints the link).

## Run it

```bash
make            # extract -> build -> verify   (about 20 seconds)
make publish    # push to the gist, print the rendered URL
```

Requirements: python3 (stdlib only), git, `gh` authenticated with the gist scope, and node with playwright for `verify` (it falls back to `~/dev/datastudio/node_modules/playwright` if none is installed here). The database is opened read-only; nothing here writes to opencode.

Environment overrides: `OC_DB` (default `~/.local/share/opencode/opencode.db`), `OC_DEV_ROOT` (default `~/dev`, where the git repos live), `OC_GIT_AUTHORS` (comma-separated author names counted as yours, default `Jud Saoud,judsd`), `GIST_ID`.

## How it fits together

```
extract.py   one read-only pass over opencode.db + `git log` per repo  ->  data.json
build.py     data.json + template.html                                ->  opencode_time_full.html
verify.mjs   opens the built deck in headless Chromium, 28 checks
publish.sh   gh gist edit + rendered URL
template.html  the deck's CSS and JS with @@PLACEHOLDERS@@ where data goes
plugin/editLedger.ts  opencode plugin that records every file edit to a ledger we own (make install-plugin)
tools/make_template.py  how template.html was derived from a built deck (rarely needed)
legacy/      the earlier one-off scripts and decks this replaced; superseded, kept for history
```

Every number in the deck is computed in `extract.py`. `build.py` only formats and injects. If you want to change what is measured, edit `extract.py`; if you want to change how it looks or behaves, edit `template.html` (it is plain HTML + vanilla JS, no framework, no dependencies).

## What the deck contains

A global filter bar under the header, then header KPIs, then in order: monthly hours by project (all worktrees, no "other" bucket; can stack by session role instead) · daily hours by project · models per day with group-by model / family / provider · productivity by model (edits vs cost) · shipping by model (edits vs steering, plus a funnel of how far work got) · shipping in commits (commits from git, by size and by count, with role and window filters) · who is talking (your prompts vs subagent prompts vs agent replies, with the autonomy ratio) · tokens per day · all-projects table · agents and models · work rhythm · session depth.

## Global filters

Three controls in the sticky header apply to every card at once and to the KPIs:

- **Window** — all time, or the last 90 / 45 / 30 days, anchored to the latest day with activity (not the wall clock, so the deck is stable).
- **Sessions** — all, build, plan, or other agent types. Hours, models per day and every per-model card follow it. Day-level series that have no session role (tokens per day, work rhythm) stay unfiltered by role.
- **Hide small entries** — under 5 commits on the commit cards, under 5 sessions on the model cards, under 5 hours for projects, under 5 active days for models per day. Totals and shares are still computed on the full set.

Per-card controls (group by, metric toggles, the commit cards' plan-vs-build split and planner→builder combos, the productivity and shipping cards' build-only toggle) stay local and remember their state across filter changes. When a global session role is set, the local build-only toggles hide, because the global scope already decides.

The deck ships raw records (`SESS`, one row per session; `DAYW`, `DAYM`, `DAYU`, `RHYD`, one entry per day) and derives every chart and KPI in the browser from those under the current filter (`derive()` in `template.html`). `extract.py` still writes the pre-aggregated legacy datasets to `data.json` for anyone scripting against it, but the deck no longer reads them.

## Definitions

These are the judgment calls. They are printed on the relevant cards too, so a reader of the deck can question them.

**Active hours (heartbeat).** Messages are ordered per session; each message credits `min(gap to previous message, 10 min)` and the first message credits 60 s. Only `user` and `assistant` messages count. This is an estimate of attention, not wall clock: a session left open overnight contributes nothing for the idle span.

**Attribution to a model.** A session belongs to the model that produced most of its assistant messages. 96% of sessions have one model at 80% or more, so this loses little. Model ids are canonicalised first (`claude-opus-4-6`, `claude-opus-4.6`, `anthropic/claude-opus-4.6` and `claude-opus-46` are one model) — that is dedup, not grouping; nothing is ever bucketed as "other".

**Output = file edits.** Every `edit`, `write` or `patch` tool call, parsed from message content. It is the one output signal recorded consistently across every opencode version. Line counts (`summary_additions`) stopped being written after 1.15.13 on 2026-06-05 and appear only as a supplementary column, capped at 10,000 lines per session.

**Roles and phases.** Build agents are `build`, `Sisyphus-Junior`, `Sisyphus (Ultraworker)`, `BuildAgent`, `beads-task-agent`, `general`; plan agents are `plan` and `Metis (Plan Consultant)`. A session's `agent` column is only the *last* agent it ran under, and 601 sessions switched from plan to build mid-way, so roles are taken from each message's own `agent` field. A session therefore has **phases**: its plan-phase hours, prompts, tools and (by hours share) cost, and its build-phase ones. Plan time is 293 h of 826, not the 107 h a last-agent reading gives. The global session filter selects phases; the productivity, shipping and commit cards default to group by family and pair the dominant planner with the dominant builder where available. The build-sessions-only scope applies when role is off, because explore, plan and librarian work reads by design and would make any model used for exploring look unproductive.

**Plan vs build, and planner→builder combos (productivity and shipping cards).** *Plan vs build* draws each model twice — its plan-phase work with a dashed border, its build-phase work solid. *Combos* pair the model that dominated a session's plan phase with the model that dominated its build phase, drawn with a double ring and labelled `plan → build`; the pair is credited with the whole session's output. Cross-model pairs are the interesting ones (fable-5 → grok-4.6 is the most common). On the commit cards the pairing is per commit window: the dominant plan phase among sessions active in the window (including plan-only sessions, kept as zero-credit advisors) and the dominant build phase among the sessions credited by file overlap. Planners never take shipping credit — file-overlap attribution is unchanged — they are only kept visible so the pairing exists.

**Verified / shipped (shipping card).** A session is verified if any shell command matched a build, test, type-check or lint tool. A session **shipped** if its edits landed in one of your git commits within 7 days of its start — read from the repositories, not from anything the agent ran. Shipping is judged only for sessions whose edit paths were recorded (see the ledger below); the column is blank for OpenAI providers, which never record them. Time to ship is the median hours from session start to that commit.

**Commits (commit cards).** Your own commits, all branches, merges and bots excluded, read from each repo with `git log --numstat`. A commit's window runs from the previous commit in the same repo to the commit, capped at 72 h, plus 5 min grace. The commit is credited to the sessions whose recorded edits inside the window touched files in it, weighted by how many of its files each touched; each share goes to the session's dominant model. Sessions that were active but touched none of the commit's files get **no credit** — they advised, they did not ship — and are counted as *advised only*. Sessions that edited in the window but never had a path recorded fall back to a split by active minutes, flagged *by time* in the summary line and in each model's tooltip. Commits with no agent activity at all are the manual bucket. Prompts per commit credits session prompts to the window in proportion to active time. Lines come from git, so they cover every era.

**Edit paths — the edit ledger.** File-overlap attribution needs one fact per edit: when, which session, which file. opencode recorded it in the message JSON through August, in the legacy `part` table from February to August, and not at all from September (the 0.0.0-beta series). `plugin/editLedger.ts` is a small opencode plugin that appends that fact to `~/.local/share/ocProductivity/edits.jsonl` on every edit/write/patch tool call, in a directory opencode does not own. `make install-plugin` symlinks it into `~/.config/opencode/plugin/` (restart opencode once); `make ledger` shows what it has collected. `extract.py` merges all three sources; paths are made relative to the directory each session ran in, which also handles the `v0-dashboard → datastudio` rename and opencode's temporary git worktrees.

**Tokens per day.** Fresh tokens = input + output + reasoning; cache reads are reported separately because they are 67× larger and would flatten everything. Per-message token blocks exist on only ~10% of messages, so each session's tokens are split across the days its messages fall on, weighted by active time.

## Caveats that do not go away

Selection bias: heavy models get hard tasks, cheap models get lookups. Models were used in different eras with different tooling. Commit attribution is evidence-based but still not proof — a commit can include hand edits made alongside the agent, a window can hold more than one feature, and files changed by shell commands (generated code, lockfiles) do not appear as edits. Read every per-model number as "how this model performed on the work it was given", not as a benchmark.
