# Transition Compatibility Matrix

This document records the compatibility paths tracked by issue #200. Its job is
to keep transition-era code from becoming permanent architecture by accident.

Status baseline: v1.12.1.

## Support Matrix

| Area | Current state | Decision | Required parity / coverage | Removal gate | Next action |
| --- | --- | --- | --- | --- | --- |
| Codex exec action marker protocol | Removed in v1.12.0. Exec actions now use the parent-owned JSONL side channel. | Removed. Do not reintroduce marker parsing or a rollout flag. | `codex-exec-delivery-smoke`, `codex-exec-action-channel-smoke`, and production scans must keep visible stdout separate from control actions. | Already complete. Any future action transport must be out-of-band or native structured events. | None. |
| Job runtime schema drift between MCP tools and exec actions | Fixed in v1.12.1 with `createInitialJobRuntime()` plus legacy runtime backfill. | Keep shared runtime initializer; do not add new runtime fields directly in adapters. | `job-smoke`, `job-tools-smoke`, and `codex-exec-actions-smoke` must cover MCP create, exec create/upsert, default presets, and legacy backfill. | Already complete for runtime schema. Further job lifecycle parity needs a shared service. | Extract shared job lifecycle service. |
| SDK runtime vs legacy runtime | `LARK_CHANNEL_RUNTIME=sdk` is the default. `legacy` still starts the pre-SDK channel path. | Deprecate `legacy` as rollback-only, not a parallel product surface. | `npm run smoke:sdk`, default dry-run, and explicit `LARK_CHANNEL_RUNTIME=legacy npm start -- --dry-run` must stay green while rollback exists. | Remove only after owner approval, no open rollback-only issues, at least one released SDK-default version after this matrix, release notes, README/README_CN/env docs updates, and a rollback plan that uses package downgrade instead of runtime switch. | Decide whether to remove `legacy` in the next architecture slice. |
| Exec delivery vs notification delivery | `LARK_CODEX_DELIVERY_MODE=exec` is the default. `notification` still routes through `notifications/Codex/channel`. | Deprecate `notification` unless a supported host still requires it. Treat it as compatibility-only until decided. | Exec chat/doc-comment/cronjob delivery, session resume, progress, side-channel actions, and scheduler prompt jobs must remain covered before removing notification mode. | Remove only after confirming no supported host requires `notifications/Codex/channel`, documenting migration to exec mode, updating config validation/env docs, and preserving a package-level rollback path. | Confirm product boundary, then either document notification as supported or remove it. |
| Job JSON backfill | `job-store.backfillJob()` supports pre-v0.9 fields, empty `created_by`, missing `origin_chat_id`, missing `timezone`, short-lived `send_chat_id`, and missing runtime diagnostic fields. | Keep as a data safety net until a one-time migrate/doctor path exists. | Backfill tests must prove legacy files become canonical on read and next write without losing ownership, target chat, timezone, or runtime diagnostics. | Remove individual backfills only after a `job doctor` / migration command exists, release notes tell operators how to run it, and at least one release has shipped with the command. | Add a job doctor/migration command or keep backfills. |
| Profile single-file migration | `memory/file.ts` lazily migrates pre-v0.10 profile files into `public.md` / `private.md`. | Keep as a privacy-sensitive migration safety net. | `profile-tier-smoke` must cover idempotency, partial-failure recovery, L1 private split, and L2 `privacy-rules.md` influence. | Remove only after a profile doctor/migration command exists, the command preserves L1/L2 privacy classification, and docs explain how to audit migrated profiles. | Add profile doctor/migration design before removal. |
| MCP tools vs exec actions | Both surfaces are intentional, but some domain logic is duplicated. Job runtime schema is now shared; job and issue-proposal business logic is still partially duplicated. | Retain both surfaces, but make them thin adapters over shared services. This is not a removal path. | Parity tests must compare persisted state and authorization behavior across surfaces. | Do not remove either surface. Completion means shared services and explicit unsupported-surface errors. | Extract shared job lifecycle service first, then issue proposal service. |

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

1. Extract shared job lifecycle service for MCP tools and exec actions.
2. Add issue proposal lifecycle parity/shared-service coverage.
3. Decide whether `LARK_CHANNEL_RUNTIME=legacy` should be removed now that SDK
   is the default path.
4. Decide whether `LARK_CODEX_DELIVERY_MODE=notification` is still a supported
   product surface or should be removed.
5. Design job/profile doctor commands before removing data-layout backfills.
