# Transition Compatibility Matrix

This document records the compatibility paths tracked by issue #200. Its job is
to keep transition-era code from becoming permanent architecture by accident.

Status baseline: v1.12.5.

## Support Matrix

| Area | Current state | Decision | Required parity / coverage | Removal gate | Next action |
| --- | --- | --- | --- | --- | --- |
| Codex exec action marker protocol | Removed in v1.12.0. Exec actions now use the parent-owned JSONL side channel. | Removed. Do not reintroduce marker parsing or a rollout flag. | `codex-exec-delivery-smoke`, `codex-exec-action-channel-smoke`, and production scans must keep visible stdout separate from control actions. | Already complete. Any future action transport must be out-of-band or native structured events. | None. |
| Job runtime schema drift between MCP tools and exec actions | Fixed in v1.12.1 with `createInitialJobRuntime()` plus legacy runtime backfill; v1.12.2 also routes job lifecycle mutations through `job-service`. | Keep shared runtime initializer and shared lifecycle service; do not add job runtime, visibility, owner-check, or mutation fields directly in adapters. | `job-smoke`, `job-tools-smoke`, `codex-exec-actions-smoke`, and `job-lifecycle-parity-smoke` must cover MCP create/update, exec create/upsert, job CRUD parity, and legacy backfill. | Already complete for runtime schema and job lifecycle parity. | None for jobs. |
| SDK runtime vs legacy runtime | Removed in v1.12.4. The SDK runtime is always used; `LARK_CHANNEL_RUNTIME=legacy` is rejected at config load so stale rollback settings fail loudly, while stale `sdk` is ignored for upgrade compatibility. | Removed. Do not reintroduce a runtime selector or hidden rollback flag. | `npm run smoke:sdk`, default dry-run, `sdk-runtime-smoke`, and config validation must prove SDK startup works and stale `legacy` fails. | Already complete. Rollback is package downgrade to v1.12.3 or earlier. | None. |
| Exec delivery vs notification delivery | Removed in v1.12.5. Chat, doc-comment, reaction, and cron prompt turns always use codex exec delivery; `LARK_CODEX_DELIVERY_MODE=notification` is rejected at config load, while stale `exec` is ignored for upgrade compatibility. | Removed. Do not reintroduce `notifications/Codex/channel` as a parallel delivery mode or hidden rollback flag. | `codex-exec-delivery-smoke`, `scheduler-smoke`, config validation, dry-run, and full test coverage must prove chat/doc-comment/cron prompt delivery use exec and notification mode fails loudly. | Already complete. Rollback is package downgrade to v1.12.4 or earlier. | None. |
| Job JSON backfill | `job-store.backfillJob()` supports pre-v0.9 fields, empty `created_by`, missing `origin_chat_id`, missing `timezone`, short-lived `send_chat_id`, and missing runtime diagnostic fields. | Keep as a data safety net until a one-time migrate/doctor path exists. | Backfill tests must prove legacy files become canonical on read and next write without losing ownership, target chat, timezone, or runtime diagnostics. | Remove individual backfills only after a `job doctor` / migration command exists, release notes tell operators how to run it, and at least one release has shipped with the command. | Add a job doctor/migration command or keep backfills. |
| Profile single-file migration | `memory/file.ts` lazily migrates pre-v0.10 profile files into `public.md` / `private.md`. | Keep as a privacy-sensitive migration safety net. | `profile-tier-smoke` must cover idempotency, partial-failure recovery, L1 private split, and L2 `privacy-rules.md` influence. | Remove only after a profile doctor/migration command exists, the command preserves L1/L2 privacy classification, and docs explain how to audit migrated profiles. | Add profile doctor/migration design before removal. |
| MCP tools vs exec actions | Both surfaces are intentional for Lark/channel-owned capabilities. Job lifecycle business logic uses `job-service`; provider-specific issue/PR/proposal automation has been removed from the core plugin boundary. | Retain both surfaces for channel-owned actions, but keep them thin adapters over shared services. Do not add GitHub/GitLab/Jira/Linear-specific writes to core MCP tools or exec actions; use user-configured skills, custom MCP tools, or `run_local_cli_tool`. | `job-lifecycle-parity-smoke` must compare persisted state and authorization behavior across MCP and exec surfaces. `codex-exec-actions-smoke` must reject removed provider-specific action names. | Already complete for job lifecycle parity and provider-specific action removal. | None for current job lifecycle parity. |

## Removal Checklist

Every compatibility removal PR must include:

- a statement naming the compatibility path and why it is no longer needed;
- updated README, README_CN, `.env.example`, plugin docs, and release notes;
- updated config validation and smoke tests that remove the old mode or mark it
  explicitly unsupported;
- a rollback path based on reinstalling a previous plugin release, not hidden
  feature flags;
- evidence that affected operators have a migration or doctor command when data
  layout is involved.

## Priority Order

1. Design job/profile doctor commands before removing data-layout backfills.
