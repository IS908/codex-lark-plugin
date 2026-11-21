import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { isFeishuOpenMessageId } from '../codex-exec-error.js';
import type { ContinuationArtifactDelivery, ContinuationDeliveryRoute, ContinuationJob } from '../domain/continuation.js';

const artifactDeliverySchema = z.strictObject({
  version: z.literal(1),
  chatType: z.enum(['p2p', 'group']),
  artifactId: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/),
  path: z.string().min(1).max(2048),
  sha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
});
export type ArtifactReplyRoute = Extract<ContinuationDeliveryRoute, { kind: 'message_thread' }>;
export const IM_ARTIFACT_MAX_BYTES = 30_000_000;
export const IM_ARTIFACT_SIZE_NOTE = 'IM delivery requires a nonempty file no larger than 30 MB.';

export function artifactDeliveryEventKey(messageId: string): string {
  return `artifact:${createHash('sha256').update(messageId).digest('hex').slice(0, 32)}`;
}

export function parseArtifactDelivery(payload: string): ContinuationArtifactDelivery {
  return artifactDeliverySchema.parse(JSON.parse(payload));
}

export function artifactDeliveryMatches(
  job: ContinuationJob, route: ContinuationDeliveryRoute, reference: ContinuationArtifactDelivery,
): route is ArtifactReplyRoute {
  if (job.deletedAt || !job.permissions.filesystem.managedWorkspaceRoots || route.kind !== 'message_thread'
    || !isFeishuOpenMessageId(route.sourceMessageId) || !route.conversationId) return false;
  if (reference.chatType === 'group' && (job.route.kind !== 'message_thread'
    || route.conversationId !== job.route.conversationId || route.threadId !== job.route.threadId)) return false;
  return job.checkpoint?.artifacts.some((artifact) => artifact.id === reference.artifactId
    && artifact.path === reference.path && artifact.sha256 === reference.sha256) ?? false;
}

export function isImArtifactSize(bytes: number): boolean {
  return bytes > 0 && bytes <= IM_ARTIFACT_MAX_BYTES;
}

export function artifactDeliveryFileName(relativePath: string): string {
  return path.posix.basename(relativePath).replace(/[\u0000-\u001f\u007f]/g, '_');
}
