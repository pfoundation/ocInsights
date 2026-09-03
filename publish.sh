#!/usr/bin/env bash
# Publish the built deck to the GitHub gist and print the rendered URL.
# Usage: ./publish.sh [opencode_time_full.html]   (env GIST_ID overrides the target gist)
set -euo pipefail
FILE="${1:-opencode_time_full.html}"
GIST_ID="${GIST_ID:-e6f9c7297ac1aaa9fdc3ce2a296e69d6}"
[ -f "$FILE" ] || { echo "no such file: $FILE" >&2; exit 1; }
grep -q '@@' "$FILE" && { echo "refusing to publish: unfilled placeholders in $FILE" >&2; exit 1; }
gh gist edit "$GIST_ID" --add "$FILE"
RAW=$(gh api "gists/$GIST_ID" --jq ".files[\"$(basename "$FILE")\"].raw_url")
echo "gist:     https://gist.github.com/$GIST_ID"
echo "raw:      $RAW"
echo "rendered: https://htmlpreview.github.io/?$RAW"
