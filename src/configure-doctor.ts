import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import { readConfigValues } from './config-schema.js';
import { assertSupportedNodeVersion } from './runtime-version.js';

export type ConfigureDoctorStatus = 'PASS' | 'WARN' | 'FAIL';

export interface ConfigureDoctorCheck {
  id: string;
  status: ConfigureDoctorStatus;
  detail: string;
  remediation?: string;
}

export interface ConfigureDoctorRemoteSnapshot {
  appName?: string;
  appStatus?: number;
  callbackType?: string;
  grantedScopes: readonly string[];
  subscribedEvents?: readonly string[];
}

export type ConfigureDoctorRemoteProbe = (credentials: {
  appId: string;
  appSecret: string;
}) => Promise<ConfigureDoctorRemoteSnapshot>;

export interface ConfigureDoctorReport {
  configPath: string;
  checks: readonly ConfigureDoctorCheck[];
  exitCode: 0 | 1;
}

interface PermissionRequirement {
  capability: string;
  scopes: readonly string[];
}

const REQUIRED_PERMISSIONS: readonly PermissionRequirement[] = [
  {
    capability: 'receive direct messages',
    scopes: ['im:message.p2p_msg:readonly'],
  },
  {
    capability: 'receive group @bot messages',
    scopes: ['im:message.group_at_msg:readonly'],
  },
  {
    capability: 'send messages as the bot',
    scopes: ['im:message:send_as_bot'],
  },
  {
    capability: 'download message resources',
    scopes: ['im:resource'],
  },
  {
    capability: 'write message reactions',
    scopes: ['im:message.reactions:write_only', 'im:message.reactions:write'],
  },
  {
    capability: 'read document comments',
    scopes: ['docs:document.comment:read'],
  },
  {
    capability: 'create document comments',
    scopes: ['docs:document.comment:create'],
  },
  {
    capability: 'read document metadata',
    scopes: ['drive:drive.metadata:readonly'],
  },
];

const RECOMMENDED_PERMISSIONS: readonly PermissionRequirement[] = [
  {
    capability: 'resolve outbound @mentions from chat members',
    scopes: ['im:chat:readonly'],
  },
  {
    capability: 'receive message reaction events',
    scopes: ['im:message.reactions:read'],
  },
];

const REQUIRED_EVENTS = [
  'im.message.receive_v1',
  'im.message.reaction.created_v1',
  'drive.notice.comment_add_v1',
] as const;

function check(
  id: string,
  status: ConfigureDoctorStatus,
  detail: string,
  remediation?: string,
): ConfigureDoctorCheck {
  return { id, status, detail, ...(remediation ? { remediation } : {}) };
}

function missingPermissions(
  grantedScopes: ReadonlySet<string>,
  requirements: readonly PermissionRequirement[],
): PermissionRequirement[] {
  return requirements.filter(
    (requirement) => !requirement.scopes.some((scope) => grantedScopes.has(scope)),
  );
}

function formatMissingPermissions(requirements: readonly PermissionRequirement[]): string {
  return requirements
    .map((requirement) => `${requirement.capability} (${requirement.scopes.join(' or ')})`)
    .join('; ');
}

function remoteErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, any>;
  const code = record.response?.data?.code ?? record.code;
  if (typeof code === 'string' || typeof code === 'number') return String(code);
  return undefined;
}

function configFailureDetail(error: unknown): string {
  if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
    return 'Configuration file does not exist.';
  }
  if (error instanceof Error) {
    const safeMessage = error.message.replace(
      /(LARK_APP_SECRET\s*[:=]\s*)\S+/gi,
      '$1[REDACTED]',
    );
    return safeMessage;
  }
  return 'Configuration could not be read or validated.';
}

function compactDiagnosticValue(value: string, maximum = 120): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  return compacted.length <= maximum ? compacted : `${compacted.slice(0, maximum - 3)}...`;
}

export async function runConfigureDoctor(options: {
  configPath: string;
  remoteProbe: ConfigureDoctorRemoteProbe;
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  homeDir?: string;
  systemTimezone?: string;
}): Promise<ConfigureDoctorReport> {
  const checks: ConfigureDoctorCheck[] = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  let appId: string | undefined;
  let appSecret: string | undefined;

  try {
    let fileEnv: NodeJS.ProcessEnv = {};
    let configFilePresent = true;
    try {
      fileEnv = parse(await readFile(options.configPath, 'utf8'));
    } catch (error) {
      if (!error || typeof error !== 'object' || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      configFilePresent = false;
    }
    const values = readConfigValues({
      env: { ...fileEnv, ...(options.env ?? process.env) },
      homeDir: options.homeDir,
      systemTimezone: options.systemTimezone,
    });
    appId = values.LARK_APP_ID;
    appSecret = values.LARK_APP_SECRET;
    if (!/^cli_[A-Za-z0-9]+$/.test(appId)) {
      throw new Error('Invalid LARK_APP_ID: expected a Feishu/Lark app ID beginning with cli_.');
    }
    checks.push(
      check(
        'configuration',
        'PASS',
        configFilePresent
          ? `Validated ${options.configPath}.`
          : 'Validated credentials from the process environment; no .env file is present.',
      ),
    );
  } catch (error) {
    checks.push(
      check(
        'configuration',
        'FAIL',
        configFailureDetail(error),
        'Run $lark:configure setup and verify the generated .env file.',
      ),
    );
  }

  try {
    assertSupportedNodeVersion(nodeVersion);
    checks.push(check('runtime', 'PASS', `Node.js ${nodeVersion} satisfies >=24.15.0.`));
  } catch {
    checks.push(
      check(
        'runtime',
        'FAIL',
        `Node.js ${nodeVersion} does not satisfy >=24.15.0.`,
        'Upgrade Node.js before starting the plugin.',
      ),
    );
  }

  if (!appId || !appSecret) {
    return finish(options.configPath, checks);
  }

  let snapshot: ConfigureDoctorRemoteSnapshot;
  try {
    snapshot = await options.remoteProbe({ appId, appSecret });
    checks.push(check('credentials', 'PASS', 'Lark accepted the configured app credentials.'));
  } catch (error) {
    const code = remoteErrorCode(error);
    checks.push(
      check(
        'credentials',
        'FAIL',
        `Lark credential/API probe failed${code ? ` (code ${code})` : ''}.`,
        'Verify LARK_APP_ID, rotate LARK_APP_SECRET if needed, and confirm outbound access to open.feishu.cn.',
      ),
    );
    return finish(options.configPath, checks);
  }

  if (snapshot.appName) {
    checks.push(
      check(
        'app_identity',
        'PASS',
        `Resolved app identity: ${compactDiagnosticValue(snapshot.appName)}.`,
      ),
    );
  } else {
    checks.push(
      check(
        'app_identity',
        'WARN',
        'Credentials work, but the application API did not return an app name.',
        'Confirm the app is available and published in the Feishu Open Platform console.',
      ),
    );
  }

  const grantedScopes = new Set(snapshot.grantedScopes);
  const missingRequired = missingPermissions(grantedScopes, REQUIRED_PERMISSIONS);
  const missingRecommended = missingPermissions(grantedScopes, RECOMMENDED_PERMISSIONS);
  if (missingRequired.length > 0) {
    checks.push(
      check(
        'permissions',
        'FAIL',
        `Missing required capabilities: ${formatMissingPermissions(missingRequired)}.`,
        'Grant the listed tenant permissions and publish the app version.',
      ),
    );
  } else if (missingRecommended.length > 0) {
    checks.push(
      check(
        'permissions',
        'WARN',
        `Required permissions are present; missing recommended capabilities: ${formatMissingPermissions(missingRecommended)}.`,
        'Grant the recommended tenant permissions for the corresponding optional event flows.',
      ),
    );
  } else {
    checks.push(
      check(
        'permissions',
        'PASS',
        `${REQUIRED_PERMISSIONS.length} required and ${RECOMMENDED_PERMISSIONS.length} recommended capabilities are granted.`,
      ),
    );
  }

  if (snapshot.callbackType === 'websocket') {
    checks.push(check('event_transport', 'PASS', 'Application callback mode is WebSocket.'));
  } else {
    checks.push(
      check(
        'event_transport',
        'FAIL',
        `Application callback mode is ${snapshot.callbackType || 'not reported'}, not WebSocket.`,
        'Enable WebSocket mode under Event Subscriptions in the Feishu Open Platform console.',
      ),
    );
  }

  if (snapshot.subscribedEvents === undefined) {
    checks.push(
      check(
        'event_subscriptions',
        'WARN',
        `The read-only application API does not expose message event subscriptions. Manually verify: ${REQUIRED_EVENTS.join(', ')}.`,
        'Open Event Subscriptions in the Feishu Open Platform console and verify the listed events.',
      ),
    );
  } else {
    const subscribed = new Set(snapshot.subscribedEvents);
    const missingEvents = REQUIRED_EVENTS.filter((event) => !subscribed.has(event));
    checks.push(
      missingEvents.length === 0
        ? check('event_subscriptions', 'PASS', `${REQUIRED_EVENTS.length} required events are subscribed.`)
        : check(
            'event_subscriptions',
            'FAIL',
            `Missing event subscriptions: ${missingEvents.join(', ')}.`,
            'Subscribe to the listed events and publish the app version.',
          ),
    );
  }

  return finish(options.configPath, checks);
}

function finish(configPath: string, checks: ConfigureDoctorCheck[]): ConfigureDoctorReport {
  return {
    configPath,
    checks,
    exitCode: checks.some((item) => item.status === 'FAIL') ? 1 : 0,
  };
}

export function formatConfigureDoctorReport(report: ConfigureDoctorReport): string {
  const counts = {
    PASS: report.checks.filter((item) => item.status === 'PASS').length,
    WARN: report.checks.filter((item) => item.status === 'WARN').length,
    FAIL: report.checks.filter((item) => item.status === 'FAIL').length,
  };
  const lines = ['codex-lark-plugin doctor'];
  for (const item of report.checks) {
    lines.push(`${item.status.padEnd(4)}  ${item.id}  ${item.detail}`);
    if (item.remediation) lines.push(`      remediation  ${item.remediation}`);
  }
  lines.push(`Summary: ${counts.PASS} PASS, ${counts.WARN} WARN, ${counts.FAIL} FAIL`);
  return lines.join('\n');
}
