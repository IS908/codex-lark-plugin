#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${HOME}/.codex/channels/lark/.env"
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

exec npm run --silent stop -- "$@"
