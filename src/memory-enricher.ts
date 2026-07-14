import { appConfig } from './config.js';
import type { LarkMessage } from './lark-message.js';
import type { ConversationBuffer } from './memory/buffer.js';
import type { MemoryStore } from './memory/file.js';
import {
  createMemoryDedupScopeKey,
  type MemoryContextBlock,
  type MemoryContextDeduper,
} from './memory-context-dedup.js';
import { enrichmentPrompt } from './prompts.js';
import { buildRecentThreadContext } from './recent-thread-context.js';
import {
  filterBufferedMessagesAfterBoundary,
  filterParentContentAfterBoundary,
  formatConversationHandoffBlock,
  type ConversationBoundary,
} from './conversation-boundary.js';

export interface MemoryEnrichmentDeps {
  memoryStore: MemoryStore | null;
  conversationBuffer: ConversationBuffer | null;
  memoryDeduper: MemoryContextDeduper;
  conversationBoundary?: ConversationBoundary | null;
  log?: (line: string) => void;
}

export async function enrichLarkMessageWithMemory(
  msg: LarkMessage,
  deps: MemoryEnrichmentDeps,
): Promise<string> {
  const boundary = deps.conversationBoundary ?? null;
  const bufferedMessages = deps.conversationBuffer
    ? filterBufferedMessagesAfterBoundary(deps.conversationBuffer.getMessages(msg.chatId), boundary)
    : [];
  const parentContent = filterParentContentAfterBoundary(msg.parentContent, boundary);
  const recentThreadContext = deps.conversationBuffer
    ? buildRecentThreadContext({
        chatId: msg.chatId,
        threadId: msg.threadId,
        currentMessageId: msg.messageId,
        messages: bufferedMessages,
        quotedContent: parentContent,
      })
    : undefined;

  if (!deps.memoryStore) {
    return enrichmentPrompt(
      formatConversationHandoffBlock(boundary) ?? '',
      parentContent,
      msg.senderId,
      msg.chatId,
      msg.text,
      recentThreadContext,
    );
  }

  deps.memoryDeduper.setWindowMs(appConfig.memoryDedupWindowMs);
  const blocks: MemoryContextBlock[] = [];
  const handoffBlock = formatConversationHandoffBlock(boundary);

  let searchQuery = msg.text;
  if (msg.text.length < 15 && deps.conversationBuffer) {
    const recent = bufferedMessages.slice(-3);
    const context = recent.map(m => m.text).join(' ');
    if (context.length > 0) {
      searchQuery = `${context} ${msg.text}`;
    }
  }

  const profile = await deps.memoryStore
    .getProfile(msg.senderId, msg.senderId)
    .catch(() => null);
  if (profile) {
    blocks.push({
      key: `profile:${msg.senderId}`,
      kind: 'profile',
      label: '[User Profile]',
      content: profile,
    });
  }

  if (msg.mentions?.length) {
    for (const mention of msg.mentions) {
      if (mention.id && mention.id !== msg.senderId) {
        const mentionProfile = await deps.memoryStore
          .getProfile(mention.id, msg.senderId)
          .catch(() => null);
        if (mentionProfile) {
          blocks.push({
            key: `mentioned_profile:${mention.id}`,
            kind: 'mentioned_profile',
            label: `[Mentioned User: ${mention.name}]`,
            content: mentionProfile,
          });
        }
      }
    }
  }

  if (msg.threadId) {
    const threadEps = await deps.memoryStore
      .searchEpisodes(searchQuery, { chatId: msg.chatId, threadId: msg.threadId })
      .catch(() => []);
    const filtered = threadEps.filter(ep => ep.score === undefined || ep.score >= appConfig.minSearchScore);
    for (const [index, ep] of filtered.entries()) {
      const scoreTag = ep.score !== undefined ? ` · score:${ep.score.toFixed(2)}` : '';
      const dateTag = ep.timestamp.slice(0, 10);
      blocks.push({
        key: `thread_episode:${ep.id ?? `${ep.timestamp}:${index}`}`,
        kind: 'thread_episode',
        label: `[Thread Context${scoreTag} · ${dateTag}]`,
        content: ep.content,
      });
    }
  }

  const chatEps = await deps.memoryStore
    .searchEpisodes(searchQuery, { chatId: msg.chatId })
    .catch(() => []);
  const filteredChat = chatEps.filter(ep => ep.score === undefined || ep.score >= appConfig.minSearchScore);
  for (const [index, ep] of filteredChat.entries()) {
    const scoreTag = ep.score !== undefined ? ` · score:${ep.score.toFixed(2)}` : '';
    const dateTag = ep.timestamp.slice(0, 10);
    blocks.push({
      key: `chat_episode:${ep.id ?? `${ep.timestamp}:${index}`}`,
      kind: 'chat_episode',
      label: `[Chat Context${scoreTag} · ${dateTag}]`,
      content: ep.content,
    });
  }

  const skills = await deps.memoryStore.searchSkills(searchQuery).catch(() => []);
  const filteredSkills = skills.filter(s => s.score === undefined || s.score >= appConfig.minSearchScore);
  for (const skill of filteredSkills) {
    const scoreTag = skill.score !== undefined ? ` · score:${skill.score.toFixed(2)}` : '';
    const skillPath = `${appConfig.memoriesDir}/skills/${skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.md`;
    blocks.push({
      key: `skill:${skill.name.toLowerCase()}`,
      kind: 'skill',
      label: `[Skill: ${skill.name}${scoreTag}]`,
      content: `${skill.description}\n→ ${skillPath}`,
    });
  }

  const scopeKey = createMemoryDedupScopeKey(msg.chatId, msg.threadId);
  const deduped = deps.memoryDeduper.filter(scopeKey, blocks);
  const memoryContext = [handoffBlock, deduped.memoryContext].filter(Boolean).join('\n\n');
  if (blocks.length > 0) {
    deps.log?.(
      `[memory-dedup] scope=${scopeKey} injected=${deduped.injectedCount} suppressed=${deduped.suppressedCount} bytes_saved=${deduped.bytesSaved}`
    );
  }
  return enrichmentPrompt(
    memoryContext,
    parentContent,
    msg.senderId,
    msg.chatId,
    msg.text,
    recentThreadContext,
  );
}
