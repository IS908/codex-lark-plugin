# Local Diagnostic Logs

`codex-lark-plugin` writes local-only diagnostic logs under
`~/.codex/channels/lark/logs/` by default. These logs are plaintext files
protected by OS file permissions; they are not sent to Feishu or a remote
backend.

## Canonical Format

Local diagnostic logs use compact UTF-8 text lines. They are optimized for
terminal reading and `grep`, not for strict JSON ingestion. The line itself is
not a JSON object.

Timestamps use `LARK_CRON_TIMEZONE` and include an explicit UTC offset, for
example `2026-07-10T19:20:50.822+08:00`.

Most records use this positional shape:

```text
<zoned-time>  <log-id>  <kind>  <kind-specific fields...>  <compact-payload>
```

Fields are separated by two spaces. Fields with whitespace are JSON-quoted so
the value remains readable while preserving the fixed-position layout. The
payload may be a compact sanitized JSON fragment, but the complete line is not
JSONL.

Writers must use `appendRotatingLine()` so `LARK_LOG_MAX_BYTES`,
`LARK_LOG_MAX_FILES`, and `LARK_LOG_ARCHIVE_RETENTION_MONTHS` keep applying
consistently. Previous-month active and rotated logs are compressed under
`~/.codex/channels/lark/logs/archive/YYYY-MM/` before the new month's active log
is written. Archives older than the configured retention window are removed.
When a custom log path points into a project/workdir, ignore `.plugin/logs/`,
`*.log`, and `*.log.*` so active logs, rotated files, and gzip archives are not
committed.

## Audit Records

`LARK_AUDIT_LOG` defaults to `~/.codex/channels/lark/logs/audit.log`.

Sensitive tool calls append records shaped like:

```text
2026-07-06T20:00:00.000+08:00  om_xxx  audit  save_memory  ok  ou_xxx  {"memory_type":"chat"}
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

`LARK_CODEX_EXEC_TRACE_LOG` defaults to
`~/.codex/channels/lark/logs/trace.log`.

When `LARK_CODEX_EXEC_TOOL_TRACE=true`, codex exec tool events append text-line
records. Compact/hidden records intentionally omit the `trace` kind, trace
mode, and raw event type after `log_id` and `run_id`; they use a short shape
with tool/type, status, tool call trace id, duration, sanitized args, and
sanitized errors when available. Full records keep the trace kind, mode, event
type, and a sanitized/truncated event payload for deeper diagnostics.

Example compact record:

```text
2026-07-06T20:00:00.000+08:00  om_xxx  019f0abc1234abcd  exec_command  started  call_123  -  {"command":"npm test"}
```

Debug records use the same timestamp style and omit bracket wrappers:

```text
2026-07-06T20:00:00.000+08:00 channel Enqueue message om_xxx
```

The trace `log_id` correlates records from the same trigger, while `run_id`
separates repeated executions of that trigger. Trace lines display the compact
run id returned by `formatTraceRunIdForDisplay()`; the display width is
centralized as `TRACE_RUN_ID_DISPLAY_LENGTH=16`. UUID-like values remove
separators and keep the first hexadecimal characters; non-UUID values fall back
to a compact lowercase alphanumeric form:

- ordinary Feishu/Lark message turns use the source message id;
- scheduled prompt jobs use the stable `job_id` when no source message id exists;
- direct host-side `codex exec` calls without a source use `-`.

When tracing is enabled, the exec action bridge can serve bounded
`get_run_trace` requests. Message queries are limited to the current or quoted
message trace. Cronjob queries require an authorized `job_id`. Queries return
all matching runs within the last 12 hours unless a `run_id` is supplied. The
query accepts either the compact display id or the full internal `run_id`; when
the full id is supplied, the response preserves that full id while matching the
compact log records.
The query result is a structured, redacted summary; the raw log file is not
injected into Codex and should not be read directly by model instructions.
