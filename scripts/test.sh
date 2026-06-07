#!/usr/bin/env bash
set -euo pipefail

export LARK_APP_ID="${LARK_APP_ID:-cli_test_app_id}"
export LARK_APP_SECRET="${LARK_APP_SECRET:-test_app_secret}"

echo "=== TypeScript typecheck ==="
npx tsc --noEmit
echo "PASS"

echo ""
echo "=== Codex adapter checks ==="
node scripts/codex-adapter-smoke.js
echo "PASS"

echo ""
echo "=== Dry-run (module loading) ==="
npm run --silent start -- --dry-run 1>/tmp/lark-test-stdout.txt 2>/tmp/lark-test-stderr.txt
echo "PASS"

echo ""
echo "=== MCP stdout clean ==="
if [ -s /tmp/lark-test-stdout.txt ]; then
  echo "FAIL: stdout is not empty"
  cat /tmp/lark-test-stdout.txt
  exit 1
fi
echo "PASS"

echo ""
echo "=== SDK constructors have stderr logger ==="
# Dry-run cannot catch stdout pollution from SDK constructors that only run
# inside channel.start() (e.g. EventDispatcher). Their default logger writes
# to stdout and would corrupt MCP JSON-RPC framing. Enforce statically that
# each `new Lark.<Client|EventDispatcher|WSClient>(` in src/channel.ts has a
# `logger:` option within the parens of its arg block (depth-tracked scope).
node --import tsx scripts/check-sdk-loggers.ts
echo "PASS"

echo ""
echo "=== Card builder unit checks ==="
node --import tsx scripts/card-smoke.ts

echo ""
echo "=== Job store unit checks ==="
node --import tsx scripts/job-smoke.ts

echo ""
echo "=== Reply raw-card unit checks ==="
node --import tsx scripts/reply-card-smoke.ts

echo ""
echo "=== Identity session unit checks ==="
node --import tsx scripts/identity-smoke.ts

echo ""
echo "=== Message queue unit checks ==="
node --import tsx scripts/message-queue-smoke.ts

echo ""
echo "=== Codex exec delivery unit checks ==="
node --import tsx scripts/codex-exec-delivery-smoke.ts

echo ""
echo "=== Privacy rules unit checks ==="
node --import tsx scripts/privacy-rules-smoke.ts

echo ""
echo "=== Prompt hardening unit checks ==="
node --import tsx scripts/prompt-hardening-smoke.ts

echo ""
echo "=== Profile tiering unit checks ==="
node --import tsx scripts/profile-tier-smoke.ts

echo ""
echo "=== Transparency unit checks ==="
node --import tsx scripts/transparency-smoke.ts

echo ""
echo "=== Mention resolver unit checks ==="
node --import tsx scripts/mention-resolver-smoke.ts

echo ""
echo "=== Reply thread-routing unit checks ==="
node --import tsx scripts/reply-thread-smoke.ts

echo ""
echo "=== Reaction event unit checks ==="
node --import tsx scripts/reaction-event-smoke.ts

echo ""
echo "=== Download attachment unit checks ==="
node --import tsx scripts/download-attachment-smoke.ts

echo ""
echo "=== Auto-flush caller binding unit checks ==="
node --import tsx scripts/auto-flush-smoke.ts

echo ""
echo "All tests passed."
