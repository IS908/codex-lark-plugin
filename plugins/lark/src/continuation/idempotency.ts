import { createHash } from 'node:crypto';

export function continuationJobId(idempotencyKey: string): string {
  if (!idempotencyKey) throw new Error('Continuation idempotency key is required.');
  return `job_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 24)}`;
}

export function continuationCreateIdempotencyKey(sourceMessageId: string): string {
  if (!sourceMessageId) throw new Error('Continuation source message id is required.');
  return `create-continuation:${createHash('sha256')
    .update(`${sourceMessageId}\0create_continuation_job`)
    .digest('hex')}`;
}

export function continuationRetryIdempotencyKey(sourceJobId: string, requestId: string): string {
  if (!sourceJobId || !requestId) {
    throw new Error('Continuation retry source Job id and request id are required.');
  }
  return `manual-retry:${sourceJobId}:${requestId}`;
}

export function continuationRetryJobId(sourceJobId: string, requestId: string): string {
  return continuationJobId(continuationRetryIdempotencyKey(sourceJobId, requestId));
}
