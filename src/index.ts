import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { appConfig } from './config.js';
import { validateFeishuChatAccess } from './access-control-validation.js';
import { LarkChannel } from './channel.js';
import { registerTools } from './tools.js';
import { ConversationBuffer } from './memory/buffer.js';
import { MemoryStore } from './memory/file.js';
import { IdentitySession } from './identity-session.js';
import { mcpServerInstructions } from './prompts.js';
import { FileCodexExecSessionStore } from './codex-session-store.js';
import {
  markConversationHandoffConsumed,
  readConversationBoundary,
} from './conversation-boundary.js';
import { TurnObligationTracker } from './turn-obligation.js';
import { logSafeError } from './safe-log.js';
import { packageName, packageVersion } from './package-metadata.js';
import {
  registerLockCleanup,
} from './resource-governance.js';
import { emitCodexExecConfigDiagnostics } from './codex-exec-config.js';
import { createCodexExecActionDispatcher } from './codex-exec-actions.js';
import type { CodexExecActionDispatcher } from './codex-exec-actions.js';
import { ProfileDistillationManager } from './profile-distillation.js';
import { validateSdkChannelScaffold } from './sdk-channel-scaffold.js';
import { startSdkChannelRuntimeWithRetry } from './sdk-channel-runtime.js';
import { startCodexSessionRetention } from './codex-session-retention.js';
import { startCodexExecProgressRetention } from './codex-exec-progress.js';
import { startCodexExecActionChannelRetention } from './codex-exec-action-channel.js';
import { accessControlStore } from './runtime-access-control.js';
import { runStartupResourceCleanup } from './runtime-bootstrap.js';
import { createConfiguredSessionHealthMonitor } from './session-health-service.js';
import { registerConversationFlushHandler } from './conversation-flush-service.js';
import {
  createReplySender,
  registerCodexDeliveryHandlers,
} from './codex-delivery-wiring.js';
import { createChannelServicesStarter } from './channel-services.js';
import { assertSupportedNodeVersion } from './runtime-version.js';
import { createContinuationRuntime } from './continuation/runtime.js';
import { debugLog } from './debug-log.js';
import type { JobFile } from './job-store.js';
import type { RunJobNowResult } from './scheduler.js';
import { acquireLarkInstanceLock } from './instance-lock.js';
import {
  createDurableRunRuntime,
  type DurableRunRegistration,
  type DurableRunRuntime,
} from './durable-run/runtime.js';
import { CronRunAdmission } from './cron/run-admission.js';
import { CronPromptWorkload } from './cron/direct-exec-workload.js';
import { CronMessageWorkload } from './cron/message-workload.js';
import { createCronPromptExecutor } from './cron/prompt-executor.js';
import { createCronDelivery } from './cron/delivery.js';

let closeContinuationRuntime: (() => Promise<void>) | null = null;
let stopChannelServices: (() => Promise<void>) | null = null;

async function main() {
  assertSupportedNodeVersion();
  const isDryRun = process.argv.includes('--dry-run');
  const lock = isDryRun ? null : await acquireLarkInstanceLock(appConfig.appId);
  if (lock) {
    registerLockCleanup(lock, undefined, async () => {
      await closeContinuationRuntime?.();
    });
  }
  await emitCodexExecConfigDiagnostics(appConfig);
  await accessControlStore.load();
  console.error(`[access-control] Using ${appConfig.accessControlConfigPath}`);

  // 1. Create memory store
  const memoryStore = new MemoryStore();
  console.error(`[memory] Using ${appConfig.memoriesDir}`);

  // 1b. Create identity session (server-side caller tracking for sensitive tools)
  const identitySession = new IdentitySession(
    () => appConfig.ownerOpenId,
    appConfig.identitySessionTtlMs,
    appConfig.identitySessionMaxEntries,
  );
  if (appConfig.ownerOpenId) {
    console.error(`[identity] owner fallback: ${appConfig.ownerOpenId}`);
  } else {
    console.error('[identity] no LARK_OWNER_OPEN_ID set — terminal skill invocations will be denied');
  }

  // 2. Create MCP server
  const server = new McpServer(
    { name: packageName, version: packageVersion },
    {
      capabilities: {
        logging: {},
      },
      instructions: mcpServerInstructions,
    }
  );

  // 3. Create Lark channel
  const channel = new LarkChannel();
  channel.setMemoryStore(memoryStore);
  channel.setIdentitySession(identitySession);
  const codexSessionStore = new FileCodexExecSessionStore(appConfig.codexExecSessionsDir);
  channel.setConversationBoundaryProvider({
    get: (chatId, threadId) => readConversationBoundary(codexSessionStore, chatId, threadId),
    markHandoffConsumed: (chatId, threadId, generation) =>
      markConversationHandoffConsumed(codexSessionStore, chatId, threadId, generation),
  });
  const profileDistiller = new ProfileDistillationManager({
    enabled: appConfig.profileDistillationEnabled,
    memoryStore,
    minEpisodes: appConfig.profileDistillationMinEpisodes,
    maxEpisodes: appConfig.profileDistillationMaxEpisodes,
    cooldownMs: appConfig.profileDistillationCooldownMs,
  });
  if (appConfig.profileDistillationEnabled) {
    console.error(
      `[profile-distill] enabled: minEpisodes=${appConfig.profileDistillationMinEpisodes} ` +
      `maxEpisodes=${appConfig.profileDistillationMaxEpisodes} cooldownMs=${appConfig.profileDistillationCooldownMs}`,
    );
  }
  const turnObligations = new TurnObligationTracker();
  const sessionHealthMonitor = createConfiguredSessionHealthMonitor(channel, turnObligations);

  const continuationRuntime = await createContinuationRuntime({
    enabled: appConfig.continuationEnabled,
    databasePath: appConfig.continuationDbPath,
    artifactsDir: appConfig.continuationArtifactsDir,
    allowedWorkingRoot: appConfig.continuationWorkingRoot,
    maxAttempts: appConfig.continuationMaxAttempts,
    maxRetries: appConfig.continuationMaxRetries,
    maxTotalMinutes: appConfig.continuationMaxTotalMinutes,
    timeoutMs: appConfig.codexExecTimeoutMs,
    retentionDays: appConfig.continuationRetentionDays,
    maxConcurrency: appConfig.continuationMaxConcurrency,
    configuredSandbox: appConfig.codexExecSandbox,
    canUseTrustedPersonalWorkspace: (actorOpenId) =>
      actorOpenId === appConfig.ownerOpenId || accessControlStore.isAllowedUserId(actorOpenId),
    command: appConfig.codexExecCommand,
    localCliToolsConfigPath: appConfig.localCliToolsConfigPath,
    getTransport: () => channel.getLarkTransport(),
    dryRun: isDryRun,
    debug: debugLog,
    reportError: (error) => logSafeError('[continuation] Runtime unavailable:', error),
    standaloneWorker: false,
  });
  closeContinuationRuntime = () => continuationRuntime.close();
  console.error(
    continuationRuntime.health.available
      ? '[continuation] runtime available'
      : `[continuation] runtime unavailable: ${continuationRuntime.health.reason ?? 'unknown'}`,
  );

  // 4. Create conversation buffer + wire flush handler
  const buffer = new ConversationBuffer();
  let codexExecActionDispatcher: CodexExecActionDispatcher | null = null;
  let runJobNow: ((job: JobFile) => Promise<RunJobNowResult>) | null = null;
  registerConversationFlushHandler({
    buffer,
    identitySession,
    profileDistiller,
    chatVisibility: channel,
    getActionDispatcher: () => codexExecActionDispatcher,
  });
  channel.setConversationBuffer(buffer);
  const sendReplyViaFeishu = createReplySender({
    client: () => channel.getClient(),
    transport: () => channel.getLarkTransport(),
    conversationBuffer: buffer,
    ackReactions: channel.getAckReactions(),
    botMessageTracker: channel.getBotMessageTracker(),
    latestMessageTracker: channel.getLatestMessageTracker(),
    turnObligations,
  });
  codexExecActionDispatcher = createCodexExecActionDispatcher({
    memoryStore,
    identitySession,
    profileDistiller,
    sendReply: sendReplyViaFeishu,
    larkTransport: () => channel.getLarkTransport(),
    botMessageTracker: channel.getBotMessageTracker(),
    turnObligations,
    validateChatAccess: (chatId) => validateFeishuChatAccess(channel.getClient(), chatId),
    continuationService: continuationRuntime.service,
    runJobNow: async (job) => {
      if (!runJobNow) throw new Error('Cronjob scheduler is not ready.');
      return runJobNow(job);
    },
  });

  let durableRunRuntime: DurableRunRuntime | null = null;
  let cronAdmission: CronRunAdmission | null = null;
  if (continuationRuntime.durableRepository) {
    const cronDelivery = createCronDelivery({ sendReply: sendReplyViaFeishu });
    const promptExecutor = createCronPromptExecutor({
      identitySession,
      sessionStore: codexSessionStore,
      sessionHealth: sessionHealthMonitor ?? undefined,
      actionDispatcher: codexExecActionDispatcher,
    });
    const registrations: DurableRunRegistration[] = [
      {
        kind: 'cron_prompt',
        repository: continuationRuntime.durableRepository,
        workload: new CronPromptWorkload({ executor: promptExecutor }),
        delivery: cronDelivery,
        maxConcurrency: 1,
      },
      {
        kind: 'cron_message',
        repository: continuationRuntime.durableRepository,
        workload: new CronMessageWorkload(),
        delivery: cronDelivery,
        maxConcurrency: 2,
      },
    ];
    if (appConfig.continuationEnabled && continuationRuntime.asyncTaskAdapter) {
      const asyncTask = continuationRuntime.asyncTaskAdapter;
      registrations.push({
        kind: 'async_task',
        repository: asyncTask,
        workload: asyncTask,
        delivery: asyncTask,
        maxConcurrency: appConfig.continuationMaxConcurrency,
        onExecutionStateError: (claim) => asyncTask.handleWorkerStateError(claim),
      });
    }
    durableRunRuntime = createDurableRunRuntime({
      baseRepository: continuationRuntime.durableRepository,
      registrations,
      clock: { now: () => new Date() },
    });
    cronAdmission = new CronRunAdmission({
      runRepository: continuationRuntime.durableRepository,
    });
    closeContinuationRuntime = async () => {
      await stopChannelServices?.();
      await durableRunRuntime?.stop();
      await continuationRuntime.close();
    };
  }

  // 5. Register MCP tools (pass buffer so reply records assistant messages)
  registerTools(
    server,
    channel.getClient(),
    memoryStore,
    identitySession,
    channel,
    buffer,
    channel.getAckReactions(),
    channel.getBotMessageTracker(),
    channel.getLatestMessageTracker(),
    turnObligations,
    profileDistiller,
    () => channel.getLarkTransport()
  );

  // 6. Register channel delivery handlers
  registerCodexDeliveryHandlers({
    channel,
    buffer,
    identitySession,
    sessionStore: codexSessionStore,
    sessionHealth: sessionHealthMonitor,
    turnObligations,
    actionDispatcher: codexExecActionDispatcher,
    continuationService: continuationRuntime.service,
    continuationAvailable: continuationRuntime.health.available,
  });

  if (isDryRun) {
    console.error('[dry-run] Channel runtime: sdk');
    validateSdkChannelScaffold();
    console.error('[dry-run] All modules loaded successfully.');
    console.error('[dry-run] Tools registered. Exiting.');
    await continuationRuntime.close();
    closeContinuationRuntime = null;
    process.exit(0);
  }

  // 7. Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[index] MCP server connected via stdio');

  // 8. Start Lark WebSocket after the process-wide lock acquired at startup.
  runStartupResourceCleanup(memoryStore);
  startCodexSessionRetention();
  startCodexExecProgressRetention(appConfig.codexExecCwd);
  startCodexExecActionChannelRetention(appConfig.codexExecCwd);

  const startChannelServices = createChannelServicesStarter({
    channel,
    buffer,
    durableRunRuntime,
    cronAdmission,
    onSchedulerReady: (scheduler) => {
      runJobNow = scheduler.runJobNow.bind(scheduler);
    },
  });
  stopChannelServices = startChannelServices.stop;

  startSdkChannelRuntimeWithRetry(channel, {
    onConnected: startChannelServices,
    onStopped: (err) => logSafeError('[index] Lark channel services stopped:', err),
  });

  console.error('[index] codex-lark-plugin MCP server started; Lark runtime connecting');
}

main().catch(async (err) => {
  await closeContinuationRuntime?.().catch(() => undefined);
  logSafeError('[index] Fatal error:', err);
  process.exit(1);
});
