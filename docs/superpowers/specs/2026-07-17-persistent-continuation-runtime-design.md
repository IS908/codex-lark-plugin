# Persistent Continuation Runtime for v2.0.0

Status: approved design

Issue: [#272](https://github.com/IS908/codex-lark-plugin/issues/272)

Target release: `v2.0.0`

## 1. Context

The current Lark channel treats each `codex exec` invocation as a single turn. A
turn can send a final reply or request a bounded parent-owned action, but the
plugin has no durable carrier for work that must continue after that process
exits. The lifecycle guard correctly blocks unsupported promises of future
work, yet it cannot establish real background execution.

Recurring cronjobs are not an appropriate carrier for ad-hoc continuation.
They have a schedule-oriented lifecycle, different authorization semantics,
and different user expectations. Reusing their records or scheduler would
couple unrelated domains and leave transitional code that would be difficult
to remove.

This design adds a separate persistent continuation bounded context. A
continuation Job is the durable source of truth. A Codex session is only a
replaceable execution cache.

## 2. Decisions

The following decisions are final for this design:

- The plugin core owns a channel-generic continuation worker.
- Persistence uses the built-in `node:sqlite` API only.
- The minimum Node.js version becomes `>=24.15.0`.
- There is no Node 20 adapter, filesystem fallback, dual write, or cronjob
  compatibility layer.
- The change ships as a direct `v2.0.0` cutover.
- Continuation is a separate domain with repository, worker, authorization,
  execution, and terminal-delivery ports.
- A Job is created only through an explicit structured
  `create_continuation_job` action from a foreground turn.
- Natural-language promises do not create Jobs.
- Background execution does not inherit foreground high-privilege tools.
- The MVP sends one canonical creation acknowledgement and one terminal
  message. It sends no progress messages.
- User control is provided by parent-owned `/task` commands, not MCP tools.

## 3. Goals

- Persist unfinished work before the foreground turn exits.
- Return a stable `job_id` after durable creation.
- Resume work after plugin or worker restart from a durable checkpoint.
- Prevent concurrent execution with leases and heartbeats.
- Bound retries, lifetime, concurrency, and stored data.
- Preserve trusted caller and delivery routing without accepting model-authored
  identity fields.
- Deliver one terminal result in the originating IM thread or document-comment
  thread under the documented delivery guarantees.
- Keep ordinary message delivery and recurring cronjobs unchanged.
- Make task state inspectable and controllable even when Codex is unavailable.

## 4. Non-goals

- Interactive status cards, buttons, callbacks, or dashboards.
- Tool-level or model-generated progress messages.
- `waiting_for_user` conversations inside a background Job.
- Approval prompts from a background process.
- Automatic destructive, financial, publishing, external-messaging, commit,
  push, pull-request, merge, or release operations.
- Reusing the parent Codex session by default.
- Multi-host scheduling. The repository boundary must allow a future backend,
  but v2.0.0 targets one machine and one SQLite database.
- A public continuation MCP tool surface.

## 5. Architecture

The continuation bounded context is organized into the following layers:

```text
channel ingress
  -> foreground create action / parent-owned task command
  -> continuation application service
  -> continuation domain
  -> repository port ---------> node:sqlite adapter
  -> execution port ----------> bounded codex exec runner
  -> terminal delivery port --> Lark IM or doc-comment adapter
  -> artifact port -----------> local per-Job artifact directory
```

The domain does not import Lark SDK types, `LarkTransport`, cronjob records, or
the existing scheduler. Adapters translate trusted inbound routing into an
opaque validated delivery route.

The continuation code may reuse these existing capabilities through ports:

- Codex process execution and trace collection.
- Lark IM and document-comment transport adapters.
- Parent-derived identity and admission checks.
- Safe local diagnostic and audit logging.

It must not import cronjob persistence or call cronjob service operations.
Architecture checks must enforce this boundary.

## 6. Foreground Creation Contract

The existing tokenized JSONL action channel gains one foreground-only action:

```json
{
  "type": "create_continuation_job",
  "title": "Short user-facing summary",
  "objective": "Bounded task objective",
  "acceptance_criteria": ["Concrete completion condition"],
  "context_snapshot": {
    "summary": "Durable execution brief",
    "completed_steps": [],
    "remaining_steps": [],
    "constraints": [],
    "decisions": [],
    "references": []
  },
  "required_tools": ["Advisory capability name"],
  "working_directory": "."
}
```

The action cannot provide `job_id`, caller identity, chat or thread IDs,
message IDs, session IDs, model, permission scope, retry policy, lease fields,
or terminal delivery routing. The parent derives those values from the active
authenticated channel turn and runtime configuration.

Additional creation rules:

- At most one continuation may be requested in one foreground turn.
- `required_tools` is advisory and never grants a capability.
- `working_directory` is canonicalized and must remain within the configured
  allowed working root.
- The context snapshot is bounded and treated as untrusted data when injected
  into future prompts.
- Known credential-like values are removed before persistence. A brief that
  cannot remain useful after redaction is rejected rather than storing the
  secret.
- Reprocessing the same source message and action returns the existing Job by
  a parent-derived idempotency key.

After the creation transaction commits, the parent owns the acknowledgement:

```text
Background task created: <title>
Job ID: <job_id>
```

The canonical acknowledgement replaces model-authored continuation promises,
so the user sees one authoritative message. If persistence fails, useful
same-turn output is retained and an English error explains that no background
task started.

## 7. Persistence

The default paths are:

```text
~/.codex/channels/lark/runtime/continuations/jobs.sqlite
~/.codex/channels/lark/runtime/continuations/artifacts/<job_id>/
```

Directories use mode `0700`; the database and other data files use `0600`.
SQLite is configured with `foreign_keys=ON`, WAL mode, and a bounded
`busy_timeout`. Schema migrations run transactionally and are tracked with
`PRAGMA user_version`.

All SQLite work is short and synchronous inside the repository adapter. No
network, filesystem artifact work, model call, or Lark API call may occur while
a database transaction is open.

### 7.1 continuation_jobs

The Job table contains the current durable state:

```text
job_id                    primary key
idempotency_key           unique, parent-derived
retry_of_job_id           nullable provenance link
row_version               optimistic concurrency version
status                    queued | running | waiting_retry |
                          cancel_requested | completed | failed | cancelled

creator_open_id           trusted caller
origin_kind               message_thread | comment_thread
delivery_route_json       trusted, adapter-validated opaque route
source_message_id         trusted source reference
source_thread_id          trusted source thread

title                     bounded user-facing summary
objective                 bounded execution objective
acceptance_criteria_json  bounded string array
context_snapshot_json     compact durable brief, never a full transcript
required_tools_json       advisory strings only
working_directory         canonical allowed path
model                     selected model

parent_session_id         provenance only
execution_session_id      replaceable execution cache
checkpoint_json           last validated durable checkpoint

step_count                successful continuation slices
failure_count             consecutive retryable failures
max_steps
max_retries
timeout_seconds
next_run_at
expires_at

lease_owner
lease_expires_at
heartbeat_at

result_summary
result_artifacts_json
error_code
error_summary

created_at
started_at
updated_at
completed_at
deleted_at
```

Large output is written to the per-Job artifact directory. The database stores
only bounded summaries and validated artifact references. A delete operation
redacts the task body and removes managed artifacts while retaining a minimal
non-sensitive tombstone.

### 7.2 continuation_attempts

Each Codex process invocation has an immutable attempt record:

```text
attempt_id
job_id
ordinal
worker_id
execution_session_id
started_at
heartbeat_at
finished_at
outcome
error_code
error_summary
```

Attempts do not store raw prompts, hidden reasoning, full stdout, credentials,
or complete tool payloads.

### 7.3 continuation_outbox

The terminal outbox contains at most one active terminal delivery per Job:

```text
outbox_id
job_id                    unique for terminal delivery
delivery_route_json
idempotency_key           stable Feishu UUID where supported
payload
status                    pending | sending | delivered |
                          delivery_unknown | failed
attempt_count
first_attempt_at
last_attempt_at
delivered_message_id
last_error_code
last_error_summary
created_at
updated_at
```

The Job terminal transition and outbox insertion occur in the same SQLite
transaction. This prevents a completed Job without a durable delivery record.

## 8. State Machine

The execution state machine is:

```text
queued -----------> running
waiting_retry ----> running
running ----------> waiting_retry
running ----------> completed
running ----------> failed
queued ------------> cancelled
waiting_retry -----> cancelled
running ------------> cancel_requested -> cancelled
```

State changes use a conditional update on the expected status and
`row_version`. A completion update cannot overwrite a cancellation that
committed first.

`running` includes the active lease. There is no separate externally visible
`leased` state. Claiming a Job atomically moves it to `running`, creates an
attempt, assigns `lease_owner`, and sets `lease_expires_at`.

Terminal execution status and terminal delivery status are independent. A Job
can be `completed` while its terminal outbox is `delivery_unknown`.

## 9. Worker Lifecycle

The worker starts after the repository is healthy and channel delivery adapters
are available. It claims due Jobs up to the global concurrency limit.

Claiming uses a short `BEGIN IMMEDIATE` transaction and a conditional update.
Independent repository connections and future worker processes therefore
cannot both acquire the same valid lease.

Defaults:

- Global concurrency: 1, configurable from 1 through 4.
- Heartbeat interval: 10 seconds.
- Lease duration: 30 seconds.
- Maximum successful steps: 24.
- Maximum consecutive retryable failures: 3.
- Maximum Job age: 24 hours.
- Failure backoff: 30 seconds, 2 minutes, and 10 minutes, with jitter.

A normal `continue` outcome increments `step_count` and does not increment
`failure_count`. A timeout, transient provider failure, process exit, or
temporary storage/transport failure increments the failure count when retry is
safe.

### 9.1 Structured step result

Background execution uses `codex exec --output-schema`. It does not parse
visible prose, sentinel markers, or JSON embedded in prose.

The final response is validated as one of:

```text
continue
  checkpoint
  next_step
  optional resume_after_seconds

completed
  final_message
  optional result_summary
  optional artifact references

failed
  stable error code
  error summary
  retryable flag
  completed and unperformed work

blocked
  required authorization or capability
  completed and unperformed work
```

Conditional validation requires the appropriate fields for each outcome and
rejects identity, routing, permission, or action fields. Malformed output is a
bounded execution failure, never a control instruction.

`blocked` is an execution outcome rather than a separate persisted status. It
transitions the Job to `failed` with a stable authorization or capability error
code, so the state machine stays closed and `/task retry` can create a new Job
after the user changes the foreground authorization or configuration.

### 9.2 Session policy

The default first step creates a new execution session. The parent session ID
is stored only as provenance.

Subsequent steps resume `execution_session_id` when safe. If resume fails, the
worker starts a new session using the durable objective, acceptance criteria,
context snapshot, and checkpoint. Correctness must not depend on Codex session
storage.

### 9.3 Cancellation and shutdown

`/task cancel` immediately cancels `queued` and `waiting_retry` Jobs. A running
Job moves to `cancel_requested`. The worker observes that state, aborts the
child process with `SIGTERM`, and sends `SIGKILL` after 10 seconds if necessary.
The cancelled terminal outcome wins over any later process output.

Graceful shutdown stops new claims and aborts active children. A process crash
leaves leases to expire; recovery then moves the Job through bounded retry. The
worker never assumes that an expired process completed successfully.

## 10. Background Capability Boundary

Background execution is unattended and receives a stricter capability set than
foreground execution:

- `--ignore-user-config` is always enabled.
- No custom Codex profile or user MCP server is loaded.
- Approval policy is forced to `never`; an unattended Job cannot wait for or
  infer interactive approval.
- The sandbox is capped at `workspace-write`, network access is disabled, and
  writable roots are limited to the validated working directory and managed
  artifact directory. A foreground `danger-full-access` configuration is never
  inherited.
- Source-control metadata remains outside the writable boundary. The worker may
  modify workspace files but cannot commit, push, or change repository refs.
- The foreground action registry is not exposed.
- Background execution cannot create cronjobs, create nested continuation
  Jobs, modify access control, recall messages, send arbitrary extra messages,
  commit, push, open or merge pull requests, publish releases, or invoke an
  approval flow.
- The background parent-action allowlist is empty in v2.0.0. A future action
  must explicitly declare and test `unattended` and `idempotent` safety before
  it can be added.
- Local analysis, workspace changes, and managed report artifacts are allowed
  within the configured sandbox.

The MVP does not promise arbitrary external reads. A required external
capability that is unavailable inside this boundary produces a `blocked`
outcome instead of weakening the runner policy.

If a Job needs new authorization or a blocked capability, it returns a
`blocked` terminal outcome. The plugin sends an English explanation and the
user may start or explicitly retry a new foreground request.

## 11. User Commands and Authorization

The parent intercepts these commands before enqueueing a Codex turn:

```text
/task list
/task status <job_id>
/task cancel <job_id>
/task retry <job_id>
/task delete <job_id>
```

They continue to use normal allow-user, allow-chat, and mention admission.
They derive identity from the authenticated inbound event and remain available
when Codex is unavailable.

Authorization rules:

- A creator may inspect, cancel, retry, or delete their own Jobs.
- `LARK_OWNER_OPEN_ID` may manage every Job.
- Other group members cannot inspect objectives, context, checkpoints,
  artifacts, or errors.
- Running Jobs can only be cancelled, not deleted.
- Only terminal Jobs can be deleted.

Retrying a failed or cancelled Job clones the durable brief into a new Job with
a new ID and `retry_of_job_id`. The terminal source record remains immutable.

`delivery_unknown` is not automatically redelivered by `/task retry`. The MVP
returns a clear warning and requires a new foreground request. This avoids
turning an uncertain provider result into a duplicate terminal message.

## 12. Terminal Delivery

The terminal delivery port receives a validated route, canonical terminal
payload, stable Job ID, and delivery idempotency key. The domain does not know
which Lark API is used.

Terminal payloads are plain text and begin with a stable marker:

```text
Task completed: <job_id>
<result summary and artifact references>
```

or:

```text
Task failed: <job_id>
<stable failure reason and completed/unperformed work>
```

Model-produced results preserve the user's language. Plugin-produced failure,
cancellation, permission, and delivery errors default to English.

### 12.1 IM delivery

IM replies use a stable Feishu `uuid`. Feishu documents a one-hour duplicate
suppression window for that UUID. The adapter may safely retry the same UUID
inside that window.

If the plugin cannot establish whether an IM send succeeded and the one-hour
window expires, it must not send again automatically. The outbox becomes
`delivery_unknown`, and `/task status` exposes the last attempt and reason.

### 12.2 Document-comment delivery

Document comments do not use the IM UUID path. After an ambiguous result, the
adapter attempts a bounded read-back of the comment replies and searches for
the exact terminal Job marker. A match records the returned reply ID as
delivered. Failure to reconcile becomes `delivery_unknown`; the adapter does
not blindly resend.

### 12.3 Delivery semantics

The supported guarantee is:

- Exactly one terminal message on confirmed success and retryable IM sends
  within the provider UUID window.
- At most one automatic send when the provider outcome cannot be proven.
- An explicit `delivery_unknown` diagnostic rather than a possible duplicate.

Strict distributed exactly-once delivery is not claimed because the local
SQLite transaction and remote Lark API cannot participate in one atomic
transaction.

## 13. Lifecycle Guard Integration

The current guard is too broad because any side-channel action allows a
follow-up promise. v2.0.0 changes the contract:

- Only a successfully committed `create_continuation_job` result establishes a
  continuation handle.
- Presence of another action does not permit future-work language.
- Same-turn completed work remains unblocked.
- Ambiguous interactive prose fails open and records diagnostics, as today.
- A failed create action preserves useful foreground output and appends the
  canonical failure; it does not leave a continuation obligation in session
  state.
- Continuation state is keyed by durable Job ID and never leaks into a later
  foreground turn or retry message.

The control decision is based on structured action results, not text markers.

## 14. Configuration

New configuration:

| Variable | Default | Validation |
| --- | --- | --- |
| `LARK_CONTINUATION_ENABLED` | `true` | boolean |
| `LARK_CONTINUATION_MAX_CONCURRENCY` | `1` | integer, 1-4 |
| `LARK_CONTINUATION_MAX_STEPS` | `24` | positive integer |
| `LARK_CONTINUATION_MAX_RETRIES` | `3` | non-negative bounded integer |
| `LARK_CONTINUATION_MAX_AGE_HOURS` | `24` | positive bounded number |
| `LARK_CONTINUATION_RETENTION_DAYS` | `30` | positive integer |

Step execution reuses `LARK_CODEX_EXEC_TIMEOUT_MS`, capped by the remaining Job
lifetime. Internal lease and heartbeat constants remain implementation details
until an operational requirement justifies making them public configuration.

Retention removes managed artifacts and sensitive Job bodies after the
configured period. Minimal tombstones remain for authorization-safe audit and
idempotency diagnostics.

## 15. Startup and Failure Isolation

The launcher and package metadata reject Node.js versions below `24.15.0` with
a direct upgrade message. No runtime fallback is attempted.

On plugin startup:

1. Validate configuration.
2. Open SQLite and apply transactional migrations.
3. Run `PRAGMA quick_check`.
4. Start Lark channel delivery.
5. Recover expired leases and pending outbox records.
6. Start worker claims when continuation is enabled.

If the continuation database is corrupt or migration fails, ordinary chat and
cronjob behavior remains available. Continuation creation and `/task`
operations return a stable English unavailable error, and diagnostics explain
the repository failure. A Node version failure remains fatal because v2.0.0
does not support the old runtime.

Dry-run validates the schema in an isolated temporary database and does not
modify the user's runtime database.

## 16. Diagnostics and Privacy

- `trace.log` uses `job_id` as log ID and `attempt_id` as run ID.
- `debug.log` records compact state transitions, claim/recovery decisions, and
  delivery states.
- `audit.log` records create, list, status, cancel, retry, delete, and terminal
  delivery results.
- Logs omit objectives, context snapshots, checkpoints, full results, tool
  payloads, and credentials.
- Existing redaction remains active for every diagnostic field.
- `/task status` reveals sensitive details only after creator/owner
  authorization.

## 17. Verification Plan

### Repository and migration

- Fresh schema creation and `user_version` migration tests.
- Constraint, foreign-key, and rollback tests.
- File and directory permission tests.
- Corrupt database and failed migration isolation tests.

### Concurrency and recovery

- Two independent SQLite connections race to claim one Job; exactly one wins.
- Heartbeat extends a live lease.
- Expired lease recovery schedules a bounded retry.
- Restart after a committed checkpoint resumes from that checkpoint.
- Resume-session failure creates a new session without losing the durable
  brief.

### Execution protocol

- Valid `continue`, `completed`, `failed`, and `blocked` output-schema cases.
- Missing required fields, oversized fields, unknown fields, and malformed
  output fail safely.
- A `continue` step does not consume failure retry budget.
- Maximum steps, retries, timeout, and age terminate predictably.
- No visible-text sentinel can alter continuation state.

### Cancellation

- Cancel queued and waiting Jobs.
- Cancel a running child with `SIGTERM` and forced `SIGKILL` fallback.
- Cancellation committed before completion wins the row-version race.
- Graceful shutdown stops claims and leaves recoverable durable state.

### Authorization and commands

- Creator and owner success cases for every `/task` command.
- Other-user denial in private and group contexts.
- Existing allow-user, allow-chat, mention, and owner checks remain active.
- Commands work with a failing or unavailable Codex runner.
- Retry creates a new ID and immutable provenance.
- Delete removes sensitive body and artifacts but preserves a tombstone.

### Delivery

- Terminal state and outbox insertion roll back or commit together.
- IM retries reuse one UUID within the provider window.
- Ambiguous IM delivery after the window becomes `delivery_unknown`.
- Document-comment read-back detects an existing terminal marker.
- Failed reconciliation does not trigger a blind duplicate send.
- Terminal payload and status output do not leak another user's data.

### Integration and regression

- A process-level smoke test creates a Job, commits a checkpoint, kills the
  plugin, restarts it, and verifies one terminal delivery.
- Lifecycle guard permits a promise only after successful durable creation.
- Existing cronjobs, foreground action dispatch, IM replies, doc-comment
  replies, session storage, and turn obligations remain compatible.
- Run typecheck, build, architecture checks, the complete smoke suite, dry-run,
  and runtime package smoke.
- Run install and startup verification in a clean Node.js `24.15.0`
  environment.

## 18. Release and Migration

This feature is released directly as `v2.0.0` after all verification passes.
There is no rollout flag for a legacy backend and no compatibility code to
remove later.

Release documentation must state:

- Node.js `>=24.15.0` is required before upgrading.
- Continuation is enabled by default and can be disabled operationally.
- The new environment variables and defaults.
- The `/task` command and authorization behavior.
- The separate continuation and cronjob models.
- The practical terminal delivery guarantee and `delivery_unknown` behavior.
- The location and retention of local continuation state.

Because this is a new bounded context, there is no existing Job data to
migrate. Existing cronjob files and Codex session files are not imported or
modified.

## 19. Main Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| `node:sqlite` raises the runtime floor | Major-version cutover, startup check, clean Node 24.15 verification |
| Synchronous database calls block the event loop | Short repository-only operations; no I/O inside transactions |
| Duplicate execution after crash | Leases, durable checkpoints, bounded retries, blocked unsafe side effects |
| Duplicate terminal delivery | Transactional outbox, stable UUID, read-back where possible, `delivery_unknown` instead of blind resend |
| Background privilege expansion | Ignore user config, no custom profile, sandbox cap, separate empty action registry |
| Session loss | Durable brief and checkpoint are authoritative; sessions are replaceable |
| Sensitive local state | 0700/0600 permissions, bounded snapshots, secret redaction, authorized status output, retention |
| Coupling with cronjobs or transport | Separate domain and ports enforced by architecture checks |

## 20. Deferred Work

- Progress updates or edited status messages.
- Interactive task controls.
- Explicit manual terminal redelivery with a confirmation workflow.
- `waiting_for_user` pause/resume.
- Additional unattended idempotent parent actions.
- Multi-host repository backends.
- Rich task dashboards and historical analytics.
