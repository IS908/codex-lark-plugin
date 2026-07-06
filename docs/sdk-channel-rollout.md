# SDK channel runtime

This document covers the SDK migration state for `codex-lark-plugin`.
The live runtime is the SDK-backed channel. The pre-SDK WebSocket runtime has
been removed. A stale `LARK_CHANNEL_RUNTIME=sdk` value is ignored for upgrade
compatibility; `LARK_CHANNEL_RUNTIME=legacy` fails startup so stale rollback
configuration is visible instead of silently ignored.

## Verification commands

Run the full SDK parity set without connecting to Lark:

```bash
npm run smoke:sdk
```

Run the default SDK dry-run:

```bash
npm start -- --dry-run
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

No runtime selector is exposed. Leave `LARK_CHANNEL_RUNTIME` unset; an old
`LARK_CHANNEL_RUNTIME=sdk` line is harmless but no longer needed.

The SDK runtime owns the live Lark channel connection and forwards SDK
`message`, `comment`, and `reaction` events into the existing local processing
pipeline. MCP stdio, Codex exec delivery, session resume, memory, jobs, audit,
local CLI authorization, and reply-sending continue to be owned by this plugin.

## Rollback

If an operator sees unexpected behavior after upgrading:

1. Remove `LARK_CHANNEL_RUNTIME` from `~/.codex/channels/lark/.env` if present.
2. Reinstall the previous plugin release through the Codex plugin marketplace,
   or check out/install `v1.12.3` or earlier.
3. Restart Codex so the plugin process reloads its code and environment.
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

## Legacy path removal

The legacy path was removed after the SDK path shipped as the default runtime.
Future rollback should use package downgrade, not a hidden runtime flag.
