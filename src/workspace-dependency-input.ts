import { createHash } from 'node:crypto';
import { z } from 'zod';

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_PACKAGES = 25_000;
const MAX_JSON_VALUES = 250_000;
const scopeSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,95}$/);
const tokenSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,127}$/);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const toolchainSchema = z.strictObject({
  runtime: tokenSchema,
  installer: tokenSchema,
  abi: tokenSchema,
  platform: z.enum(['darwin', 'linux']),
  arch: z.enum(['x64', 'arm64']),
  platformAbi: tokenSchema,
});

const commonIdentity = { version: z.literal(1), scope: scopeSchema, toolchain: toolchainSchema, lockSha256: digestSchema };
const dependencyIdentityShape = z.discriminatedUnion('ecosystem', [
  z.strictObject({ ...commonIdentity, ecosystem: z.literal('npm'), policy: z.literal('npm-ci-offline-no-scripts-v1'),
    registry: z.string().max(2048), manifestSha256: digestSchema, key: digestSchema }),
  z.strictObject({ ...commonIdentity, ecosystem: z.literal('pip'), policy: z.literal('pip-offline-hashed-wheels-v1'), key: digestSchema }),
]);
export type WorkspaceDependencyIdentity = z.infer<typeof dependencyIdentityShape>;
type CompatibilityInputs = Omit<Extract<WorkspaceDependencyIdentity, { ecosystem: 'npm' }>, 'key'>
  | Omit<Extract<WorkspaceDependencyIdentity, { ecosystem: 'pip' }>, 'key'>;

export const workspaceDependencyIdentitySchema = dependencyIdentityShape.refine((identity) => {
  try {
    if (identity.ecosystem === 'npm') registryUrl(identity.registry);
    return compatibilityKey(identity) === identity.key;
  } catch { return false; }
}, 'Invalid dependency compatibility identity.');

export type WorkspaceDependencyInput = { lock: Uint8Array; scope: string; toolchain: z.input<typeof toolchainSchema> } & (
  { ecosystem: 'npm'; manifest: Uint8Array; registry: string } | { ecosystem: 'pip' });

export class WorkspaceDependencyInputError extends Error {
  constructor(readonly code: 'dependency_input_invalid' | 'dependency_input_unsupported' | 'dependency_artifact_missing' | 'dependency_artifact_conflict') {
    super({ dependency_input_invalid: 'Dependency inputs are incomplete or invalid.',
      dependency_input_unsupported: 'Dependency inputs use an unsupported format or source.',
      dependency_artifact_missing: 'The artifact manifest does not cover the dependency lock.',
      dependency_artifact_conflict: 'The artifact manifest conflicts with the dependency lock.' }[code]);
  }
}

const npmArtifactManifestSchema = z.array(z.strictObject({ resolved: z.string().max(2048), integrity: z.string().max(95) })).max(MAX_PACKAGES);
const pythonArtifactManifestSchema = z.array(z.strictObject({ filename: z.string().max(255), sha256: digestSchema })).max(MAX_PACKAGES);

// The installer must verify the actual protected cache bytes against this manifest before use.
export function prepareWorkspaceNpmLock(input: Extract<WorkspaceDependencyInput, { ecosystem: 'npm' }>, manifest: unknown) {
  const plan = describeWorkspaceDependencies(input);
  if (plan.ecosystem !== 'npm') invalid();
  const parsed = npmArtifactManifestSchema.safeParse(manifest);
  if (!parsed.success) invalid();
  const accepted = new Map<string, string>();
  for (const { resolved, integrity } of parsed.data) {
    if (accepted.has(resolved) || !validNpmIntegrity(integrity)) invalid();
    accepted.set(resolved, integrity);
  }
  const lock = parseJson(decodeInput(input.lock));
  const packages = jsonRecord.parse(lock.packages);
  const { artifacts, ...identity } = plan;
  const used = new Set<string>();
  for (const { path, resolved, integrity } of artifacts) {
    const expected = accepted.get(resolved);
    if (!expected) throw new WorkspaceDependencyInputError('dependency_artifact_missing');
    if (integrity !== null && expected !== integrity) throw new WorkspaceDependencyInputError('dependency_artifact_conflict');
    used.add(resolved);
    packages[path] = { ...jsonRecord.parse(packages[path]), resolved, integrity: expected };
  }
  if (used.size !== accepted.size) throw new WorkspaceDependencyInputError('dependency_artifact_conflict');
  const sorted = [...accepted.entries()].sort(([a], [b]) => lexical(a, b));
  const staged = JSON.stringify({ ...lock, packages }) + '\n';
  if (Buffer.byteLength(staged) > MAX_INPUT_BYTES) invalid();
  return { identity, lock: staged, artifacts: sorted.map(([resolved, integrity]) => ({ resolved, integrity })),
    artifactManifestSha256: digest(JSON.stringify(['npm-artifacts-v1', sorted])) };
}

export function prepareWorkspacePipLock(input: Extract<WorkspaceDependencyInput, { ecosystem: 'pip' }>, manifest: unknown) {
  const plan = describeWorkspaceDependencies(input);
  if (plan.ecosystem !== 'pip') invalid();
  const parsed = pythonArtifactManifestSchema.safeParse(manifest);
  if (!parsed.success) invalid();
  const { requirements, ...identity } = plan;
  const pins = new Map(requirements.map(({ name, version, hashes }) => [name, { version, hashes: new Set(hashes) }]));
  const collected = new Map<string, Set<string>>();
  const seen = new Set<string>();
  for (const { filename, sha256 } of parsed.data) {
    const wheel = /^([a-zA-Z0-9_]+)-([0-9][a-zA-Z0-9_.!+]*)(?:-\d[a-zA-Z0-9_]*)?-[a-zA-Z0-9_.]+-[a-zA-Z0-9_.]+-[a-zA-Z0-9_.]+\.whl$/.exec(filename);
    if (!wheel || seen.has(filename)) invalid();
    seen.add(filename);
    const name = pythonName(wheel[1]);
    const pin = pins.get(name);
    if (!pin || !pin.hashes.has(sha256) || !matchesPythonPin(pin.version, wheel[2])) {
      throw new WorkspaceDependencyInputError('dependency_artifact_conflict');
    }
    if (!collected.has(name)) collected.set(name, new Set());
    collected.get(name)!.add(sha256);
  }
  const lock = requirements.map(({ name, version }) => {
    const hashes = collected.get(name);
    if (!hashes) throw new WorkspaceDependencyInputError('dependency_artifact_missing');
    return `${name}==${version} ${[...hashes].sort().map((hash) => `--hash=sha256:${hash}`).join(' ')}`;
  }).join('\n') + '\n';
  if (Buffer.byteLength(lock) > MAX_INPUT_BYTES) invalid();
  const sorted = parsed.data.map(({ filename, sha256 }) => [filename, sha256]).sort(([a], [b]) => lexical(a, b));
  return { identity, lock, artifacts: sorted.map(([filename, sha256]) => ({ filename, sha256 })),
    artifactManifestSha256: digest(JSON.stringify(['pip-artifacts-v1', sorted])) };
}

export function describeWorkspaceDependencies(input: WorkspaceDependencyInput) {
  const scope = scopeSchema.safeParse(input.scope);
  const toolchain = toolchainSchema.safeParse(input.toolchain);
  if (!scope.success || !toolchain.success) invalid();
  const lock = decodeInput(input.lock);
  const base = { version: 1 as const, scope: scope.data, toolchain: toolchain.data, lockSha256: digest(input.lock) };
  if (input.ecosystem === 'npm') {
    const registry = registryUrl(input.registry);
    const manifest = parseJson(decodeInput(input.manifest));
    const artifacts = readNpmArtifacts(parseJson(lock), manifest, registry);
    const manifestSha256 = digest(input.manifest);
    const policy = 'npm-ci-offline-no-scripts-v1' as const;
    const identity = { ...base, ecosystem: 'npm' as const, policy, registry: registry.href, manifestSha256 };
    return { ...identity, key: compatibilityKey(identity), artifacts };
  }
  const requirements = readPythonRequirements(lock);
  const policy = 'pip-offline-hashed-wheels-v1' as const;
  const identity = { ...base, ecosystem: 'pip' as const, policy };
  return { ...identity, key: compatibilityKey(identity), requirements };
}

function compatibilityKey(identity: CompatibilityInputs): string {
  const { ecosystem, policy, scope, lockSha256, toolchain: { runtime, installer, abi, platform, arch, platformAbi } } = identity;
  const parts = ['workspace-dependencies-v1', scope, runtime, installer, abi, platform, arch, platformAbi, lockSha256, ecosystem, policy];
  if (identity.ecosystem === 'npm') parts.push(identity.registry, identity.manifestSha256);
  return digest(JSON.stringify(parts));
}

function digest(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeInput(bytes: Uint8Array): string {
  if (!bytes.byteLength || bytes.byteLength > MAX_INPUT_BYTES) invalid();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return invalid(); }
}

const jsonRecord = z.record(z.string(), z.unknown());

function parseJson(text: string): Record<string, unknown> {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return invalid(); }
  const stack: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++count > MAX_JSON_VALUES || depth > 64) invalid();
    if (value !== null && typeof value === 'object') {
      const children = Object.values(value);
      if (count + stack.length + children.length > MAX_JSON_VALUES) invalid();
      for (const child of children) stack.push({ value: child, depth: depth + 1 });
    }
  }
  const record = jsonRecord.safeParse(raw);
  return record.success ? record.data : invalid();
}

function trustedUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\?#]/.test(value)) unsupported();
  let url: URL;
  try { url = new URL(value); } catch { return unsupported(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== value) unsupported();
  return url;
}

function registryUrl(value: string): URL {
  const url = trustedUrl(value);
  if (!url.pathname.endsWith('/') || !/^\/(?:[a-zA-Z0-9_-]+\/)*$/.test(url.pathname)) unsupported();
  return url;
}

const npmName = /^(?:@[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9_.-]*$/;
const npmRangeOrTag = /^(?:[a-zA-Z0-9*^~<>=][a-zA-Z0-9*^~<>=.+| -]{0,255})$/;
const npmVersion = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
const npmFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

function validNpmIntegrity(integrity: unknown): integrity is string {
  return typeof integrity === 'string' && /^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)
    && `sha512-${Buffer.from(integrity.slice(7), 'base64').toString('base64')}` === integrity;
}

function npmDependencyTables(record: Record<string, unknown>): Array<Array<[string, string]>> {
  if (['workspaces', 'bundleDependencies', 'bundledDependencies', 'patchedDependencies', 'patched'].some((name) => Object.hasOwn(record, name))
    || ['link', 'inBundle', 'hasShrinkwrap'].some((flag) => Object.hasOwn(record, flag) && record[flag] !== false)) unsupported();
  if (Object.hasOwn(record, 'overrides')) validateNpmOverrides(record.overrides);
  return npmFields.map((field) => {
    const table = jsonRecord.safeParse(record[field] === undefined ? {} : record[field]);
    if (!table.success) invalid();
    return Object.entries(table.data).map(([name, spec]): [string, string] => {
      if (!npmName.test(name) || typeof spec !== 'string' || !npmRangeOrTag.test(spec)) unsupported();
      return [name, spec];
    }).sort(([left], [right]) => lexical(left, right));
  });
}

function validateNpmOverrides(input: unknown): void {
  let count = 0;
  const visit = (value: unknown, depth: number): void => {
    const table = jsonRecord.safeParse(value);
    if (!table.success || depth >= 32) unsupported();
    for (const [selector, spec] of Object.entries(table.data)) {
      if (++count > MAX_PACKAGES) invalid();
      const at = selector.lastIndexOf('@');
      if (!(depth > 0 && selector === '.') && !(at > 0
        ? npmName.test(selector.slice(0, at)) && npmRangeOrTag.test(selector.slice(at + 1)) : npmName.test(selector))) unsupported();
      if (typeof spec === 'string') {
        if (!npmRangeOrTag.test(spec) && !(spec.startsWith('$') && npmName.test(spec.slice(1)))) unsupported();
      } else if (selector !== '.') visit(spec, depth + 1);
      else unsupported();
    }
  };
  visit(input, 0);
}

function readNpmArtifacts(lock: Record<string, unknown>, manifest: Record<string, unknown>, registry: URL) {
  if (lock.lockfileVersion !== 3 || Object.hasOwn(lock, 'patchedDependencies') || Object.hasOwn(lock, 'patched')) unsupported();
  const packages = jsonRecord.safeParse(lock.packages);
  if (!packages.success) invalid();
  const root = jsonRecord.safeParse(packages.data['']);
  if (!root.success || Object.keys(packages.data).length > MAX_PACKAGES + 1) invalid();
  const rootDependencies = npmDependencyTables(root.data);
  if (JSON.stringify(rootDependencies) !== JSON.stringify(npmDependencyTables(manifest))
    || root.data.name !== manifest.name || root.data.version !== manifest.version
    || rootDependencies[3].some(([name]) => optionalNpmPeer(root.data, name) !== optionalNpmPeer(manifest, name))) invalid();
  requireNpmDependencyRecords(packages.data, '', manifest, rootDependencies);
  return Object.entries(packages.data).filter(([relative]) => relative !== '').sort(([left], [right]) => lexical(left, right))
    .map(([relative, raw]) => {
      if (relative.length > 4096) unsupported();
      const segments = relative.split('/');
      let name = '';
      let depth = 0;
      for (let i = 0; i < segments.length;) {
        if (++depth > 32 || segments[i++] !== 'node_modules' || i === segments.length) unsupported();
        name = segments[i++];
        if (name.startsWith('@')) name += `/${segments[i++] ?? ''}`;
        if (!npmName.test(name)) unsupported();
      }
      const parsed = jsonRecord.safeParse(raw);
      if (!parsed.success) invalid();
      const { version, integrity, resolved } = parsed.data;
      requireNpmDependencyRecords(packages.data, relative, parsed.data, npmDependencyTables(parsed.data));
      if (typeof version !== 'string' || !npmVersion.test(version) || (parsed.data.name !== undefined && parsed.data.name !== name)
        || (integrity !== undefined && !validNpmIntegrity(integrity))) unsupported();
      const filename = `${name.split('/').at(-1)}-${version}.tgz`;
      const expected = `${registry.href}${name}/-/${filename}`;
      if (resolved !== undefined && trustedUrl(resolved).href !== expected) unsupported();
      return { path: relative, resolved: expected, integrity: integrity ?? null };
    });
}

function optionalNpmPeer(record: Record<string, unknown>, name: string): boolean {
  const table = record.peerDependenciesMeta;
  if (typeof table !== 'object' || table === null || !Object.hasOwn(table, name)) return false;
  const meta = (table as Record<string, unknown>)[name];
  return typeof meta === 'object' && meta !== null && Object.hasOwn(meta, 'optional') && (meta as Record<string, unknown>).optional === true;
}

// Check required record coverage here; npm still validates the effective install graph and versions.
function requireNpmDependencyRecords(packages: Record<string, unknown>, owner: string, record: Record<string, unknown>,
  [dependencies, dev, optional, peers]: Array<Array<[string, string]>>): void {
  const optionalNames = new Set(optional.map(([name]) => name));
  for (const [name] of [...dependencies, ...(owner === '' ? dev : []), ...peers.filter(([peer]) => !optionalNpmPeer(record, peer))]) {
    if (optionalNames.has(name)) continue;
    let cursor = owner;
    for (;;) {
      if (Object.hasOwn(packages, `${cursor ? `${cursor}/` : ''}node_modules/${name}`)) break;
      if (!cursor) invalid();
      cursor = cursor.slice(0, Math.max(0, cursor.lastIndexOf('/node_modules/')));
    }
  }
}

const canonicalPythonVersion = /^(?:(\d+)!)?(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?(?:\+([a-z0-9]+(?:\.[a-z0-9]+)*))?$/;

// Only equality for canonical PEP 440 versions is needed here; pip still validates wheel tags and metadata.
function matchesPythonPin(pin: string, version: string): boolean {
  const required = canonicalPythonVersion.exec(pin);
  const wheel = canonicalPythonVersion.exec(version);
  if (!required || !wheel) return false;
  const number = (part: string) => part.replace(/^0+(?=\d)/, '');
  const publicVersion = ([, epoch, release, pre, preNumber, post, dev]: RegExpExecArray) => [
    number(epoch ?? '0'), release.split('.').map(number).join('.').replace(/(?:\.0)+$/, ''), pre ?? '',
    number(preNumber ?? ''), number(post ?? ''), number(dev ?? ''),
  ].join('/');
  const local = (value?: string) => value?.split('.').map((part) => /^\d+$/.test(part) ? number(part) : part).join('.');
  return publicVersion(required) === publicVersion(wheel) && (required[7] === undefined || local(required[7]) === local(wheel[7]));
}

function readPythonRequirements(text: string) {
  const records = new Map<string, { name: string; version: string; hashes: string[] }>();
  let continued = '';
  for (const raw of text.replaceAll('\r\n', '\n').split('\n')) {
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(raw)) invalid();
    const comment = raw.search(/(?:^|\s)#/);
    const line = (comment >= 0 ? raw.slice(0, comment) : raw).trim();
    if (raw.includes('\\') && (comment >= 0 || !raw.endsWith('\\') || raw.slice(0, -1).includes('\\'))) unsupported();
    if (!line) {
      if (continued) unsupported();
      continue;
    }
    if (continued.length + raw.length > 65_536) invalid();
    if (line.endsWith('\\')) {
      if (line === '\\') unsupported();
      continued += raw.slice(0, -1);
      continue;
    }
    const [requirement, ...flags] = `${continued}${comment >= 0 ? raw.slice(0, comment) : raw}`.trim().split(/\s+/);
    continued = '';
    const pin = /^([A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?)==([0-9][A-Za-z0-9.!+_-]*)$/.exec(requirement);
    if (!pin || pin[2].length > 128 || !canonicalPythonVersion.test(pin[2])
      || flags.length === 0 || flags.some((flag) => !/^--hash=sha256:[a-fA-F0-9]{64}$/.test(flag))) unsupported();
    const name = pythonName(pin[1]);
    if (records.has(name) || records.size >= MAX_PACKAGES) invalid();
    records.set(name, { name, version: pin[2], hashes: [...new Set(flags.map((flag) => flag.slice(14).toLowerCase()))].sort() });
  }
  if (continued || !records.size) invalid();
  return [...records.values()].sort((a, b) => lexical(a.name, b.name));
}

function pythonName(name: string): string { return name.toLowerCase().replace(/[-_.]+/g, '-'); }
function lexical(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function invalid(): never { throw new WorkspaceDependencyInputError('dependency_input_invalid'); }
function unsupported(): never { throw new WorkspaceDependencyInputError('dependency_input_unsupported'); }
