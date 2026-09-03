.PHONY: all extract build verify publish clean template install-plugin ledger
all: extract build verify        ## regenerate the deck from the live database and smoke-test it
install-plugin:                   ## symlink plugin/editLedger.ts into opencode's plugin dir (restart opencode after)
	mkdir -p ~/.config/opencode/plugin ~/.local/share/ocProductivity
	ln -sfn $(CURDIR)/plugin/editLedger.ts ~/.config/opencode/plugin/editLedger.ts
	@echo "installed: ~/.config/opencode/plugin/editLedger.ts -> $(CURDIR)/plugin/editLedger.ts"
ledger:                           ## show what the edit ledger has collected so far
	@f=$${OC_EDIT_LEDGER:-$$HOME/.local/share/ocProductivity/edits.jsonl}; [ -f "$$f" ] && { echo "$$f: $$(wc -l <"$$f") edits, $$(cut -d'"' -f8 "$$f" | sort -u | wc -l) sessions"; tail -3 "$$f"; } || echo "no ledger yet (run make install-plugin, then restart opencode)"
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
