#!/usr/bin/env python3
"""Add this repo to ~/.config/opencode/opencode.json plugins and drop the old symlink."""
from __future__ import annotations

import json
import sys
from pathlib import Path

repo = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent
cfg = Path.home() / ".config" / "opencode" / "opencode.json"
if not cfg.is_file():
    print(f"no {cfg}; add this to plugins by hand:\n  {repo}", file=sys.stderr)
    sys.exit(1)
data = json.loads(cfg.read_text())
plugins = data.get("plugins")
path = str(repo)
if isinstance(plugins, list) and path in plugins:
    print(f"already in plugins: {path}")
    sys.exit(0)
if not isinstance(plugins, list):
    data["plugins"] = [path]
else:
    plugins.append(path)
cfg.write_text(json.dumps(data, indent=2) + "\n")
print(f"installed: {path} -> {cfg}")
