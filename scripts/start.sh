#!/usr/bin/env bash
set -euo pipefail

# Load env
ENV_FILE="${HOME}/.codex/channels/lark/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

echo >&2 "Starting codex-lark-plugin MCP server..."
echo >&2 "  App ID: ${LARK_APP_ID:-<not set>}"

exec npm run --silent start -- "$@"
