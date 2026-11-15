# Conversational Cron Controls Design

## Intent

Keep Cron result cards focused on their output while preserving restart-safe,
source-aware task management through quoted replies and topic replies.

## Goals

- Stop rendering pause, view, and run-now buttons on new Cron report cards.
- Keep the source footer and every confirmed `message_id -> Job + Run` mapping.
- Resolve a reply under a report topic through the report parent/root message.
- Use the trusted source Job ID for view, pause, schedule updates, and reruns.
- Keep owner, visibility, chat, and Job-instance checks unchanged.
- Report the Job display name, stable ID, and persisted operation result.

## Non-Goals

- Removing the card-action callback handler used by already delivered cards.
- Parsing arbitrary natural-language schedules outside Codex's existing
  structured `update_job` action.
- Guessing a Job from general chat history when no trusted source or unique
  explicit name exists.

## Approach

Remove only the `cardActions` field from new Cron report delivery. Keep the
origin recorder, source footer, control service, and SDK callback handler.
Expand the trusted quoted-Job prompt so Codex uses `get_job`, `disable_job`,
`update_job`, or `run_job` with the persisted Job ID, and fence source-targeted
actions with the recorded Job creation timestamp. Deterministic short commands
continue to bypass Codex; add the requested "run again" phrasing.

## Safety

An old report must not mutate a replacement Job that reused the same ID.
Ambiguous unmapped commands remain non-mutating and return concise candidates.
Schedule updates remain owner-authorized and reuse the persisted definition.
