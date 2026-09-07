.PHONY: all extract build verify publish-npm clean template install-plugin ledger smoke smoke-v1 smoke-http serve typecheck check-logging contribute contribute-preview
all: extract build verify        ## regenerate the deck from the live database and smoke-test it
install-plugin:                   ## add this repo to global opencode plugins (restart opencode after)
	bun install
	rm -f ~/.config/opencode/plugin/editLedger.ts
	bun plugin/cli.ts install $(CURDIR)
	@echo "restart opencode: opencode2 service restart"
ledger:                           ## show what the edit ledger has collected so far, and whether opencode is loading the plugin
	@f=$${OC_EDIT_LEDGER:-$$HOME/.local/share/ocInsights/edits.jsonl}; [ -f "$$f" ] && { echo "$$f: $$(wc -l <"$$f") edits, $$(grep -o '"session":"[^"]*"' "$$f" | sort -u | wc -l) sessions"; tail -3 "$$f"; } || echo "no ledger yet (run make install-plugin, then restart opencode)"
	@l=$$HOME/.local/share/opencode/log/opencode.log; [ -f "$$l" ] && grep -hE 'editLedger|oc.insights|ocInsights|oc.productivity|ocProductivity' "$$l" | grep -E 'loading plugin|failed to load' | tail -4 | sed -E 's/.*(msg|message)="([^"]+)".*(cause="[^"]{0,120}|entrypoint="[^"?]+).*/\2: \3/' || true
smoke:                            ## prove the ledger hook records: one write in a scratch dir through a fresh opencode process
	@d=/tmp/opencode/ledger-smoke; f=$${OC_EDIT_LEDGER:-$$HOME/.local/share/ocInsights/edits.jsonl}; n=$$(grep -c "$$d/hello.txt" "$$f" 2>/dev/null); n=$${n:-0}; \
	mkdir -p $$d && cd $$d && rm -f hello.txt && opencode2 run --agent build --model xai/grok-4.6 "Use the write tool to create hello.txt containing the single word hi. Do nothing else, do not run any commands." >/dev/null 2>&1; \
	[ -f $$d/hello.txt ] || { echo "opencode did not write $$d/hello.txt"; exit 1; }; \
	m=$$(grep -c "$$d/hello.txt" "$$f" 2>/dev/null); m=$${m:-0}; [ "$$m" -gt "$$n" ] && { echo "plugin ok: $$(tail -1 "$$f" | cut -c1-160)"; } || { echo "plugin did not record the edit — run make ledger"; exit 1; }
smoke-v1:                         ## prove the v1 server() path records: one write through a fresh opencode v1 process (file adapter, no registry)
	@d=/tmp/opencode/ledger-smoke-v1; f=$${OC_EDIT_LEDGER:-$$HOME/.local/share/ocInsights/edits.jsonl}; n=$$(grep -c "$$d/hello.txt" "$$f" 2>/dev/null); n=$${n:-0}; \
	mkdir -p $$d/.opencode/plugins $$d/fakehome/.config && cd $$d && rm -f hello.txt && \
	printf 'import def from "$(CURDIR)/plugin/index.ts";\nexport const ocInsightsV1 = def.server;\n' > .opencode/plugins/ocinsights.ts && \
	XDG_CONFIG_HOME=$$d/fakehome/.config opencode run --agent build --model opencode/gemini-3.5-flash-lite "Use the write tool to create hello.txt containing the single word hi. Do nothing else, do not run any commands." >/dev/null 2>&1; \
	[ -f $$d/hello.txt ] || { echo "opencode did not write $$d/hello.txt"; exit 1; }; \
	m=$$(grep -c "$$d/hello.txt" "$$f" 2>/dev/null); m=$${m:-0}; [ "$$m" -gt "$$n" ] && { echo "plugin ok: $$(tail -1 "$$f" | cut -c1-160)"; } || { echo "plugin did not record the edit — run make ledger"; exit 1; }
smoke-http:                       ## prove the HTTP singleton binds and /health answers (does not run extract)
	bun plugin/smoke.ts
serve:                            ## run the HTTP server without OpenCode (http://127.0.0.1:4173/)
	bun plugin/serve.ts
extract:                          ## opencode.db + git repos -> data.json (~15 s, read-only)
	bun plugin/cli.ts extract --out data.json
build:                            ## data.json + template.html -> opencode_time_full.html
	bun plugin/cli.ts build --data data.json --out opencode_time_full.html
verify:                           ## headless-Chromium checks on the built deck
	node verify.mjs opencode_time_full.html
template:                         ## re-derive template.html from the reference deck (rarely needed)
	bun plugin/cli.ts template legacy/opencode_time_full.reference.html template.html
typecheck:                        ## tsc --noEmit over plugin/
	bunx tsc --noEmit
check-logging:                  ## prove plugin diagnostics never touch the terminal (47 checks)
	bun plugin/log-check.ts
publish-npm:                      ## typecheck, pack dry-run, publish @pfoundation/ocinsights
	bunx tsc --noEmit
	bun plugin/shim-check.ts
	bun plugin/log-check.ts
	npm pack --dry-run
	npm publish --access public
contribute:                       ## submit anonymised cycle facts to the global scorecard
	bun plugin/cli.ts contribute --data data.json
contribute-preview:               ## build the contribution payload without sending, then privacy-grep it
	bun plugin/cli.ts contribute --data data.json --dry-run --out /tmp/opencode/contrib-preview.json
	grep -q '"cols":\["cycle_key","day","model","prov","role","pm","pp","bm","bp","u","a","tedits","tpaths","teerr","tcost","tship","thrs","tver","tabort","latmed","tshipe","variant","pv","bv","harness","hversion"\]' /tmp/opencode/contrib-preview.json
	! grep -E -q '/home|ses_|/Users/' /tmp/opencode/contrib-preview.json
clean:
	rm -f data.json opencode_time_full.html
