import fs from 'node:fs/promises';
import path from 'node:path';

const RELATIVE_PATH_ERROR =
  'Continuation working directory must be relative and remain within LARK_CONTINUATION_WORKING_ROOT.';
const EXISTING_DIRECTORY_ERROR =
  'Continuation working directory must be an existing directory, and configured roots must exist.';
const OUTSIDE_ROOT_ERROR =
  'Continuation working directory resolves outside the configured continuation working root.';
const REQUESTED_PATH_ERROR =
  'Continuation requested path must exist and be accessible.';

export class ContinuationWorkingDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContinuationWorkingDirectoryError';
  }
}

export async function resolveContinuationWorkingDirectory(
  configuredRoot: string,
  relativeDirectory: string,
): Promise<{ root: string; workingDirectory: string }> {
  if (
    !relativeDirectory
    || path.isAbsolute(relativeDirectory)
    || /^[A-Za-z]:[\\/]/.test(relativeDirectory)
    || relativeDirectory.startsWith('\\\\')
    || relativeDirectory.split(/[\\/]+/).includes('..')
  ) {
    throw new ContinuationWorkingDirectoryError(RELATIVE_PATH_ERROR);
  }
  const root = requireAbsoluteRoot(configuredRoot);
  const candidate = path.resolve(root, relativeDirectory);
  assertLexicallyContained(root, candidate);
  const [realRoot, realCandidate] = await canonicalDirectories(root, candidate);
  assertLexicallyContained(realRoot, realCandidate);
  return { root: realRoot, workingDirectory: realCandidate };
}

export async function validateContinuationWorkingDirectory(
  configuredRoots: string[],
  candidate: string,
): Promise<string> {
  if (!path.isAbsolute(candidate) || configuredRoots.length === 0) {
    throw new ContinuationWorkingDirectoryError(RELATIVE_PATH_ERROR);
  }
  const roots = configuredRoots.map(requireAbsoluteRoot);

  let realCandidate: string;
  let realRoots: string[];
  try {
    [realCandidate, ...realRoots] = await Promise.all([
      canonicalDirectory(candidate),
      ...roots.map(canonicalDirectory),
    ]);
  } catch {
    throw new ContinuationWorkingDirectoryError(EXISTING_DIRECTORY_ERROR);
  }
  for (const root of realRoots) assertLexicallyContained(root, realCandidate);
  return realCandidate;
}

export async function resolveContinuationRequestedPaths(
  configuredRoot: string,
  requestedPaths: string[],
): Promise<string[]> {
  const root = requireAbsoluteRoot(configuredRoot);
  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const requestedPath of requestedPaths) {
    const value = requestedPath.trim();
    if (!value || value.includes('\0')) {
      throw new ContinuationWorkingDirectoryError(REQUESTED_PATH_ERROR);
    }
    const candidate = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
    let canonical: string;
    try {
      canonical = await fs.realpath(candidate);
      await fs.stat(canonical);
    } catch {
      throw new ContinuationWorkingDirectoryError(
        `Continuation requested path does not exist or is not accessible: ${value}`,
      );
    }
    if (!seen.has(canonical)) {
      seen.add(canonical);
      resolved.push(canonical);
    }
  }
  return resolved;
}

function requireAbsoluteRoot(root: string): string {
  if (!path.isAbsolute(root)) {
    throw new ContinuationWorkingDirectoryError(
      'LARK_CONTINUATION_WORKING_ROOT must be an absolute path to an existing directory.',
    );
  }
  return path.resolve(root);
}

function assertLexicallyContained(root: string, candidate: string): void {
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new ContinuationWorkingDirectoryError(OUTSIDE_ROOT_ERROR);
  }
}

async function canonicalDirectories(root: string, candidate: string): Promise<[string, string]> {
  try {
    return await Promise.all([canonicalDirectory(root), canonicalDirectory(candidate)]);
  } catch {
    throw new ContinuationWorkingDirectoryError(EXISTING_DIRECTORY_ERROR);
  }
}

async function canonicalDirectory(directory: string): Promise<string> {
  const canonical = await fs.realpath(directory);
  const metadata = await fs.stat(canonical);
  if (!metadata.isDirectory()) throw new Error('not a directory');
  return canonical;
}
