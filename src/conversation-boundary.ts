import {
  buildCodexExecSessionKey,
  type CodexExecSessionRecord,
  type CodexExecSessionStore,
} from './codex-session-store.js';
import type { BufferedMessage } from './memory/buffer.js';

const HANDOFF_SUMMARY_MAX_BYTES = 4_000;

export interface ConversationBoundary {
  generation: number;
  cutoffMessageId: string;
  cutoffTimestampMs: number;
  handoffSummary?: string;
  handoffConsumedAt?: string;
  boundaryUpdatedAt?: string;
}

export interface ConversationBoundaryCommitInput {
  existing: CodexExecSessionRecord | null;
  cutoffMessageId: string;
  cutoffTimestampMs?: number;
  handoffSummary?: string;
  now?: Date;
}

interface ContextTimestampSource {
  messageId?: string;
  timestampMs?: number;
  timestamp?: string;
}

export function conversationBoundaryFromSession(
  record: CodexExecSessionRecord | null | undefined,
): ConversationBoundary | null {
  if (!record) return null;
  const hasAnyBoundaryField =
    record.generation !== undefined ||
    record.cutoffMessageId !== undefined ||
    record.cutoffTimestampMs !== undefined;
  if (!hasAnyBoundaryField) return null;

  const generation = record.generation;
  const cutoffTimestampMs = record.cutoffTimestampMs;
  if (
    typeof generation !== 'number' ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    !record.cutoffMessageId ||
    typeof cutoffTimestampMs !== 'number' ||
    !Number.isFinite(cutoffTimestampMs)
  ) {
    throw new Error(`Invalid conversation boundary state for ${record.key}`);
  }

  return {
    generation,
    cutoffMessageId: record.cutoffMessageId,
    cutoffTimestampMs: cutoffTimestampMs!,
    ...(record.handoffSummary ? { handoffSummary: record.handoffSummary } : {}),
    ...(record.handoffConsumedAt ? { handoffConsumedAt: record.handoffConsumedAt } : {}),
    ...(record.boundaryUpdatedAt ? { boundaryUpdatedAt: record.boundaryUpdatedAt } : {}),
  };
}

export function createNextConversationBoundaryFields(
  input: ConversationBoundaryCommitInput,
): Pick<
  CodexExecSessionRecord,
  'generation' | 'cutoffMessageId' | 'cutoffTimestampMs' | 'handoffSummary' | 'boundaryUpdatedAt'
> {
  const now = input.now ?? new Date();
  const currentGeneration = Number.isInteger(input.existing?.generation)
    ? Math.max(0, input.existing!.generation!)
    : 0;
  const handoffSummary = capUtf8Text(input.handoffSummary?.trim() || undefined, HANDOFF_SUMMARY_MAX_BYTES);
  return {
    generation: currentGeneration + 1,
    cutoffMessageId: input.cutoffMessageId,
    cutoffTimestampMs: normalizeTimestampMs(input.cutoffTimestampMs) ?? now.getTime(),
    ...(handoffSummary ? { handoffSummary } : {}),
    boundaryUpdatedAt: now.toISOString(),
  };
}

export function preserveConversationBoundaryFields(
  existing: CodexExecSessionRecord | null | undefined,
): Partial<CodexExecSessionRecord> {
  if (!existing) return {};
  return {
    ...(existing.generation !== undefined ? { generation: existing.generation } : {}),
    ...(existing.cutoffMessageId ? { cutoffMessageId: existing.cutoffMessageId } : {}),
    ...(existing.cutoffTimestampMs !== undefined ? { cutoffTimestampMs: existing.cutoffTimestampMs } : {}),
    ...(existing.handoffSummary ? { handoffSummary: existing.handoffSummary } : {}),
    ...(existing.handoffConsumedAt ? { handoffConsumedAt: existing.handoffConsumedAt } : {}),
    ...(existing.boundaryUpdatedAt ? { boundaryUpdatedAt: existing.boundaryUpdatedAt } : {}),
  };
}

export function filterBufferedMessagesAfterBoundary(
  messages: BufferedMessage[],
  boundary: ConversationBoundary | null | undefined,
): BufferedMessage[] {
  if (!boundary) return messages;
  return messages.filter((message) => isContextAfterBoundary(message, boundary));
}

export function filterParentContentAfterBoundary(
  parentContent: string | undefined,
  boundary: ConversationBoundary | null | undefined,
): string | undefined {
  if (!parentContent || !boundary) return parentContent;

  const filtered = parentContent.split('\n---\n').map((block) => {
    const metadata = parseContextBlockMetadata(block);
    if (isContextAfterBoundary(metadata, boundary)) return block;
    return formatBoundaryOmittedBlock(metadata, boundary);
  });
  return filtered.join('\n---\n');
}

export function formatConversationHandoffBlock(
  boundary: ConversationBoundary | null | undefined,
): string | undefined {
  if (!boundary?.handoffSummary || boundary.handoffConsumedAt) return undefined;
  return [
    `[Conversation Handoff · generation ${boundary.generation}]`,
    `cutoff_message_id: ${boundary.cutoffMessageId}`,
    `cutoff_timestamp_ms: ${boundary.cutoffTimestampMs}`,
    '',
    boundary.handoffSummary,
  ].join('\n');
}

export async function readConversationBoundary(
  store: CodexExecSessionStore,
  chatId: string,
  threadId?: string,
): Promise<ConversationBoundary | null> {
  const key = buildCodexExecSessionKey(chatId, threadId);
  return conversationBoundaryFromSession(await store.get(key));
}

export async function markConversationHandoffConsumed(
  store: CodexExecSessionStore,
  chatId: string,
  threadId: string | undefined,
  generation: number,
): Promise<void> {
  const key = buildCodexExecSessionKey(chatId, threadId);
  const existing = await store.get(key);
  if (!existing || existing.generation !== generation || !existing.handoffSummary || existing.handoffConsumedAt) {
    return;
  }

  await store.set({
    ...existing,
    updatedAt: new Date().toISOString(),
    handoffConsumedAt: new Date().toISOString(),
  });
}

function isContextAfterBoundary(
  source: ContextTimestampSource,
  boundary: ConversationBoundary,
): boolean {
  if (source.messageId && source.messageId === boundary.cutoffMessageId) return false;
  const timestampMs = normalizeTimestampMs(source.timestampMs) ?? normalizeTimestampText(source.timestamp);
  if (timestampMs === undefined) return false;
  return timestampMs > boundary.cutoffTimestampMs;
}

function parseContextBlockMetadata(block: string): ContextTimestampSource {
  return {
    ...(matchLine(block, 'message_id') ? { messageId: matchLine(block, 'message_id') } : {}),
    ...(normalizeTimestampMs(Number(matchLine(block, 'timestamp_ms'))) !== undefined
      ? { timestampMs: normalizeTimestampMs(Number(matchLine(block, 'timestamp_ms'))) }
      : {}),
    ...(matchLine(block, 'timestamp') ? { timestamp: matchLine(block, 'timestamp') } : {}),
  };
}

function formatBoundaryOmittedBlock(
  metadata: ContextTimestampSource,
  boundary: ConversationBoundary,
): string {
  return [
    'kind: lark_message',
    ...(metadata.messageId ? [`message_id: ${metadata.messageId}`] : []),
    'hydration_status: omitted',
    'reason: before_conversation_boundary',
    `generation: ${boundary.generation}`,
    `cutoff_message_id: ${boundary.cutoffMessageId}`,
    `cutoff_timestamp_ms: ${boundary.cutoffTimestampMs}`,
  ].join('\n');
}

function matchLine(block: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`^${escaped}:\\s*(.+?)\\s*$`, 'm'));
  return match?.[1]?.trim() || undefined;
}

function normalizeTimestampMs(value: number | undefined): number | undefined {
  if (!Number.isFinite(value) || value === undefined) return undefined;
  return Math.floor(value);
}

function normalizeTimestampText(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function capUtf8Text(text: string | undefined, maxBytes: number): string | undefined {
  if (!text) return undefined;
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let cut = maxBytes;
  while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  return `${buf.subarray(0, cut).toString('utf8')} ...[truncated]`;
}
