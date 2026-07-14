import type * as Lark from '@larksuiteoapi/node-sdk';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { MemoryStore } from './memory/file.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { ChatVisibilityProvider } from './lark-message.js';
import type { BotMessageTracker, LatestMessageTracker } from './message-trackers.js';
import type { IdentitySession } from './identity-session.js';
import type { AckReactionTracker } from './ack-reactions.js';
import { registerLocalCliTools } from './local-cli-tools.js';
import type { TurnObligationTracker } from './turn-obligation.js';
import type { ProfileDistillationDispatcher } from './profile-distillation.js';
import {
  createToolContext,
  type LarkTransportProvider,
} from './tools/tool-context.js';
import { registerDocCommentTools } from './tools/doc-comments.js';
import { registerReplyTools } from './tools/reply.js';
import { registerMessageMutationTools } from './tools/message-mutation.js';
import { registerMemoryTools } from './tools/memory.js';
import { registerJobTools } from './tools/jobs.js';
import { registerTransparencyTools } from './tools/transparency.js';
import { registerAccessControlTools } from './tools/access-control.js';

export type { DocCommentToolsDeps } from './tools/doc-comments.js';
export { registerDocCommentTools } from './tools/doc-comments.js';
export { capSanitizedFilename, registerReplyTools } from './tools/reply.js';
export { registerMessageMutationTools } from './tools/message-mutation.js';
export { registerMemoryTools } from './tools/memory.js';
export { registerJobTools } from './tools/jobs.js';

/**
 * Register all MCP tools on the server.
 */
export function registerTools(
  server: McpServer,
  client: Lark.Client,
  memoryStore: MemoryStore,
  identitySession: IdentitySession,
  channel: ChatVisibilityProvider,
  conversationBuffer?: ConversationBuffer,
  ackReactions?: AckReactionTracker,
  botMessageTracker?: BotMessageTracker,
  latestMessageTracker?: LatestMessageTracker,
  turnObligations?: TurnObligationTracker,
  profileDistiller?: ProfileDistillationDispatcher,
  larkTransport?: LarkTransportProvider
): void {
  const ctx = createToolContext({
    server,
    client,
    memoryStore,
    identitySession,
    channel,
    conversationBuffer,
    ackReactions,
    botMessageTracker,
    latestMessageTracker,
    turnObligations,
    profileDistiller,
    larkTransport,
  });

  registerDocCommentTools({
    server,
    transport: ctx.transport,
    identitySession,
    conversationBuffer,
  });
  registerLocalCliTools({ server, identitySession });
  registerReplyTools(ctx);
  registerMessageMutationTools(ctx);
  registerMemoryTools(ctx);
  registerJobTools(ctx);
  registerTransparencyTools(ctx);
  registerAccessControlTools(ctx);
}
