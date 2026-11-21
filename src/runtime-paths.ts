import os from 'node:os';
import path from 'node:path';

export const channelHome = path.join(os.homedir(), '.codex', 'channels', 'lark');
export const runtimeConfigDir = path.join(channelHome, 'runtime-config');
export const managedWorkspaceConfigPath = path.join(runtimeConfigDir, 'managed-workspace.json');
