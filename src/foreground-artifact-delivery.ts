import path from 'node:path';
import { isFeishuOpenMessageId } from './codex-exec-error.js';
import { MANAGED_DELIVERY_MAX_BYTES, type ForegroundArtifactBatch, type ManagedRunAllocation } from './domain/managed-workspace.js';
import { buildCodexExecSessionKey } from './codex-session-store.js';
import { managedForegroundRunOwner } from './managed-workspace-admission.js';
import { readManagedArtifact } from './managed-workspace-artifact.js';
import { ManagedWorkspaceStorageError } from './managed-workspace-errors.js';
import type { ManagedWorkspaceStore } from './ports/managed-workspace.js';
import type { ReplyRequest, ReplySendResult } from './reply-sender.js';

export interface ForegroundArtifactDeliveryOptions {
  sendReply: (request: ReplyRequest) => Promise<ReplySendResult>;
  upload: (content: Buffer, fileName: string) => Promise<string | undefined>;
  abortSignal?: AbortSignal;
  allowsRoute?: (actorId: string, chatId: string) => boolean;
}

export async function deliverForegroundArtifacts(
  store: ManagedWorkspaceStore, allocation: ManagedRunAllocation, batch: ForegroundArtifactBatch,
  authorizedRoot: string, options: ForegroundArtifactDeliveryOptions,
): Promise<boolean> {
  const sessionKey = buildCodexExecSessionKey(batch.chatId, batch.threadId);
  const owner = managedForegroundRunOwner({ messageId: batch.sourceMessageId, senderId: batch.actorId,
    messageType: batch.messageType }, sessionKey);
  if (allocation.owner.kind !== 'foreground' || allocation.foregroundSessionKey !== sessionKey
    || batch.sessionKey !== sessionKey || allocation.owner.runId !== owner.runId) {
    throw new ManagedWorkspaceStorageError('invalid_binding');
  }
  const { runId } = allocation.owner;
  const maySend = () => !options.abortSignal?.aborted && options.allowsRoute?.(batch.actorId, batch.chatId) !== false;
  const route = { chat_id: batch.chatId, reply_to: batch.sourceMessageId, thread_id: batch.threadId, routing: 'standalone' } as const;
  if (batch.reply.status === 'pending') {
    if (!maySend()) return false;
    await store.openDirectory(allocation.owner, 'artifacts', [authorizedRoot]);
    if (!maySend() || !store.transitionForegroundArtifact(runId, 'reply', 'pending', 'sending')) return false;
    let receipt: string | undefined;
    try {
      receipt = confirmedReceipt(await options.sendReply({
        ...route, routing: 'auto', text: batch.reply.text, runtimeFooter: batch.reply.runtimeFooter,
        idempotencyKey: `foreground:${runId}:reply`, retry: { attempts: 1, retryTimeout: false },
      }));
    } catch {
      // A send that may have reached Lark cannot be replayed safely.
    }
    if (!store.transitionForegroundArtifact(runId, 'reply', 'sending', receipt ? 'sent' : 'unknown', receipt) || !receipt) return false;
  } else if (batch.reply.status !== 'sent') {
    return false;
  }
  for (const [index, { status, reference }] of batch.files.entries()) {
    if (!maySend()) return true;
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
    if (!maySend()) return true;
    let fileKey: string | undefined;
    try {
      fileKey = await options.upload(bytes, path.posix.basename(reference.relativePath));
    } catch {
      // Upload does not send an IM reply; keep the file eligible for recovery.
    }
    if (!fileKey) continue;
    if (!maySend()) return true;
    if (!store.transitionForegroundArtifact(runId, index, 'pending', 'sending')) continue;

    let receipt: string | undefined;
    try {
      receipt = confirmedReceipt(await options.sendReply({
        ...route, text: '', idempotencyKey: `foreground:${runId}:artifact:${index}`,
        retry: { attempts: 1, retryTimeout: false },
        rawMessage: { msgType: 'file', content: JSON.stringify({ file_key: fileKey }) },
      }));
    } catch {
      // Keep the immutable reference and receipt uncertainty for operator review.
    }
    store.transitionForegroundArtifact(runId, index, 'sending', receipt ? 'sent' : 'unknown', receipt);
  }
  return true;
}

function confirmedReceipt(response: ReplySendResult): string | undefined {
  return !response.isError && response.sentCount > 0 ? response.messageIds?.find(isFeishuOpenMessageId) : undefined;
}

export async function drainForegroundArtifacts(
  store: ManagedWorkspaceStore, authorizedRoot: string, options: ForegroundArtifactDeliveryOptions,
  onError: (error: unknown) => void,
): Promise<void> {
  let after = '';
  while (!options.abortSignal?.aborted) {
    const ids = store.listPendingForegroundRuns(after);
    if (!ids.length) return;
    for (const runId of ids) {
      if (options.abortSignal?.aborted) return;
      after = runId;
      try {
        const run = store.get({ kind: 'foreground', runId });
        const batch = store.getForegroundArtifacts(runId);
        if (run && batch) await deliverForegroundArtifacts(store, run.allocation, batch, authorizedRoot, options);
      } catch (error) {
        onError(error);
      }
    }
  }
}
