#!/usr/bin/env bash
# Install the kfc-cn-ordering skill into Hermes (~/.hermes/skills).
# This does not touch config.yaml; MCP registration is manual (see config.snippet.yaml).
set -euo pipefail

HERMES_DIR="${HERMES_HOME:-$HOME/.hermes}"
TARGET="$HERMES_DIR/skills/kfc-cn-ordering"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/skills/kfc-cn-ordering"

if [ ! -d "$SOURCE" ]; then
  echo "Skill source not found: $SOURCE" >&2
  exit 1
fi

mkdir -p "$TARGET"
cp -R "$SOURCE"/. "$TARGET"/

echo "Installed skill to $TARGET"
echo "Restart Hermes or run /reset, then use /kfc-cn-ordering."
