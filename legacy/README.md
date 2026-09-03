# legacy — superseded, kept for history

The productivity deck was built interactively over one session as a chain of one-off scripts and regex patches. These are the ones that survived on disk; everything after `ux_patch.py` (models per day, who is talking, productivity, shipping, commits, roles, windows) ran as inline scripts and exists only in the consolidated `../extract.py`.

| File | What it was |
| --- | --- |
| `build_report.py` | First 30-day deck: SQL heartbeat query, CSV export, GitHub-green heatmap (`opencode_time_heatmap.html`) |
| `opencode_time_futuristic.html` | Neon "command deck" restyle — rejected |
| `opencode_time_console.html` | 30-day deck restyled to the PF Console design system — the visual baseline that survived |
| `build_full.py` | First full-history deck (monthly stacks, cost, agents, rhythm) |
| `patch_full.py` | Added total tokens, models over time, tokens-per-day grid |
| `fix_tok.py` | Fixed token-day attribution (creation day → message days by active time) |
| `ux_patch.py` | Tooltips, interactive legends, sortable tables, cross-highlighting, theme toggle |
| `opencode_time_full.reference.html` | The final published deck as of 2026-09-03; `tools/make_template.py` derives `template.html` from it |

Do not run these against the current template; they patch by string matching and will not find their anchors.
