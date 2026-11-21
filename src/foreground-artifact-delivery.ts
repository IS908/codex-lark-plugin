import path from 'node:path';
import { isFeishuOpenMessageId } from './codex-exec-error.js';
import { MANAGED_DELIVERY_MAX_BYTES, type ForegroundArtifactBatch, type ManagedRunAllocation } from './domain/managed-workspace.js';
import type { LarkMessage } from './lark-message.js';
import { readManagedArtifact } from './managed-workspace-artifact.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import type { ManagedWorkspaceStore } from './ports/managed-workspace.js';
import type { ReplyRequest, ReplySendResult } from './reply-sender.js';

export interface ForegroundArtifactDeliveryOptions {
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
  upload: (content: Buffer, fileName: string) => Promise<string | undefined>;
  abortSignal?: AbortSignal;
}

export async function deliverForegroundArtifacts(
  store: ManagedWorkspaceStore, allocation: ManagedRunAllocation, batch: ForegroundArtifactBatch,
  message: LarkMessage, sessionKey: string, authorizedRoot: string, options: ForegroundArtifactDeliveryOptions,
): Promise<void> {
  if (allocation.owner.kind !== 'foreground' || allocation.foregroundSessionKey !== sessionKey
    || batch.sessionKey !== sessionKey || batch.chatId !== message.chatId
    || batch.threadId !== message.threadId || batch.sourceMessageId !== message.messageId) {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
  const { runId } = allocation.owner;
  for (const [index, { status, reference }] of batch.files.entries()) {
    if (options.abortSignal?.aborted) return;
    // A previous process may have crossed the send boundary; do not replay it.
    if (status !== 'pending') continue;
    let bytes: Buffer;
    try {
      ({ content: bytes } = await readManagedArtifact({
        binding: allocation.artifacts, relativePath: reference.relativePath, expectedSha256: reference.sha256,
        maxBytes: MANAGED_DELIVERY_MAX_BYTES,
        revalidate: () => store.openDirectory(allocation.owner, 'artifacts', [authorizedRoot]),
      }));
      if (!bytes.length) throw new ManagedWorkspaceStorageError('artifact_invalid');
    } catch {
      store.transitionForegroundArtifact(runId, index, 'pending', 'failed');
      continue;
    }
    if (options.abortSignal?.aborted) return;
    if (!store.transitionForegroundArtifact(runId, index, 'pending', 'sending')) continue;

    let receipt: string | undefined;
    try {
      const fileKey = await options.upload(bytes, path.posix.basename(reference.relativePath));
      if (fileKey) {
        const response = await options.sendReply({
          chat_id: batch.chatId, reply_to: batch.sourceMessageId, thread_id: batch.threadId,
          text: '', routing: 'standalone', idempotencyKey: `foreground:${runId}:artifact:${index}`,
          retry: { attempts: 1, retryTimeout: false },
          rawMessage: { msgType: 'file', content: JSON.stringify({ file_key: fileKey }) },
        });
        if (!response.isError && response.sentCount > 0) receipt = response.messageIds?.find(isFeishuOpenMessageId);
      }
    } catch {
      // Keep the immutable reference and receipt uncertainty for operator review.
    }
    store.transitionForegroundArtifact(runId, index, 'sending', receipt ? 'sent' : 'unknown', receipt);
  }
}
