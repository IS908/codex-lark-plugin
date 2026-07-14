import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'node:path';
import os from 'node:os';
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
  acquireSingleInstanceLock,
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

const LOCK_FILE = path.join(os.tmpdir(), `codex-lark-${appConfig.appId}.lock`);

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
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

  // 4. Create conversation buffer + wire flush handler
  const buffer = new ConversationBuffer();
  let codexExecActionDispatcher: CodexExecActionDispatcher | null = null;
  registerConversationFlushHandler({
    buffer,
    identitySession,
    profileDistiller,
    chatVisibility: channel,
    getActionDispatcher: () => codexExecActionDispatcher,
  });
  channel.setConversationBuffer(buffer);
  codexExecActionDispatcher = createCodexExecActionDispatcher({
    memoryStore,
    identitySession,
    profileDistiller,
    sendReply: createReplySender({
      client: () => channel.getClient(),
      transport: () => channel.getLarkTransport(),
      conversationBuffer: buffer,
      ackReactions: channel.getAckReactions(),
      botMessageTracker: channel.getBotMessageTracker(),
      latestMessageTracker: channel.getLatestMessageTracker(),
      turnObligations,
    }),
    larkTransport: () => channel.getLarkTransport(),
    botMessageTracker: channel.getBotMessageTracker(),
    turnObligations,
    validateChatAccess: (chatId) => validateFeishuChatAccess(channel.getClient(), chatId),
  });

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
  });

  if (isDryRun) {
    console.error('[dry-run] Channel runtime: sdk');
    validateSdkChannelScaffold();
    console.error('[dry-run] All modules loaded successfully.');
    console.error('[dry-run] Tools registered. Exiting.');
    process.exit(0);
  }

  // 7. Connect MCP server via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[index] MCP server connected via stdio');

  // 8. Acquire single-instance lock and start Lark WebSocket
  const lock = await acquireSingleInstanceLock(LOCK_FILE);
  registerLockCleanup(lock);

  runStartupResourceCleanup(memoryStore);
  startCodexSessionRetention();
  startCodexExecProgressRetention(appConfig.codexExecCwd);
  startCodexExecActionChannelRetention(appConfig.codexExecCwd);

  const startChannelServices = createChannelServicesStarter({
    channel,
    buffer,
    identitySession,
    sessionStore: codexSessionStore,
    sessionHealth: sessionHealthMonitor,
    turnObligations,
    actionDispatcher: codexExecActionDispatcher,
  });

  startSdkChannelRuntimeWithRetry(channel, {
    onConnected: startChannelServices,
    onStopped: (err) => logSafeError('[index] Lark channel services stopped:', err),
  });

  console.error('[index] codex-lark-plugin MCP server started; Lark runtime connecting');
}

main().catch((err) => {
  logSafeError('[index] Fatal error:', err);
  process.exit(1);
});
