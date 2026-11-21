import { spawn, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ManagedRunOwner } from './domain/managed-workspace.js';
import type { WorkspaceCleanupClaim } from './durable-run/workspace-cleanup-claims.js';
import { sameWorkspaceProject, type WorkspaceProjectBinding } from './domain/workspace.js';
import { assertDenyOnlyWorkspaceAcls, assertProtectedWorkspacePath } from './managed-workspace-ancestry.js';
import { managedRunDirectoryPath } from './managed-workspace-storage.js';
import { hasLocalWorkspaceCleanupStorage, type WorkspaceCleanupTree } from './workspace-cleanup-evidence.js';
import { supportsScratch } from './workspace-cleanup-preview.js';
import { readWorkspaceDependencyMountPolicy } from './workspace-dependency-mounts.js';
import { workspacePathContains } from './workspace-projects.js';
import type { WorkspaceGitCleanupProof } from './workspace-git-snapshot.js';

type ClaimIdentity = { owner: ManagedRunOwner; scratch: WorkspaceProjectBinding; nonce: string }
  & Partial<Pick<WorkspaceCleanupClaim, 'state' | 'baseline' | 'lastUsedAt'>>;
type Location = 'source' | 'quarantine' | 'missing' | 'ambiguous';
type AuthorizeMutation = (helperPid: number) => boolean;
const applePythonRoot = '/Library/Developer/CommandLineTools';
const maxInput = 4 * 1024 * 1024;

export function workspaceCleanupQuarantinePath(root: WorkspaceProjectBinding, claim: ClaimIdentity) {
  if (claim.owner.kind === 'foreground' || !/^[0-9a-f]{32}$/.test(claim.nonce)
    || claim.scratch.directory !== managedRunDirectoryPath(root, claim.owner) || claim.scratch.device !== root.device) {
    throw new Error('Invalid workspace cleanup identity.');
  }
  return path.join(root.directory, `.lark-cleanup-${claim.nonce}`);
}

export async function createWorkspaceCleanupFiles(root: WorkspaceProjectBinding, database: WorkspaceProjectBinding) {
  try {
    await assertProtectedWorkspacePath(root, true);
    if (!await hasLocalWorkspaceCleanupStorage([root.directory, database.directory])) return;
    await assertDenyOnlyWorkspaceAcls([database.directory]);
    const python = await resolveCleanupInterpreter();
    if (!python) return;
    const sidecars = ledgerSidecars(database);
    const invoke = (request: object) => {
      const input = JSON.stringify({ ...request, root, database, parentPid: process.pid });
      if (Buffer.byteLength(input) > maxInput) return;
      const child = spawnSync(python, ['-I', '-S', '-B', '-c', cleanupProgram], {
        input, encoding: 'utf8', maxBuffer: 4096, timeout: 10_000, killSignal: 'SIGKILL', env: { LC_ALL: 'C' },
      });
      if (child.status === 0 && !child.stderr) return child.stdout;
    };
    const native = async (operation: 'move' | 'purge' | 'flush', claim: ClaimIdentity, authorize: AuthorizeMutation,
      tree?: WorkspaceCleanupTree, expected?: 'quarantine' | 'missing', backing?: WorkspaceGitCleanupProof) => {
      const quarantine = workspaceCleanupQuarantinePath(root, claim);
      const binding = operation === 'purge' ? { ...claim.scratch, directory: quarantine } : claim.scratch;
      if (operation !== 'flush' && (!tree || !sameWorkspaceProject(tree.binding, binding))) return false;
      if (!sidecars || JSON.stringify(ledgerSidecars(database)) !== JSON.stringify(sidecars)) return false;
      const expectedClaim = claim.state ? [claim.nonce, claim.scratch.directory, claim.scratch.device, claim.scratch.inode,
        claim.baseline, claim.lastUsedAt, claim.state] : undefined;
      const input = JSON.stringify({ operation, root, database, sidecars, parentPid: process.pid, scratch: claim.scratch,
        quarantine: path.basename(quarantine), entries: tree?.entries ?? [], expected, backing,
        expectedClaim, owner: claim.owner });
      if (Buffer.byteLength(input) + 1 > maxInput) return false;
      return await lockedMutation(python, input, (pid) => JSON.stringify(ledgerSidecars(database)) === JSON.stringify(sidecars) && authorize(pid));
    };
    return {
      databasePath: database.directory,
      canStage(owner: ManagedRunOwner, tree: WorkspaceCleanupTree): boolean {
        if (!sidecars || JSON.stringify(ledgerSidecars(database)) !== JSON.stringify(sidecars)
          || tree.binding.directory !== managedRunDirectoryPath(root, owner) || tree.binding.device !== root.device
          || Buffer.byteLength(JSON.stringify(tree.entries)) > maxInput - 8192) return false;
        return invoke({ operation: 'validate', scratch: tree.binding, entries: tree.entries }) === 'verified\n';
      },
      readiness(): 'ready' | 'busy' | 'unavailable' {
        const result = invoke({ operation: 'probe' });
        return result === 'verified\n' ? 'ready' : result === 'busy\n' ? 'busy' : 'unavailable';
      },
      async location(claim: ClaimIdentity): Promise<Location> {
        try {
          const source = claim.scratch.directory;
          const quarantine = workspaceCleanupQuarantinePath(root, claim);
          await assertProtectedWorkspacePath(root, true);
          const mounts = await readWorkspaceDependencyMountPolicy();
          if (![source, quarantine].every((item) => supportsScratch(item, root, mounts))) return 'ambiguous';
          const original = await inspect(source);
          const isolated = await inspect(quarantine);
          if (original === 'match' && isolated === 'absent') return 'source';
          if (original === 'absent' && isolated === 'match') return 'quarantine';
          return original === 'absent' && isolated === 'absent' ? 'missing' : 'ambiguous';

          async function inspect(directory: string) {
            try {
              const info = await fs.lstat(directory, { bigint: true });
              if (!info.isDirectory() || String(info.ino) !== claim.scratch.inode || String(info.dev) !== claim.scratch.device
                || !process.geteuid || info.uid !== BigInt(process.geteuid()) || (info.mode & 0o7022n) !== 0n
                || await fs.realpath(directory) !== directory) return 'other';
              return 'match';
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
              throw error;
            }
          }
        } catch { return 'ambiguous'; }
      },
      move: (claim: ClaimIdentity, tree: WorkspaceCleanupTree, authorize: AuthorizeMutation, backing?: WorkspaceGitCleanupProof) =>
        native('move', claim, authorize, tree, undefined, backing),
      purge: (claim: ClaimIdentity, tree: WorkspaceCleanupTree, authorize: AuthorizeMutation, backing?: WorkspaceGitCleanupProof) =>
        native('purge', claim, authorize, tree, undefined, backing),
      flush: (claim: ClaimIdentity, expected: 'quarantine' | 'missing', authorize: AuthorizeMutation) =>
        native('flush', claim, authorize, undefined, expected),
    };
  } catch { return undefined; }
}

function ledgerSidecars(database: WorkspaceProjectBinding) {
  try {
    return ['-wal', '-shm'].map((suffix) => {
      const directory = database.directory + suffix;
      const info = lstatSync(directory, { bigint: true });
      if (!info.isFile() || !process.geteuid || info.uid !== BigInt(process.geteuid())
        || info.nlink !== 1n || (info.mode & 0o022n) !== 0n || String(info.dev) !== database.device) {
        throw new Error('Untrusted SQLite sidecar.');
      }
      return { directory, device: String(info.dev), inode: String(info.ino) };
    });
  } catch { return undefined; }
}

function lockedMutation(python: string, input: string, authorize: AuthorizeMutation): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(python, ['-I', '-S', '-B', '-c', cleanupProgram], { env: { LC_ALL: 'C' } });
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(stop, 10_000);
    let output = '';
    let approved = false;
    let answered = false;
    let stderr = false;
    child.stdin.on('error', () => {});
    child.stderr.on('data', () => { stderr = true; stop(); });
    child.stdout.setEncoding('utf8').on('data', (part: string) => {
      output += part;
      if (output.length > 128) { stop(); return; }
      if (answered || output !== 'locked\n') return;
      answered = true;
      try { approved = child.pid !== undefined && authorize(child.pid) === true; } catch { approved = false; }
      child.stdin.end(approved ? 'GO\n' : 'STOP\n');
    });
    child.on('error', () => { approved = false; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && approved && !stderr && output === 'locked\nverified\n');
    });
    child.stdin.write(input + '\n');
  });
}

async function resolveCleanupInterpreter() {
  const linux = process.platform === 'linux';
  if (!linux && process.platform !== 'darwin') return;
  const prefix = linux ? '/usr/bin' : applePythonRoot;
  const executable = await fs.realpath(linux ? '/usr/bin/python3' : path.join(applePythonRoot, 'usr/bin/python3'));
  if (!workspacePathContains(prefix, executable)) return;
  const info = await fs.lstat(executable);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o7022) !== 0 || !(info.mode & 0o111)) return;
  const checked = [executable];
  for (let parent = path.dirname(executable); ; parent = path.dirname(parent)) {
    const dir = await fs.lstat(parent);
    if (!dir.isDirectory() || dir.uid !== 0 || (dir.mode & 0o022) !== 0) return;
    checked.push(parent);
    if (parent === '/') break;
  }
  await assertDenyOnlyWorkspaceAcls(checked);
  return executable;
}

// Node does not expose descriptor-relative no-replace rename, unlink, or fullfsync.
// The helper receives only the pinned root, fixed leaf names, and a bounded verified manifest.
const cleanupProgram = String.raw`
import ctypes, errno, fcntl, json, os, re, sqlite3, stat, sys, urllib.parse

if sys.platform == 'darwin':
    system = ctypes.CDLL(None, use_errno=True)
    get_acl = system.acl_get_fd_np
    get_acl.argtypes, get_acl.restype = [ctypes.c_int, ctypes.c_int], ctypes.c_void_p
    free_acl = system.acl_free
    free_acl.argtypes = [ctypes.c_void_p]

def require(condition):
    if not condition:
        raise ValueError()

def parent_alive():
    require(os.getppid() == data['parentPid'])

def before_mutation():
    parent_alive()
    proof = data.get('backing')
    if proof is None:
        return
    root = proof['directory']
    require(os.path.realpath(root) == root and len(proof['entries']) == 8)
    for name, *expected in proof['entries']:
        require(not os.path.isabs(name) and '..' not in name.split('/'))
        info = os.stat(os.path.join(root, name), follow_symlinks=False)
        require(stat.S_ISDIR(info.st_mode) or (stat.S_ISREG(info.st_mode) and info.st_nlink == 1))
        require(expected == [str(n) for n in (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                                               info.st_size, info.st_mtime_ns, info.st_ctime_ns)])

def require_no_acl(fd):
    if sys.platform != 'darwin':
        return
    ctypes.set_errno(0)
    acl = get_acl(fd, 0x100)  # ACL_TYPE_EXTENDED
    if acl:
        free_acl(acl)
        raise ValueError()
    require(ctypes.get_errno() == errno.ENOENT)

def verify_ledger(binding):
    info = os.stat(binding['directory'], follow_symlinks=False)
    require(stat.S_ISREG(info.st_mode) and str(info.st_dev) == binding['device']
            and str(info.st_ino) == binding['inode'] and info.st_uid == os.geteuid()
            and info.st_nlink == 1 and not info.st_mode & 0o022)

def locks_ledger(binding, sidecars=()):
    for item in (binding, *sidecars):
        verify_ledger(item)
    db = sqlite3.connect('file:' + urllib.parse.quote(binding['directory'], safe='/') + '?mode=rw', uri=True, timeout=0)
    require(db.execute('PRAGMA main.journal_mode').fetchone() == ('wal',))
    db.execute('BEGIN IMMEDIATE')
    for item in (binding, *sidecars):
        verify_ledger(item)
    return db

def sync(fd):
    if sys.platform == 'darwin':
        fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
    else:
        os.fsync(fd)

def signature(info):
    return ':'.join(str(n) for n in (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                                     info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns))

def named(parent, leaf):
    try:
        return os.stat(leaf, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return None

def directory_matches(info, binding):
    return (info is not None and stat.S_ISDIR(info.st_mode) and str(info.st_ino) == binding['inode']
            and str(info.st_dev) == binding['device'] and info.st_uid == os.geteuid() and not info.st_mode & 0o7022)

def build(entries):
    require(isinstance(entries, list) and 1 <= len(entries) <= 4096)
    nodes = {}
    for relative, directory, stamp in entries:
        require(isinstance(relative, str) and isinstance(directory, bool) and isinstance(stamp, str))
        parts = relative.split('/') if relative else []
        require(len(parts) <= 32 and all(p and p not in ('.', '..') and not re.search(r'[\\\x00-\x1f\x7f]', p) for p in parts))
        require(relative not in nodes)
        nodes[relative] = (directory, stamp, {})
        if relative:
            parent, _, leaf = relative.rpartition('/')
            require(parent in nodes and nodes[parent][0])
            nodes[parent][2][leaf] = nodes[relative]
    require('' in nodes and nodes[''][0])
    return nodes['']

def check(parent, leaf, node, remove=False):
    directory, stamp, children = node
    info = named(parent, leaf)
    require(info is not None and info.st_dev == device and info.st_uid == os.geteuid() and not getattr(info, 'st_flags', 0)
            and not info.st_mode & 0o7022 and signature(info) == stamp)
    if not directory:
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1)
        if sys.platform == 'darwin':
            filefd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                require(signature(os.fstat(filefd)) == stamp)
                require_no_acl(filefd)
            finally:
                os.close(filefd)
        if remove:
            before_mutation()
            os.unlink(leaf, dir_fd=parent)
        return
    require(stat.S_ISDIR(info.st_mode))
    fd = os.open(leaf, flags, dir_fd=parent)
    try:
        require(signature(os.fstat(fd)) == stamp and set(os.listdir(fd)) == set(children))
        require_no_acl(fd)
        for child, child_node in children.items():
            check(fd, child, child_node, remove)
        if remove:
            require(os.listdir(fd) == [])
            current = named(parent, leaf)
            require(current is not None and stat.S_ISDIR(current.st_mode)
                    and (current.st_dev, current.st_ino, current.st_uid, current.st_gid, current.st_mode)
                    == (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode))
            sync(fd)
            before_mutation()
            os.rmdir(leaf, dir_fd=parent)
    finally:
        os.close(fd)

def rename_exclusive(parent, source, quarantine):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        rename, mode = libc.renameatx_np, 4  # RENAME_EXCL
    else:
        require(sys.platform.startswith('linux'))
        rename, mode = libc.renameat2, 1  # RENAME_NOREPLACE
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    before_mutation()
    require(rename(parent, os.fsencode(source), parent, os.fsencode(quarantine), mode) == 0)

try:
    data = json.loads(sys.stdin.buffer.readline(4 * 1024 * 1024))
    root, op = data['root'], data['operation']
    parent_alive()
    device, flags = int(root['device']), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    rootfd = os.open(root['directory'], flags)
    try:
        require(directory_matches(os.fstat(rootfd), root))
        require_no_acl(rootfd)
        try:
            fcntl.flock(rootfd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            require(error.errno in (errno.EAGAIN, errno.EACCES))
            print('busy')
            sys.exit(0)
        parent_alive()
        if op == 'probe':
            libc = ctypes.CDLL(None)
            require(hasattr(libc, 'renameatx_np' if sys.platform == 'darwin' else 'renameat2'))
            ledger = locks_ledger(data['database'])
            sync(rootfd)
            ledger.rollback()
            ledger.close()
            print('verified')
            sys.exit(0)
        scratch = data['scratch']
        source = os.path.basename(scratch['directory'])
        require(os.path.dirname(scratch['directory']) == root['directory']
                and re.fullmatch(r'(cron_prompt|async_task)-[0-9a-f]{64}', source))
        if op == 'validate':
            require(directory_matches(named(rootfd, source), scratch))
            check(rootfd, source, build(data['entries']))
            print('verified')
            sys.exit(0)
        quarantine = data['quarantine']
        require(re.fullmatch(r'\.lark-cleanup-[0-9a-f]{32}', quarantine))
        sidecars = data['sidecars']
        require([item['directory'] for item in sidecars] == [data['database']['directory'] + suffix for suffix in ('-wal', '-shm')])
        ledger = locks_ledger(data['database'], sidecars)
        expected_claim = data.get('expectedClaim')
        if expected_claim is not None:
            owner = data['owner']
            record = ledger.execute('SELECT nonce, scratch_path, scratch_device, scratch_inode, scratch_baseline, last_used_at, state '
                                    'FROM main.workspace_cleanup_claims WHERE workload_kind = ? AND run_id = ?',
                                    (owner['kind'], owner['runId'])).fetchone()
            require(record is not None and list(record) == expected_claim)
        print('locked', flush=True)
        require(sys.stdin.buffer.readline(16) == b'GO\n')
        parent_alive()
        for item in (data['database'], *sidecars):
            verify_ledger(item)
        if op == 'move':
            require(directory_matches(named(rootfd, source), scratch) and named(rootfd, quarantine) is None)
            check(rootfd, source, build(data['entries']))
            require(directory_matches(named(rootfd, source), scratch))
            rename_exclusive(rootfd, source, quarantine)
            require(named(rootfd, source) is None and directory_matches(named(rootfd, quarantine), scratch))
        elif op == 'purge':
            require(named(rootfd, source) is None and directory_matches(named(rootfd, quarantine), scratch))
            manifest = build(data['entries'])
            check(rootfd, quarantine, manifest)
            check(rootfd, quarantine, manifest, True)
            require(named(rootfd, source) is None and named(rootfd, quarantine) is None)
        elif op == 'flush':
            require(named(rootfd, source) is None)
            current = named(rootfd, quarantine)
            require((data['expected'] == 'missing' and current is None)
                    or (data['expected'] == 'quarantine' and directory_matches(current, scratch)))
        else:
            raise ValueError()
        sync(rootfd)
        ledger.rollback()
        ledger.close()
    finally:
        os.close(rootfd)
    print('verified')
except (OSError, ValueError, KeyError, TypeError, AttributeError, sqlite3.Error):
    sys.exit(1)
`;
