# Guarded Managed Scratch Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Release independent opt-in automatic cleanup of verified managed run scratch, then close #387 after verification.

**Architecture:** Reuse preview policy, re-read the live ledger in a serialized write transaction, and persist a claim that fences future scratch handoffs. Perform physical moves and recovery under the existing global instance lock before workers start.

**Tech Stack:** TypeScript, Node.js 24.15+ SQLite WAL, existing platform-specific path and baseline checks.

**Spec:** [Guarded managed scratch cleanup](../specs/2026-11-22-guarded-workspace-cleanup.md)

## Global Constraints

Default off. No workspace mutation in dry run, preview, or production verification. Keep formal artifacts and every unowned or unprovable path. Protect Linux runs with unproven process quiescence. The preview is not a deletion ticket.

## Review Focus

- A liveness or delivery change prevents claim admission; a pre-upgrade writer cannot touch a claimed allocation.
- Uncertain rename/purge state, mismatched identities, or changes after isolation never cause an automatic recursive delete.
- A purged run's formal artifacts still verify and can be copied into an independently allocated retry.
- The capacity pass is bounded and does not sacrifice safety when inventory is incomplete or older paths overlap.
- Lock, configuration and recovery failures report a reason and do not silently mutate the wrong store or project.

## Tasks

- [x] Extract shared ledger eligibility and implement exact, serialized durable claims and state transitions. The disposable SQLite fixture covers delivery changes, WAL snapshots, claim ordering, old writers, restart, invalid transitions and artifact access. The claim constructor is not invoked by the plugin yet.
- [ ] Verify the implemented pinned quarantine/recovery and purge adapter on Linux, and test termination after authorization during a purge. The macOS disposable fixtures cover no-replace, relocated v2 baselines, unchanged Git and artifacts, unverified ACLs/flags, oversized manifests, changed data and delivery, journal reopen after move/removal, a live orphan retaining the writer reservation, and recovery queue rotation. The native path uses descriptor-relative syscalls and flushes before acknowledgement; startup does not invoke it yet.
- [ ] Add default-off retention/capacity policy and startup integration before workers. Hold the existing lock, honor dry-run, report bounded outcomes, and cover compatibility, runtime races and retry/delivery using fixtures on macOS and Linux.
- [ ] Update documentation and version metadata, rebuild the marketplace runtime, run targeted and full suites, obtain independent review and merged CI, publish and verify the tag, then close #387.
