# SDK channel rollout and rollback

This document covers the SDK migration state for `codex-lark-plugin`.
During internal testing, the default live runtime is the SDK-backed channel.
The pre-SDK runtime remains available as `LARK_CHANNEL_RUNTIME=legacy` for
rollback.

## Verification commands

Run the full SDK parity set without connecting to Lark:

```bash
npm run smoke:sdk
```

Run the default SDK dry-run:

```bash
npm start -- --dry-run
```

Run the legacy rollback dry-run:

```bash
LARK_CHANNEL_RUNTIME=legacy npm start -- --dry-run
```

Run the full project check before release:

```bash
npm run typecheck
npm test
cd plugins/lark && npm run typecheck
```

The SDK smoke suite covers:

- scaffold construction and stderr-only logging;
- server-derived identity binding and reserved `__terminal__` rejection;
- normalized message parity for P2P, group mention gating, whitelist OR
  semantics, mentions, thread/root/reply fields, attachment resource metadata,
  and doc-comment identity envelopes;
- outbound mapping for reply, edit, reaction, ack-reaction removal, and defer;
- live SDK runtime event bridging into the existing local processing pipeline;
- this rollout document's required operational instructions.

## Current rollout controls

Use the default SDK runtime for internal testing:

```bash
LARK_CHANNEL_RUNTIME=sdk
```

or leave `LARK_CHANNEL_RUNTIME` unset.

The SDK runtime owns the live Lark channel connection and forwards SDK
`message`, `comment`, and `reaction` events into the existing local processing
pipeline. MCP stdio, Codex exec delivery, session resume, memory, jobs, audit,
local CLI authorization, and reply-sending continue to be owned by this plugin.

## Rollback

If an operator sees unexpected behavior after upgrading:

1. Set `LARK_CHANNEL_RUNTIME=legacy`.
2. Restart Codex so the plugin process reloads its environment.
3. If the package itself must be rolled back, reinstall the previous plugin
   release through the Codex plugin marketplace.
4. Re-run `npm start -- --dry-run` from the active plugin directory.

Rollback does not require changing credentials, memory files, scheduled jobs,
or local plugin configuration.

## Code locations that must stay in sync

During development and release, keep these three locations synchronized:

- workspace: this repository checkout, the source of truth;
- marketplace clone: `~/.codex/plugins/marketplaces/codex-lark-plugin/`;
- runtime cache: `~/.codex/plugins/cache/codex-lark-plugin/lark/<version>/`.

After release installation, verify the runtime cache version selected by Codex
matches the package and plugin manifest version.

## Criteria to remove the legacy path

Do not remove the legacy path until the SDK path has been the default for at
least one stable release and no rollback-only issues remain open. Removal also
requires updating operator docs, plugin manifests, marketplace/cache sync
guidance, and release notes in the same PR.
