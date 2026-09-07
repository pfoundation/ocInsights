# Changelog

## Unreleased

- Zero runtime dependencies: the SDK's `Rpc.define` / TUI `Plugin.define` are identity functions, now vendored in `plugin/define.ts`, so installs are just this tarball and first boot on opencode 1.x no longer pays for the effect/zod/solid tree (measured: 292 MB → 0.5 MB installed, 17 s → 3 s first-boot block warm-cache); `plugin/shim-check.ts` guards the invariant (SDK parity + bare-import scan, runs on publish)

- Effort labels are `model:effort` (was `model (effort)`); pragma's Model + effort tab ranks planner → builder effort pairs (`pm:pv → bm:bv`) instead of single models
- Effort/variant reporting: per-message reasoning effort (`default`/`high`/`max`/`xhigh`/`medium`/`thinking`) counted into the dominant model/provider pair, with a *Model + effort* grouping on the productivity, shipping, turns, overall and commits cards
- Harness reporting: per-session opencode version (`ocv`), a *Harness versions* strip, and a header chip with the newest version
- Contribution contract schema 3: `variant, pv, bv, harness, hversion` appended (26 fields); resend is automatic on upgrade
- Dual plugin-API support: the same package now loads on opencode 1.x (v1 API, verified on 1.18.21) via a new `server()` entry alongside the v2 `setup()` — v1 gets the HTTP deck, edit ledger and auto-contribute; RPC, TUI and the agent tool stay v2-only
- `make smoke` / `smoke-v1`: fix the before/after ledger count on fresh dirs (`grep -c` double-zero broke the comparison)
- Auto-contribute: first send waits ~15 min after load (was ~3 min), giving new installs time to opt out before any data leaves the machine
- npm publish workflow triggers on published GitHub Releases (tag push alone no longer publishes); the release tag sets `package.json` version, and pre-releases publish under dist-tag `next` instead of `latest`

## 26.9.0

- Renamed from ocProductivity to ocInsights (`@pfoundation/ocinsights` on npm)
- Plugin id `oc.insights`, TUI `oc.insights.tui`, RPC `ocInsights`, command ids `oc.insights.deck` / `oc.insights.contribute`
- Env family `OC_INSIGHTS_*` (`CACHE`, `HOST`, `PORT`, `TTL_MS`, `CONTRIB_URL`, `CONTRIBUTE`); agent tool `insights_contribute`
- State directory `~/.local/share/ocInsights` — on first load, renamed from `ocProductivity` if the new path is absent, so the install UUID and edit ledger survive
- Publish to npmjs.com: `make publish-npm`, and `.github/workflows/publish.yml` on `v*` tags
- Removed gist snapshot publishing (`make publish`, `publish.sh`, `GIST_ID`); the snapshot is a local file, distribution is npm + the live plugin
