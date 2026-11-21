import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sameWorkspaceProject, workspaceProjectBindingSchema, type WorkspaceProjectBinding } from './domain/workspace.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);
const directoryPath = z.string().min(1).refine((value) => !value.includes('\0'));
const registrySchema = z.strictObject({
  version: z.literal(1),
  roots: z.array(z.strictObject({ name: identifier, path: directoryPath.refine(path.isAbsolute) })),
  projects: z.array(z.strictObject({
    root: identifier,
    name: identifier,
    path: directoryPath.refine((value) => !path.isAbsolute(value)),
  })),
  default: z.string().optional(),
});
type Registry = z.infer<typeof registrySchema>;

const explanations = {
  invalid_selector: 'Specify a project as `/project root/name` or `/project path:<directory>`.',
  invalid_registry: 'The operator workspace project registry is invalid or unreadable.',
  ambiguous_project: 'The project name is ambiguous. Use `root/name` to select a project.',
  unknown_project: 'The workspace project is not configured.',
  outside_project_root: 'The workspace project resolves outside its configured source root.',
  outside_authorized_root: 'The selected workspace is outside the authorized execution directory.',
  unavailable_directory: 'The workspace directory is missing or inaccessible.',
  invalid_binding: 'The saved workspace selection is invalid. Select the project again.',
  directory_changed: 'The saved workspace directory has changed. Select the project again.',
} as const;

export class WorkspaceProjectError extends Error {
  constructor(readonly code: keyof typeof explanations) {
    super(explanations[code]);
    this.name = 'WorkspaceProjectError';
  }
}

export function readWorkspaceProjectDirective(text?: string): { selector: string; requestText: string } | undefined {
  if (text === undefined) return undefined;
  const firstLine = text.split(/\r?\n/, 1)[0]
    .trimStart().replace(/^(?:@\S+\s+){1,8}/, '');
  if (!firstLine || !/^\/project(?:\s|$)/.test(firstLine)) return undefined;
  const selector = firstLine.slice('/project'.length).trim();
  if (!selector) throw new WorkspaceProjectError('invalid_selector');
  const newline = text.indexOf('\n');
  return { selector, requestText: newline < 0 ? '' : text.slice(newline + 1) };
}

export interface WorkspaceProjectOptions {
  authorizedRoot: string;
  registryPath: string;
  selector?: string;
  persisted?: unknown;
}

export async function resolveWorkspaceProject({
  authorizedRoot, registryPath, selector, persisted,
}: WorkspaceProjectOptions): Promise<WorkspaceProjectBinding | undefined> {
  if (selector === undefined && persisted !== undefined) {
    return validateWorkspaceProject(authorizedRoot, persisted);
  }

  const registry = selector?.startsWith('path:') ? undefined : await readRegistry(registryPath);
  const requested = selector ?? registry?.default;
  if (requested === undefined) return undefined;
  if (!requested || requested.includes('\0')) throw new WorkspaceProjectError('invalid_selector');

  if (requested.startsWith('path:')) {
    const directory = requested.slice('path:'.length).trim();
    if (!directory) throw new WorkspaceProjectError('invalid_selector');
    return pinWorkspacePath(authorizedRoot, directory);
  }

  const matches = registry?.projects.filter((project) => requested.includes('/')
    ? `${project.root}/${project.name}` === requested
    : project.name === requested) ?? [];
  if (!matches.length || !registry) throw new WorkspaceProjectError('unknown_project');
  if (matches.length > 1) throw new WorkspaceProjectError('ambiguous_project');
  const project = matches[0];
  const root = registry.roots.find((source) => source.name === project.root);
  if (!root) throw new WorkspaceProjectError('invalid_registry');
  const sourceRoot = await readDirectory(root.path);
  const projectPath = path.resolve(sourceRoot.directory, project.path);
  if (!contains(sourceRoot.directory, projectPath)) throw new WorkspaceProjectError('outside_project_root');
  const candidate = await readDirectory(projectPath);
  if (!contains(sourceRoot.directory, candidate.directory)) throw new WorkspaceProjectError('outside_project_root');
  await requireAuthorized(authorizedRoot, candidate.directory);
  return candidate;
}

export async function pinWorkspacePath(authorizedRoot: string, directory: string): Promise<WorkspaceProjectBinding> {
  const candidate = await readDirectory(path.resolve(authorizedRoot, directory));
  await requireAuthorized(authorizedRoot, candidate.directory);
  return candidate;
}

export async function validateWorkspaceProject(
  authorizedRoot: string | readonly string[],
  persisted: unknown,
): Promise<WorkspaceProjectBinding> {
  const parsed = workspaceProjectBindingSchema.safeParse(persisted);
  if (!parsed.success) throw new WorkspaceProjectError('invalid_binding');
  const roots = new Set(typeof authorizedRoot === 'string' ? [authorizedRoot] : authorizedRoot);
  if (!roots.size) throw new WorkspaceProjectError('outside_authorized_root');
  for (const root of roots) {
    await requireAuthorized(root, parsed.data.directory);
  }
  const current = await readDirectory(parsed.data.directory);
  if (!sameWorkspaceProject(current, parsed.data)) throw new WorkspaceProjectError('directory_changed');
  return parsed.data;
}

async function readRegistry(registryPath: string): Promise<Registry | undefined> {
  let value: string;
  try {
    value = await fs.readFile(registryPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new WorkspaceProjectError('invalid_registry');
  }
  try {
    const registry = registrySchema.parse(JSON.parse(value));
    const rootNames = new Set(registry.roots.map((root) => root.name));
    if (rootNames.size !== registry.roots.length) throw new WorkspaceProjectError('invalid_registry');
    const aliases = new Set<string>();
    for (const project of registry.projects) {
      const alias = `${project.root}/${project.name}`;
      if (!rootNames.has(project.root) || aliases.has(alias)) {
        throw new WorkspaceProjectError('invalid_registry');
      }
      aliases.add(alias);
    }
    return registry;
  } catch {
    throw new WorkspaceProjectError('invalid_registry');
  }
}

async function readDirectory(candidate: string): Promise<WorkspaceProjectBinding> {
  try {
    const directory = await fs.realpath(candidate);
    const info = await fs.stat(directory, { bigint: true });
    if (info.isDirectory()) return { directory, device: String(info.dev), inode: String(info.ino) };
  } catch {
    // Keep filesystem paths out of user-facing diagnostics.
  }
  throw new WorkspaceProjectError('unavailable_directory');
}

async function requireAuthorized(authorizedRoot: string, candidate: string): Promise<void> {
  const root = await readDirectory(authorizedRoot);
  if (!contains(root.directory, candidate)) throw new WorkspaceProjectError('outside_authorized_root');
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
