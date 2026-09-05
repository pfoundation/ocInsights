.PHONY: all extract build verify publish clean template install-plugin ledger smoke smoke-http serve
all: extract build verify        ## regenerate the deck from the live database and smoke-test it
install-plugin:                   ## add this repo to global opencode plugins (restart opencode after)
	mkdir -p ~/.local/share/ocProductivity
	bun install
	rm -f ~/.config/opencode/plugin/editLedger.ts
	python3 tools/install_plugin.py $(CURDIR)
	@echo "restart opencode: opencode2 service restart"
ledger:                           ## show what the edit ledger has collected so far, and whether opencode is loading the plugin
	@f=$${OC_EDIT_LEDGER:-$$HOME/.local/share/ocProductivity/edits.jsonl}; [ -f "$$f" ] && { echo "$$f: $$(wc -l <"$$f") edits, $$(grep -o '"session":"[^"]*"' "$$f" | sort -u | wc -l) sessions"; tail -3 "$$f"; } || echo "no ledger yet (run make install-plugin, then restart opencode)"
	@l=$$HOME/.local/share/opencode/log/opencode.log; [ -f "$$l" ] && grep -hE 'editLedger|oc.productivity|ocProductivity' "$$l" | grep -E 'loading plugin|failed to load' | tail -4 | sed -E 's/.*(msg|message)="([^"]+)".*(cause="[^"]{0,120}|entrypoint="[^"?]+).*/\2: \3/' || true
smoke:                            ## prove the ledger hook records: one write in a scratch dir through a fresh opencode process
	@d=/tmp/opencode/ledger-smoke; f=$${OC_EDIT_LEDGER:-$$HOME/.local/share/ocProductivity/edits.jsonl}; n=$$(grep -c "$$d/hello.txt" "$$f" 2>/dev/null || echo 0); \
	mkdir -p $$d && cd $$d && rm -f hello.txt && opencode2 run --agent build --model xai/grok-4.6 "Use the write tool to create hello.txt containing the single word hi. Do nothing else, do not run any commands." >/dev/null 2>&1; \
	[ -f $$d/hello.txt ] || { echo "opencode did not write $$d/hello.txt"; exit 1; }; \
	m=$$(grep -c "$$d/hello.txt" "$$f" 2>/dev/null || echo 0); [ "$$m" -gt "$$n" ] && { echo "plugin ok: $$(tail -1 "$$f" | cut -c1-160)"; } || { echo "plugin did not record the edit — run make ledger"; exit 1; }
smoke-http:                       ## prove the HTTP singleton binds and /health answers (does not run extract.py)
	bun plugin/smoke.ts
serve:                            ## run the HTTP server without OpenCode (http://127.0.0.1:4173/)
	bun plugin/serve.ts
extract:                          ## opencode.db + git repos -> data.json (~15 s, read-only)
	python3 extract.py --out data.json
build:                            ## data.json + template.html -> opencode_time_full.html
	python3 build.py
verify:                           ## headless-Chromium checks on the built deck
	node verify.mjs opencode_time_full.html
publish:                          ## push the built deck to the gist and print the rendered URL
	./publish.sh opencode_time_full.html
template:                         ## re-derive template.html from the reference deck (rarely needed)
	python3 tools/make_template.py legacy/opencode_time_full.reference.html template.html
clean:
	rm -f data.json opencode_time_full.html
