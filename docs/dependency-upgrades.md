# Dependency Upgrade Policy

The project upgrades direct dependencies to the latest stable release by
default, including major releases and breaking `0.x` minor releases. An update
is accepted only when it remains compatible with the project's declared
runtime and passes the relevant behavior checks.

## Compatibility Boundaries

- `@types/node` tracks the supported Node.js major rather than npm's global
  latest tag. While the minimum runtime remains Node.js 24, use the newest
  `@types/node@24` release so type checking cannot approve Node 25+ APIs.
- Keep dependency declarations and lockfiles synchronized between the root
  package and `plugins/lark`. They represent one release, not independent apps.
- Upgrade `@larksuite/channel` and `@larksuiteoapi/node-sdk` together when the
  channel package changes its direct SDK range.
- Give each high-risk runtime dependency, or tightly coupled dependency group,
  its own PR. Low-risk development tooling may share a PR.
- Do not add permanent compatibility branches for an old dependency major.
  Fix forward or revert the isolated upgrade PR.

## Automated Pull Requests

Dependabot scans both package directories weekly. Its groups keep coupled
packages and their two manifests in one PR. Major, minor, and patch updates are
enabled. The Node type package is the exception: cross-major updates remain
blocked until the supported runtime major changes deliberately.

Automated PRs are proposals, not authorization to merge. Review release notes,
the resolved dependency graph, generated runtime changes, and security audit
results before merging.

## Verification

Start from a clean install and run the standard checks:

```bash
npm ci
npm test
npm run smoke:sdk
npm run audit:deps
npm --prefix plugins/lark run audit:deps
```

For runtime dependency changes, also verify the corresponding integration
smokes and confirm that `npm run --silent start -- --dry-run` writes nothing to
stdout. Rebuild and commit `plugins/lark/runtime` whenever the bundle sync check
reports a dependency-driven change.
