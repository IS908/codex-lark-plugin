# Offline dependency reuse

This is an operator opt-in for projects already using [managed storage and pinned Git reuse](../README.md#optional-local-git-object-reuse). New foreground turns, prompt Cron runs, and Async Tasks for an enabled project select artifacts from the exact registered Git commit. A run gets a private install, not a shared `node_modules` or Python environment. Old runs and projects without a matching policy do not acquire a new selection.

## Prepare artifacts

Use an isolated provisioning environment and already approved packages. The plugin never fetches packages, and does not use your normal npm, pip, or home-directory cache.

| Policy | Committed input | Dedicated read-only artifact directory | Manifest records |
| --- | --- | --- | --- |
| `npm` | Root `package.json` and `package-lock.json` v3, with a single HTTPS registry. | Only `_cacache/content-v2/sha512/AA/BB/REST` blobs. Hash the compressed tarball with SHA-512; `AA` and `BB` are the first and next two lowercase hex digits, and `REST` is the remainder. Use a new directory rather than copying an entire npm cache. | `{ "resolved": "https://registry.example/package/-/package-1.0.0.tgz", "integrity": "sha512-<base64 digest>" }` once per distinct resolved URL. |
| `pip` | Root `requirements.lock`, one exact `name==version` with `--hash=sha256:<hex>` per required package, including transitive packages. | Only the matching `.whl` files for the approved platform and runtime, at the top level. | `{ "filename": "name-1.0.0-py3-none-any.whl", "sha256": "<lowercase hex digest>" }` once per wheel. |

The npm scope excludes workspaces, links, local or Git dependencies, alternate registries and patched packages. Lifecycle scripts do not run; packages that require a post-install step are not covered. The pip scope excludes source distributions, URLs, editable installs, nested requirements, index settings, markers, and extras. Use a lock already resolved for the target. Python imports come from the installed directory added to `PYTHONPATH` for the command, not through a virtual environment or `.pth` activation. Unsupported locks or archive layouts are rejected.

Keep artifact directories inside the workload's existing authorized roots and outside all writable areas. Choose a new immutable physical directory for each key and scope, without symlinks or hardlinks. Files and ancestors must not allow untrusted writes. Do not modify a cache in place.

## Bind the toolchain and register the cache

1. Use a [supported native Codex launcher](../README.md#optional-local-git-object-reuse), with `LARK_CODEX_EXEC_COMMAND` set to its absolute path. On Linux the dependency installer also requires `/usr/bin/unshare` and user namespaces. Use separately provisioned, protected runtimes and installers. Node needs a standalone executable and a complete npm tree containing `bin/npm-cli.js`. CPython needs the standalone runtime, stdlib and its shared libraries, plus a separate pip package tree. Runtime and installer bindings cannot contain the dependency cache.
2. Separate the dependency registry, caches and toolchains from every write root, including managed storage, state database directories, the launcher temporary root, and a pre-existing dedicated `CODEX_HOME`. Stop the service and wait for previous sandboxed commands to exit before enabling or moving these protected locations. The registry also protects these locations on launches that do not select a cache.
3. Prepare an array of manifest records from the table. From the repository source checkout with its development dependencies installed, use `pinWorkspacePath(directory, '.')` from `src/workspace-projects.ts` to obtain the canonical `{ directory, device, inode }` bindings. Build the toolchain record `{ ecosystem, executable, runtime, installer }`, where `runtime` and `installer` are those bindings and `executable` is the absolute runtime binary within `runtime`. Use `probeWorkspaceDependencyToolchain` from `src/workspace-dependency-toolchain.ts` with `{ configured, codexCommand, temporaryRoot }`, where `temporaryRoot` is a pinned disjoint scratch root. Use the returned `toolchain`, not a manually entered version string.
4. In that source checkout, pass the raw lock bytes from the registered Git commit, Git scope, and measured `toolchain` to the matching helper from `src/workspace-dependency-input.ts`. For npm, call `prepareWorkspaceNpmLock({ ecosystem: 'npm', lock, manifest: packageJsonBytes, registry, scope, toolchain }, records)`. For pip, call `prepareWorkspacePipLock({ ecosystem: 'pip', lock, scope, toolchain }, records)`. Both return `identity.key` and `artifactManifestSha256`. Use the exact Git bytes, including line endings, and use the helper's digest rather than hashing the manifest JSON file directly. The compatibility key includes the installer policy, exact contents, platform, architecture, runtime/ABI, and installer version.
5. Beside `managed-workspace.json`, save the records array to `workspace-dependency-manifests/<identity.key>.json` and write `workspace-dependencies.json`. Use strict JSON with these fields:

   | Field | Value |
   | --- | --- |
   | `version` | `1` |
   | `projects` | Array of `{ source, repositoryId, policies }`. `source` is the pinned project binding. Copy `repositoryId` from the Git registration. Entries in `policies` are `{ "ecosystem": "pip" }` or `{ "ecosystem": "npm", "registry": "https://registry.npmjs.org/" }`. |
   | `caches` | Array of `{ scope, key, ecosystem, cache, artifactManifestSha256 }`. `cache` is the pinned artifact directory binding; `scope` matches the registered Git scope. |
   | `toolchains` | Array of the toolchain records prepared in step 3, at most one per ecosystem. |

   Keep the registry and manifests operator-owned and private (for example, mode `0600`, with `0700` directories).

## Run and recover

The installer verifies compressed files and bounded archive expansion before installing. It uses a bounded private snapshot of the shared bytes, with network disabled, and does not inherit installer credentials or user configuration. Each run owns its output. npm uses its checkout's `node_modules` without overwriting an existing path. Python commands that need the installed packages can use `PYTHONPATH="$LARK_MANAGED_PYTHON_DEPS" python -B ...`; the plugin does not append to an inherited `PYTHONPATH` or automatically switch the interpreter. Use a compatible interpreter. Do not modify the installed tree if the same run needs to resume.

A missing, altered, or revoked cache, toolchain, or manifest blocks an affected run. To revoke use while retaining write protection, remove the project's dependency policy and leave protected cache and toolchain registrations in place. Restore an exact approved binding or admit a new run under a new approval. An interrupted install with no ready receipt is not adopted or automatically reinstalled; start a new run instead. Already committed deliveries use their own artifact authorization and do not need another dependency install. This feature does not migrate, delete, or clean old caches or checkout folders.
