# Privacy Policy

Last updated: September 4, 2026

Codex Lark Plugin is open-source software that runs on infrastructure controlled
by the person or organization that installs it. The project publisher does not
operate a hosted proxy for the plugin and does not receive plugin telemetry by
default.

## Data the plugin processes

To provide its features, the plugin may process:

- Feishu/Lark messages, document comments, reactions, sender identifiers, chat
  identifiers, quoted-message context, and attachments delivered to the bot;
- prompts, generated responses, tool calls, scheduled-job definitions, durable
  task state, and delivery state;
- bot credentials, access-control settings, model settings, and local-tool
  allowlists configured by the operator;
- local memory, diagnostic logs, audit records, Codex session pointers, and
  downloaded files.

## Where data goes

The plugin exchanges data directly with Feishu/Lark and with the locally
configured Codex runtime. Those services process data under their own privacy
policies and account settings. Optional local CLI tools or skills may send data
to additional services; the operator controls which tools are installed and
allowed.

The plugin does not intentionally send analytics, message content, or local
files to the project publisher. Network requests required by Feishu/Lark, Codex,
and operator-enabled tools are not publisher telemetry.

## Local storage and retention

Runtime data is stored under `~/.codex/channels/lark/` by default, including:

- `memories/` for local profile and episodic memory;
- `jobs/` for scheduled-job definitions and schedule cursors;
- `runtime/continuations/` for durable run history, managed inputs, and output
  artifacts;
- `inbox/` for downloaded message attachments;
- `codex-sessions/` for conversation resume pointers;
- `logs/` for debug, audit, trace, and compressed archive logs.

The operator can configure retention for inbox files, session pointers,
continuation data, and log archives. Memory and job definitions remain until an
operator or authorized user removes them. Log rotation limits active files, and
monthly archive retention defaults to six months. Consult the README and
`.env.example` for the current settings and defaults.

Logs apply the plugin's existing redaction rules, but operators should still
treat local logs as potentially sensitive because message identifiers, commands,
paths, error details, and other operational context may be recorded.

## Access and control

The host operating-system account is inside the plugin's trust boundary. File
permissions, Feishu/Lark app permissions, sender allowlists, owner controls, and
local-tool configuration determine who can cause data to be read or changed.
Operators are responsible for securing bot credentials, the host account, and
the runtime directory.

Authorized users can inspect or remove supported memory entries through the
plugin. Operators can also stop the plugin and delete locally stored runtime
data. Deleting local data does not delete copies retained by Feishu/Lark, Codex,
or an operator-enabled external service.

## Changes and contact

Material changes to this policy are published in this repository. Questions or
privacy reports can be filed through the repository's GitHub issue tracker.
