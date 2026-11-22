#!/usr/bin/env bash
set -euo pipefail

timestamp() {
  date '+%Y-%m-%dT%H:%M:%S%z'
}

log() {
  printf '[%s] %s\n' "$(timestamp)" "$*" >&2
}

require_supported_node() {
  if ! node -e '
    const required = [24, 15, 0];
    const actual = process.versions.node.split(".").map(Number);
    for (let i = 0; i < required.length; i += 1) {
      if ((actual[i] || 0) > required[i]) process.exit(0);
      if ((actual[i] || 0) < required[i]) process.exit(1);
    }
  '; then
    log "Node.js >=24.15.0 is required; current version is $(node --version 2>/dev/null || printf unknown)."
    exit 1
  fi
}

timestamp_stderr() {
  local line
  local missing_dependency=0
  while IFS= read -r line || [ -n "$line" ]; do
    log "$line"
    if [[ "$line" == 'Error [ERR_MODULE_NOT_FOUND]: Cannot find package '* ]]; then
      missing_dependency=1
    fi
  done
  if (( missing_dependency )); then
    log 'Local npm dependency missing. From the plugin repository root, run npm ci and retry.'
  fi
}

require_supported_node

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
