# SDK channel rollout and rollback

This document covers the 1.2.0 SDK migration state for `codex-lark-plugin`.
The default live runtime remains `legacy`. The SDK-backed runtime is available
for dry-run and parity smoke validation only; live startup with
`LARK_CHANNEL_RUNTIME=sdk` fails closed until a later release deliberately
removes that guard.

## Verification commands

Run the full SDK parity set without connecting to Lark:

```bash
npm run smoke:sdk
```

Run the normal legacy dry-run:

```bash
npm start -- --dry-run
```

Run the SDK scaffold dry-run:

```bash
LARK_CHANNEL_RUNTIME=sdk npm start -- --dry-run
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
- this rollout document's required operational instructions.

## Current rollout controls

Use the default runtime for all production operation:

```bash
LARK_CHANNEL_RUNTIME=legacy
```

or leave `LARK_CHANNEL_RUNTIME` unset.

For 1.2.0, `LARK_CHANNEL_RUNTIME=sdk` is a validation mode only:

- `npm start -- --dry-run` validates the SDK scaffold and exits.
- live startup fails before MCP stdio connect and before opening a Lark
  WebSocket.
- the legacy runtime remains the only production path.

This fail-closed behavior is intentional. The SDK adapter layers are present so
future PRs can wire live SDK events without changing identity, tool, memory,
job, audit, or outbound semantics at the same time.

## Rollback

If an operator sees unexpected behavior after upgrading:

1. Unset `LARK_CHANNEL_RUNTIME`, or set `LARK_CHANNEL_RUNTIME=legacy`.
2. Restart Codex so the plugin process reloads its environment.
3. If the package itself must be rolled back, reinstall the previous plugin
   release through the Codex plugin marketplace.
4. Re-run `npm start -- --dry-run` from the active plugin directory.

Because the SDK path is fail-closed for live startup in 1.2.0, rollback from an
accidental SDK setting is just reverting the environment variable to `legacy`.

## Code locations that must stay in sync

During development and release, keep these three locations synchronized:

- workspace: this repository checkout, the source of truth;
- marketplace clone: `~/.codex/plugins/marketplaces/codex-lark-plugin/`;
- runtime cache: `~/.codex/plugins/cache/codex-lark-plugin/lark/<version>/`.

After release installation, verify the runtime cache version selected by Codex
matches the package and plugin manifest version.

## Criteria to make the SDK path the default

Do not make the SDK path the default until all of these are true:

- live SDK event wiring uses the same server-derived identity and sensitive-tool
  authorization path as the legacy runtime;
- reply, edit, reaction, defer, doc-comment, attachment, and Codex exec session
  continuity checks pass against the SDK path;
- `npm run smoke:sdk`, `npm test`, and plugin package typecheck pass;
- rollout and rollback have been tested from an installed plugin cache, not only
  the workspace checkout;
- operators have a documented way to return to `LARK_CHANNEL_RUNTIME=legacy`
  without changing credentials or memory files.

## Criteria to remove the legacy path

Do not remove the legacy path until the SDK path has been the default for at
least one stable release and no rollback-only issues remain open. Removal also
requires updating operator docs, plugin manifests, marketplace/cache sync
guidance, and release notes in the same PR.
