# Local Diagnostic Logs

`codex-lark-plugin` writes local-only diagnostic logs under
`~/.codex/channels/lark/` by default. These logs are plaintext files protected
by OS file permissions; they are not sent to Feishu or a remote backend.

## Canonical Format

Local diagnostic logs use compact UTF-8 text lines. They are optimized for
terminal reading and `grep`, not for strict JSON ingestion. The line itself is
not a JSON object.

Common positional shape:

```text
<iso-time>  <log-id>  <kind>  <kind-specific fields...>  <compact-payload>
```

Fields are separated by two spaces. Fields with whitespace are JSON-quoted so
the value remains readable while preserving the fixed-position layout. The
payload may be a compact sanitized JSON fragment, but the complete line is not
JSONL.

Writers must use `appendRotatingLine()` so `LARK_LOG_MAX_BYTES` and
`LARK_LOG_MAX_FILES` keep applying consistently.

## Audit Records

`LARK_AUDIT_LOG` defaults to `~/.codex/channels/lark/audit.log`.

Sensitive tool calls append records shaped like:

```text
2026-07-06T12:00:00.000Z  om_xxx  audit  save_memory  ok  ou_xxx  {"memory_type":"chat"}
```

Fields:

- time
- inferred log id, usually `message_id`, `reply_to`, `thread_id`, or `chat_id`
  from the audited arguments; `-` when unavailable
- `audit`
- sensitive tool or parent-side action name
- outcome: `ok`, `denied`, or `error`
- Feishu `open_id`, or `-` when no caller could be resolved
- redacted/truncated argument summary. Long string fields are truncated;
  unserializable argument objects use `{"serialization_error":"<unserializable>"}`

## Trace Records

`LARK_CODEX_EXEC_TRACE_LOG` defaults to `~/.codex/channels/lark/trace.log`.

When `LARK_CODEX_EXEC_TOOL_TRACE=true`, codex exec tool events append text-line
records. Compact/hidden records include mode, event type, tool, status, tool
call trace id, duration, sanitized args, and sanitized errors when available.
Full records keep a sanitized/truncated event payload.

Example compact record:

```text
2026-07-06T12:00:00.000Z  om_xxx  trace  compact  tool_call.started  exec_command  started  call_123  -  {"command":"npm test"}
```

The trace `log-id` correlates records from the same trigger:

- ordinary Feishu/Lark message turns use the source message id;
- scheduled prompt jobs use the cronjob name when no source message id exists;
- direct host-side `codex exec` calls without a source use `-`.
