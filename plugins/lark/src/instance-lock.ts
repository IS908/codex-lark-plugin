import os from 'node:os';
import path from 'node:path';

// Continuation state is shared across configured Lark app identities, so the
// process lock must cover the whole plugin runtime rather than one app id.
export const LARK_INSTANCE_LOCK_PATH = path.join(os.tmpdir(), 'codex-lark-plugin.lock');
