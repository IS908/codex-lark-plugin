#!/usr/bin/env bash
set -euo pipefail

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

log() {
  printf '[%s] %s\n' "$(timestamp)" "$*" >&2
}

timestamp_stderr() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    printf '[%s] %s\n' "$(timestamp)" "$line" >&2
  done
}

# Load env
ENV_FILE="${HOME}/.codex/channels/lark/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

log "Starting codex-lark-plugin MCP server..."
log "  App ID: ${LARK_APP_ID:-<not set>}"

exec 3>&1
set +e
npm run --silent start -- "$@" 2>&1 1>&3 | timestamp_stderr
status=${PIPESTATUS[0]}
set -e
exec 3>&-
exit "$status"
