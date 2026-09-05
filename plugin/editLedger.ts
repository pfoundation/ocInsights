// Compatibility entry: the ledger hook now lives in plugin/ledger.ts and is
// registered by the oc.productivity plugin. This file keeps the old default
// export so a leftover ~/.config/opencode/plugin/editLedger.ts symlink still
// records edits. extract.py dedupes on `call` if both load.
//
// Install:  make install-plugin   (adds this repo to global plugins, removes the symlink)
import { setupLedger } from "./ledger.ts";

export default {
  id: "edit-ledger",
  setup: setupLedger,
};
