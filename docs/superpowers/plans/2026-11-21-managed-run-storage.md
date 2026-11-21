# Managed Run Storage Implementation Plan

> **For agentic workers:** Execute this plan one task at a time using superpowers:executing-plans or superpowers:subagent-driven-development.

**Goal:** Complete [#393](https://github.com/IS908/codex-lark-plugin/issues/393), with owned run-specific scratch directories and durable formal artifacts independent of scratch.

**Architecture:** Opt-in operator configuration pins two existing, non-overlapping storage roots inside the applicable authorization roots. A kernel or foreground run identity reserves storage once, with the actual directories' identities recorded in host-owned persistence. Existing session, Run, checkpoint and delivery data remain the authority; workspace metadata must not become a second execution state machine.

**Tech Stack:** TypeScript, Node filesystem APIs and SQLite, the existing Codex launcher and durable-run kernel.

## Invariants

- Source CWD and existing sandbox modes do not change. Only the exact run directories needed for execution can be made writable; no grant for their parent roots.
- Managed storage is opt-in and requires operator-provisioned POSIX directories owned by the plugin account, without group or other write bits. Directory allocation uses a helper anchored in the verified parent; this does not sandbox another process already trusted with unrestricted access as the plugin user.
- `workspace-write` managed runs require a bound source project disjoint from storage, including paths claimed under prior configurations. Reject managed runs under `danger-full-access`; exact writable-directory grants cannot restrict a sandbox that already permits unrestricted writes.
- Unknown directories are never adopted by name. No workspace cleanup or source migration is introduced in this stage. A reservation interrupted before ownership can be established fails closed.
- An existing Run never takes a new root from changed config. Missing or swapped scratch does not make a separately stored formal artifact unavailable.
- The no-config path and legacy stored records stay compatible. Apply the current workload roots at access time, even when a record predates an operator change.

## Execution

- [x] Add red/green storage smoke tests and a shared allocator. Check optional configuration, disjoint/pinned roots, distinct run paths, identity checks on reopen, conflicts, and artifact access without scratch.
- [x] Add the SQLite allocation ledger and prove single-writer allocation, interrupted reservation protection and reopening. Keep execution state outside this ledger.
- [x] Reject uncommitted allocation, authorize before the reservation, normalize last-use time, and reject overlapping owned/reserved directories under concurrent reservation.
- [x] Gate runtime integration on creation relative to a verified, host-protected parent (not a second absolute lookup), and on alias/ancestor identity checks. Verify the allocated child's identity rather than trusting a post-create path lookup.
- [x] Persist workspace admission for foreground and prompt Cron, keyed to authenticated message/session identity or durable Run ID. Verify binding restore across restart/config changes, per-run scratch isolation, and exact writable grants.
- [ ] Before release, verify protected ancestry for writable launch paths, preserve the unmanaged decision on a foreground replay, and persist scheduled Cron admission failures through the normal result/outbox path.
- [ ] Wire Async Task admission, retries and checkpoint/artifact paths. Connect stable owners and formal references to kernel leases, checkpoints and deliveries rather than duplicating status. Revalidate binding on every launch.
- [ ] Expose verified artifact references through existing lookup/delivery paths and document opt-in operation. Cover delivery with the scratch directory unavailable and pre-upgrade records after config changes.
- [ ] Run the full suite and marketplace checks, get independent review, merge, verify main CI, publish a tagged release, then close #393. Cache reuse and cleanup remain subsequent #387 milestones.
