# Local Diagnostic Logs

`codex-lark-plugin` writes local-only diagnostic logs under
`~/.codex/channels/lark/` by default. These logs are plaintext files protected
by OS file permissions; they are not sent to Feishu or a remote backend.

## Canonical Format

Local diagnostic logs use JSON Lines: one JSON object per line, UTF-8 encoded.
Each record includes:

- `at`: ISO timestamp.
- `kind`: record family, such as `audit` or `trace`.

Writers must use `appendRotatingLine()` so `LARK_LOG_MAX_BYTES` and
`LARK_LOG_MAX_FILES` keep applying consistently.

## Audit Records

`LARK_AUDIT_LOG` defaults to `~/.codex/channels/lark/audit.log`.

Sensitive tool calls append records shaped like:

```json
{"at":"2026-07-06T12:00:00.000Z","kind":"audit","tool":"save_memory","outcome":"ok","caller":"ou_xxx","args":{"memory_type":"chat"}}
```

Fields:

- `tool`: sensitive tool or parent-side action name.
- `outcome`: `ok`, `denied`, or `error`.
- `caller`: Feishu `open_id`, or `null` when no caller could be resolved.
- `args`: redacted/truncated argument summary. Long string fields are truncated;
  unserializable argument objects use `{"serialization_error":"<unserializable>"}`.

## Trace Records

`LARK_CODEX_EXEC_TRACE_LOG` defaults to `~/.codex/channels/lark/trace.log`.

When `LARK_CODEX_EXEC_TOOL_TRACE=true`, codex exec tool events append records
with `kind: "trace"`. Compact/hidden records include tool, status, trace id,
duration, sanitized args, and sanitized errors when available. Full records keep
a sanitized/truncated event object.

Example compact record:

```json
{"at":"2026-07-06T12:00:00.000Z","kind":"trace","mode":"compact","event_type":"tool_call.started","tool":"exec_command","status":"started"}
```
