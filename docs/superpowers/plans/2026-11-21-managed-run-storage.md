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
- [x] Persist scheduled Cron admission failures through the normal result/outbox path without launching Codex.
- [x] Wire Async Task admission, checkpoint verification and explicit retry to the persisted workspace snapshot. Retry creates a new allocation, copies verified artifacts independently of the source scratch, and keeps legacy jobs on the legacy artifact store.
- [x] Add bounded formal artifact reads that return verified bytes, not a path to reopen later.
- [x] Finalize Cron admission failures in preflight and preserve the reason during interruption and expiry. Keep Async Task storage blockers terminal without promoting unavailable checkpoint files, and refuse redaction while managed erasure is unsupported.
- [x] Anchor artifact reads to the verified parent directory through launch, and publish verified retry copies atomically without replacing existing files.
- [x] Verify protected ancestry, POSIX ownership and macOS extended ACLs for managed launch and artifact access. Protect configured and historically pinned source projects against overlapping new allocations and replays.
- [x] Preserve the unmanaged decision on a foreground replay, including the prior pinned project or the unchanged legacy fallback root. Fence conflicting admissions in the allocation database.
- [x] Expose committed Async Task artifacts through the authenticated status and artifact commands. Document opt-in operation and verify on-demand delivery after scratch is unavailable.
- [x] Reconcile complete retry staging writes under the retry creation lock before applying the target quota. Cover interruption both before and after the exclusive link; do not adopt or remove unverified entries.
- [x] Journal retry writes before publication, including the temporary inode before writing bytes. Recover known interrupted writes after restart without discarding unknown or replaced files.
- [x] Persist requested Async Task artifact deliveries in the existing durable outbox and revalidate the commitment and bytes before sending. Verify restart with missing scratch and isolation from the terminal notification.
- [x] Register requested prompt Cron files through the parent action channel and commit independent attachment outbox entries. Verify restart, unavailable scratch, report receipt ordering, changed file rejection, and legacy generation after config changes.
- [x] Persist foreground reply intent and formal references before sending, release files only after the text receipt, and resume pending delivery when the channel reconnects. Recheck route authorization, retain uncertain sends, and do not rerun Codex or alter legacy file sends.
- [ ] Run the full suite and marketplace checks, get independent review, merge, verify main CI, publish a tagged release, then close #393. Cache reuse and cleanup remain subsequent #387 milestones.
