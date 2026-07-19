# Privacy

Codex Lark Plugin is self-hosted software. It connects the Feishu/Lark account
and Codex installation configured by the operator; the project does not run a
separate hosted service that receives plugin data.

## Data the plugin processes

Depending on the enabled features, the plugin may process chat and document
comment content, sender and chat identifiers, message metadata, attachments,
scheduled-job prompts, Codex responses, and local-tool inputs and outputs.

## Local storage

Runtime data is stored on the operator's machine under
`~/.codex/channels/lark/` by default. It can include:

- downloaded attachments in `inbox/`;
- chat, thread, and profile memory in `memories/`, including separate public
  and private profile tiers;
- Codex session bindings in `codex-sessions/`;
- scheduled jobs and continuation state;
- runtime configuration; and
- debug, audit, and optional tool-trace logs in `logs/`.

Feishu/Lark and Codex may retain data under their own terms and settings. A
configured local CLI tool can also send or store data according to that tool's
behavior. Local CLI execution is disabled unless the operator explicitly
configures an allowlisted tool and its permitted inputs.

## Retention and deletion

The operator controls the local installation and its files. Inbox age and size
limits, log rotation and archive retention, memory limits, session retention,
and continuation retention are configurable; see the repository README for the
current environment variables and defaults. Users can inspect and remove their
stored profile entries with the memory-transparency tools where enabled.

Uninstalling the plugin does not automatically remove local runtime data,
Feishu/Lark data, Codex session data, or data created by external tools. The
operator should remove or retain those records according to their own policy.

## Security and access

The operator is responsible for securing the host, Feishu/Lark application
credentials, Codex configuration, local files, allowlists, and any configured
tools. Sensitive plugin operations derive caller identity from authenticated
Feishu/Lark events and are recorded in a local audit log with redacted
arguments. No software can guarantee absolute security.

Questions or security reports may be submitted through the repository's GitHub
issue tracker. Do not include credentials, private messages, or other sensitive
data in a public issue.
