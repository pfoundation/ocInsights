# Changelog

## 26.9.0

- Renamed from ocProductivity to ocInsights (`@pfoundation/ocinsights` on npm)
- Plugin id `oc.insights`, TUI `oc.insights.tui`, RPC `ocInsights`, command ids `oc.insights.deck` / `oc.insights.contribute`
- Env family `OC_INSIGHTS_*` (`CACHE`, `HOST`, `PORT`, `TTL_MS`, `CONTRIB_URL`, `CONTRIBUTE`); agent tool `insights_contribute`
- State directory `~/.local/share/ocInsights` — on first load, renamed from `ocProductivity` if the new path is absent, so the install UUID and edit ledger survive
- Publish to npmjs.com: `make publish-npm`, and `.github/workflows/publish.yml` on `v*` tags
- Removed gist snapshot publishing (`make publish`, `publish.sh`, `GIST_ID`); the snapshot is a local file, distribution is npm + the live plugin
