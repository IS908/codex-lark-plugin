import assert from 'node:assert/strict';
import type {
  DurableRunDeliveryClaim,
  DurableRunDeliveryResult,
} from '../src/domain/durable-run.js';
import type { JobFile } from '../src/job-contracts.js';
import type { LarkTransportSendRequest } from '../src/lark-transport-contracts.js';
import { AckReactionTracker } from '../src/ack-reactions.js';
import { sendFeishuReply } from '../src/reply-sender.js';
import { createCronDelivery } from '../src/cron/delivery.js';
import {
  autoPauseCronJobForDeliveryFailure,
  projectCronDeliveryResult,
} from '../src/cron/runtime-projection.js';

const NOW = '2026-07-19T03:00:00.000Z';

function claim(
  suffix: string,
  payload: Record<string, unknown>,
  overrides: Partial<DurableRunDeliveryClaim> = {},
): DurableRunDeliveryClaim {
  const normalizedPayload = payload.kind === 'message'
    ? { runStatus: 'success', failureReason: null, ...payload }
    : payload;
  return {
    outboxId: `outbox_${suffix}`,
    runId: `cron_run_${suffix}`,
    workloadKind: payload.kind === 'message' ? 'cron_message' : 'cron_prompt',
    eventKey: `event_${suffix}`,
    kind: 'cron_terminal',
    attemptId: `attempt_${suffix}`,
    workerId: 'durable-run-worker-delivery',
    route: {
      kind: 'cron_job',
      targetChatId: 'oc_target',
      originChatId: 'oc_origin',
      jobId: 'daily-report',
      createdAt: '2026-07-19T00:00:00.000Z',
      revision: 3,
    },
    idempotencyKey: `cron:cron_run_${suffix}:terminal`,
    payload: {
      schemaVersion: 1,
      jobId: 'daily-report',
      jobCreatedAt: '2026-07-19T00:00:00.000Z',
      jobRevision: 3,
      ...normalizedPayload,
    },
    attemptCount: 1,
    leaseExpiresAt: '2026-07-19T03:00:30.000Z',
    ...overrides,
  };
}

function transportHarness(options: {
  error?: unknown;
  messageId?: string;
  projectionRepository?: any;
} = {}) {
  const sends: LarkTransportSendRequest[] = [];
  const tracked: Array<{ id: string; meta: unknown }> = [];
  const buffered: Array<{ chatId: string; message: unknown }> = [];
  const removedReactions: Array<{ messageId: string; reactionId: string }> = [];
  const ackReactions = new AckReactionTracker();
  ackReactions.recordInbound('om_unrelated_inflight_turn');
  ackReactions.storeReaction('om_unrelated_inflight_turn', 'reaction_unrelated');
  const transport = {
    async sendMessage(request: LarkTransportSendRequest) {
      sends.push(request);
      if (options.error) throw options.error;
      return { messageId: options.messageId ?? 'om_cron_delivered' };
    },
    async removeReaction(messageId: string, reactionId: string) {
      removedReactions.push({ messageId, reactionId });
    },
  };
  const delivery = createCronDelivery({
    sendReply: (request) => sendFeishuReply({
      client: {} as any,
      transport: transport as any,
      botMessageTracker: {
        add(id: string, meta: unknown) { tracked.push({ id, meta }); },
      } as any,
      ackReactions,
      conversationBuffer: {
        record(chatId: string, message: unknown) { buffered.push({ chatId, message }); },
      } as any,
      latestMessageTracker: {
        getLatest() { return { messageId: 'om_unrelated_latest_user_message' }; },
      } as any,
    }, request),
    projectionRepository: options.projectionRepository,
    now: () => new Date(NOW),
  });
  return { delivery, sends, tracked, buffered, ackReactions, removedReactions };
}

// Markdown reports use the existing Schema 2.0 card renderer, preserve the
// outbox idempotency key, and update the normal bot/buffer observability paths.
{
  const harness = transportHarness();
  const reportClaim = claim('markdown', {
    kind: 'report',
    report: '# Daily report\n\n| Item | State |\n|---|---|\n| build | green |',
    reportType: 'job_result',
    runStatus: 'success',
    failureReason: null,
    diagnostics: {
      run_id: 'cron_run_markdown',
      job_id: 'daily-report',
      job_name: 'Daily report',
      schedule: '0 9 * * *',
      timezone: 'Asia/Singapore',
      timeout_ms: 60_000,
      started_at: NOW,
      status: 'success',
      stages: [],
    },
  });
  const first = await harness.delivery.deliver(reportClaim);
  const second = await harness.delivery.deliver({ ...reportClaim, attemptCount: 2 });
  assert.deepEqual(first, { status: 'sent', messageId: 'om_cron_delivered' });
  assert.deepEqual(second, { status: 'sent', messageId: 'om_cron_delivered' });
  assert.equal(harness.sends.length, 2);
  assert.equal(harness.sends[0].replyTo, undefined, 'Cron delivery must not reply to recent chat traffic');
  assert.equal(harness.ackReactions.activeCount, 1, 'Cron delivery must not satisfy unrelated turns');
  assert.deepEqual(harness.removedReactions, []);
  assert.ok(harness.sends[0].uuid, 'delivery must derive a Feishu UUID');
  assert.equal(harness.sends[0].uuid, harness.sends[1].uuid, 'outbox retries must reuse the UUID');
  assert.equal('card' in harness.sends[0].input, true, 'Markdown report must use card rendering');
  assert.deepEqual(harness.sends[0].retry, { attempts: 1, retryTimeout: false });
  assert.equal(harness.tracked[0]?.id, 'om_cron_delivered');
  assert.equal((harness.tracked[0]?.meta as any)?.chatId, 'oc_target');
  assert.equal(harness.buffered[0].chatId, 'oc_target');
}

// Fixed message jobs preserve the configured Feishu message type/content and
// still use the same durable outbox idempotency key.
{
  const harness = transportHarness({ messageId: 'om_fixed_message' });
  const messageClaim = claim('message', {
    kind: 'message',
    content: 'scheduled ping',
    messageType: 'text',
  });
  const result = await harness.delivery.deliver(messageClaim);
  assert.deepEqual(result, { status: 'sent', messageId: 'om_fixed_message' });
  assert.ok(harness.sends[0].uuid, 'message delivery must derive a Feishu UUID');
  assert.deepEqual(harness.sends[0].input, {
    raw: { msgType: 'text', content: JSON.stringify({ text: 'scheduled ping' }) },
  });
}

// Workload-generated message failures remain failures in the JSON compatibility
// projection instead of being rewritten as successful fixed messages.
{
  const failedClaim = claim('message-failure', {
    kind: 'message',
    content: 'CronJob failed before the message could be committed.',
    messageType: 'text',
    runStatus: 'failed',
    failureReason: 'The CronJob exhausted its execution attempt budget.',
  });
  const projected = makeJob({
    runtime: { run_id: failedClaim.runId, delivery_status: null },
  });
  const repository = {
    async mutateJob(_id: string, mutate: (job: JobFile) => void | false) {
      return mutate(projected) === false ? null : projected;
    },
  };
  const harness = transportHarness({ projectionRepository: repository });
  assert.deepEqual(
    await harness.delivery.deliver(failedClaim),
    { status: 'sent', messageId: 'om_cron_delivered' },
  );
  assert.equal(projected.runtime.run_status, 'failed');
  assert.equal(
    projected.runtime.last_error,
    'The CronJob exhausted its execution attempt budget.',
  );
}

function transportError(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

// A failure known to happen before sending is retryable. Timeouts and socket
// breakages can happen after Feishu accepts the request, so they are
// terminal-unknown and the worker never blindly sends a duplicate.
{
  const retryHarness = transportHarness({
    error: transportError('DNS unavailable', { code: 'ENOTFOUND' }),
  });
  const retry = await retryHarness.delivery.deliver(claim('retry', {
    kind: 'message', content: 'retry me', messageType: 'text',
  }));
  assert.equal(retry.status, 'retry');
  assert.equal(
    retry.status === 'retry' ? retry.retryAt : undefined,
    '2026-07-19T03:00:30.000Z',
  );

  const unknownHarness = transportHarness({
    error: transportError('socket timed out after write', { code: 'ETIMEDOUT' }),
  });
  const unknown = await unknownHarness.delivery.deliver(claim('unknown', {
    kind: 'message', content: 'do not duplicate', messageType: 'text',
  }));
  assert.equal(unknown.status, 'unknown');

  for (const code of ['ECONNRESET', 'ECONNABORTED', 'EPIPE']) {
    const socketHarness = transportHarness({
      error: transportError(`socket failed with ${code}`, { code }),
    });
    const socketResult = await socketHarness.delivery.deliver(claim(`socket-${code}`, {
      kind: 'message', content: 'do not duplicate', messageType: 'text',
    }));
    assert.equal(socketResult.status, 'unknown', `${code} may occur after Feishu accepts a send`);
    assert.equal(
      socketResult.status === 'unknown' ? socketResult.errorCode : undefined,
      'cron_delivery_outcome_unknown',
    );
  }

  for (const status of [408, 500, 502, 503, 504]) {
    const httpHarness = transportHarness({
      error: transportError(`Feishu returned ${status} after dispatch`, {
        response: { status },
      }),
    });
    const httpResult = await httpHarness.delivery.deliver(claim(`http-${status}`, {
      kind: 'message', content: 'do not duplicate', messageType: 'text',
    }));
    assert.equal(httpResult.status, 'unknown', `${status} may follow an accepted send`);
    assert.equal(
      httpResult.status === 'unknown' ? httpResult.errorCode : undefined,
      'cron_delivery_outcome_unknown',
    );
  }
}

// SQLite outbox state is authoritative after Feishu confirms a send. A failed
// best-effort JSON runtime projection must still return `sent`, so the worker
// commits the outbox instead of retrying and duplicating the message.
{
  let mutationCount = 0;
  const projected = makeJob({
    runtime: { run_id: 'cron_run_projection-failure', delivery_status: null },
  });
  const repository = {
    async mutateJob(_id: string, mutate: (job: JobFile) => void | false) {
      mutationCount += 1;
      if (mutationCount === 2) throw new Error('disk full while projecting delivery result');
      return mutate(projected) === false ? null : projected;
    },
  };
  const harness = transportHarness({ projectionRepository: repository });
  const result = await harness.delivery.deliver(claim('projection-failure', {
    kind: 'message', content: 'send exactly once', messageType: 'text',
  }));
  assert.deepEqual(result, { status: 'sent', messageId: 'om_cron_delivered' });
  assert.equal(harness.sends.length, 1);
  assert.ok(harness.sends[0].uuid, 'confirmed delivery must retain its stable UUID');
}

// A permanent target error cannot auto-pause (and revise) the Job until its
// terminal delivery result has been projected successfully. Reconciliation
// will retry both operations in order.
{
  let mutations = 0;
  const projected = makeJob({
    runtime: { run_id: 'cron_run_projection-before-autopause', delivery_status: null },
  });
  const repository = {
    async mutateJob(_id: string, mutate: (job: JobFile) => void | false) {
      mutations += 1;
      if (mutations === 2) throw new Error('terminal projection unavailable');
      return mutate(projected) === false ? null : projected;
    },
  };
  const harness = transportHarness({
    error: transportError('chat not found', {
      status: 400,
      response: { status: 400, data: { code: 230001, msg: 'chat not found' } },
    }),
    projectionRepository: repository,
  });
  const result = await harness.delivery.deliver(claim('projection-before-autopause', {
    kind: 'message', content: 'cannot deliver', messageType: 'text',
  }));
  assert.equal(result.status, 'failed');
  assert.equal(mutations, 2, 'auto-pause must wait for a successful terminal projection');
}

// Admission repair can race between pending and terminal projection. Even if
// the terminal mutation then applies, auto-pause must wait until reconciliation
// has rebuilt the complete pending -> terminal compatibility projection.
{
  let mutations = 0;
  const projected = makeJob({
    runtime: {
      run_id: 'older_run',
      run_count: 0,
      run_status: null,
      output_status: null,
      delivery_status: null,
      report: null,
      report_type: null,
    },
  });
  const repository = {
    async mutateJob(_id: string, mutate: (job: JobFile) => void | false) {
      mutations += 1;
      const accepted = mutate(projected);
      if (mutations === 1) projected.runtime.run_id = 'cron_run_projection-race';
      if (accepted === false) return null;
      if (projected.meta.status === 'paused') projected.meta.revision += 1;
      return projected;
    },
  };
  const harness = transportHarness({
    error: transportError('chat not found', {
      status: 400,
      response: { status: 400, data: { code: 230001, msg: 'chat not found' } },
    }),
    projectionRepository: repository,
  });
  const result = await harness.delivery.deliver(claim('projection-race', {
    kind: 'message', content: 'cannot deliver', messageType: 'text',
  }));
  assert.equal(result.status, 'failed');
  assert.equal(mutations, 1, 'delivery must leave terminal projection and auto-pause to reconciliation');
  assert.equal(projected.meta.status, 'active');
  assert.equal(projected.runtime.run_count, 0);
  assert.equal(projected.runtime.delivery_status, null);
}

// An expired sending lease is an ambiguous external side effect. Recovery must
// project unknown without invoking Feishu again, even with the same UUID.
{
  const projected = makeJob({ runtime: { run_id: 'cron_run_interrupted-send', delivery_status: 'pending' } });
  const repository = {
    async mutateJob(_id: string, mutate: (job: JobFile) => void | false) {
      return mutate(projected) === false ? null : projected;
    },
  };
  const harness = transportHarness({ projectionRepository: repository });
  const result = await harness.delivery.deliver(claim('interrupted-send', {
    kind: 'message', content: 'must not replay', messageType: 'text',
  }, { recoveredFromExpiredLease: true }));
  assert.equal(result.status, 'unknown');
  assert.equal(harness.sends.length, 0);
  assert.equal(projected.runtime.delivery_status, 'failed');
  assert.match(projected.runtime.delivery_error ?? '', /not replayed/i);
}

// A compatibility projection failure occurs before any external send and is
// safe to retry, but must be delayed so one bad Job cannot hot-loop the queue.
{
  const harness = transportHarness({
    projectionRepository: {
      async mutateJob() { throw new Error('projection storage unavailable'); },
    },
  });
  let sendBoundaryCalls = 0;
  const result = await harness.delivery.deliver(claim('pending-projection-failure', {
    kind: 'message', content: 'not sent yet', messageType: 'text',
  }), {
    async markExternalSendStarted() {
      sendBoundaryCalls += 1;
      return true;
    },
  });
  assert.equal(result.status, 'retry');
  assert.equal(result.status === 'retry' ? result.retryAt : undefined, '2026-07-19T03:00:30.000Z');
  assert.equal(harness.sends.length, 0);
  assert.equal(sendBoundaryCalls, 0);
}

// The durable external-send marker is written only after compatibility
// projection succeeds and immediately before transport dispatch.
{
  const harness = transportHarness();
  let sendBoundaryCalls = 0;
  const result = await harness.delivery.deliver(claim('send-boundary', {
    kind: 'message', content: 'send after durable boundary', messageType: 'text',
  }), {
    async markExternalSendStarted() {
      sendBoundaryCalls += 1;
      assert.equal(harness.sends.length, 0);
      return true;
    },
  });
  assert.equal(result.status, 'sent');
  assert.equal(sendBoundaryCalls, 1);
  assert.equal(harness.sends.length, 1);

  const superseded = await harness.delivery.deliver(claim('send-boundary-stale', {
    kind: 'message', content: 'must not send', messageType: 'text',
  }), {
    async markExternalSendStarted() { return false; },
  });
  assert.deepEqual(superseded, { status: 'superseded' });
  assert.equal(harness.sends.length, 1);
}

// Auto-pause is a JSON compatibility projection. Its failure must not replace
// the authoritative permanent delivery result with a retry.
{
  let mutations = 0;
  const projected = makeJob({
    runtime: { run_id: 'cron_run_auto-pause-failure', delivery_status: null },
  });
  const repository = {
    async mutateJob(_id: string, mutate: (job: JobFile) => void | false) {
      mutations += 1;
      if (mutations === 3) throw new Error('disk unavailable during auto-pause');
      return mutate(projected) === false ? null : projected;
    },
  };
  const harness = transportHarness({
    error: transportError('chat not found', {
      status: 400,
      response: { status: 400, data: { code: 230001, msg: 'chat not found' } },
    }),
    projectionRepository: repository,
  });
  const result = await harness.delivery.deliver(claim('auto-pause-failure', {
    kind: 'message', content: 'cannot deliver', messageType: 'text',
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.status === 'failed' ? result.errorCode : undefined, 'cron_delivery_target_permanent');
  assert.equal(mutations, 3);
}

// Permanent target failures are failed (not retried) and runtime projection
// auto-pauses only the exact id/created_at/revision/latest-run instance.
{
  const permanentClaim = claim('permanent', {
    kind: 'message', content: 'cannot deliver', messageType: 'text',
  });
  const exact = makeJob();
  const replacement = makeJob({
    meta: { created_at: '2026-07-19T01:00:00.000Z', revision: 1, status: 'active' },
    runtime: { run_id: 'replacement_run', delivery_status: 'pending' },
  });
  const jobs = new Map<string, JobFile>([['daily-report', exact]]);
  const repository = {
    async mutateJob(id: string, mutate: (job: JobFile) => void | false) {
      const job = jobs.get(id);
      if (!job) return null;
      const revision = job.meta.revision;
      const status = job.meta.status;
      const accepted = mutate(job);
      if (accepted === false) return null;
      if (job.meta.status !== status) job.meta.revision = revision + 1;
      return job;
    },
  };
  const permanentHarness = transportHarness({
    error: transportError('chat not found', {
      status: 400,
      response: { status: 400, data: { code: 230001, msg: 'chat not found' } },
    }),
    projectionRepository: repository,
  });
  const permanent = await permanentHarness.delivery.deliver(permanentClaim);
  assert.equal(permanent.status, 'failed');
  assert.equal(exact.meta.status, 'paused');
  assert.equal(exact.meta.revision, 4);
  assert.equal(exact.runtime.delivery_status, 'failed');

  jobs.set('daily-report', replacement);
  assert.equal(await autoPauseCronJobForDeliveryFailure(
    permanentClaim.route as any,
    'stale permanent failure',
    repository,
    permanentClaim.runId,
  ), false);
  assert.equal(replacement.meta.status, 'active');
  assert.equal(replacement.runtime.run_id, 'replacement_run');
}

// Route and payload are two independently persisted envelopes. Refuse delivery
// before sending when they do not identify the same Job definition.
{
  const harness = transportHarness();
  const mismatched = claim('mismatched-envelope', {
    kind: 'message', content: 'must not send', messageType: 'text', jobRevision: 4,
  });
  const result = await harness.delivery.deliver(mismatched);
  assert.equal(result.status, 'failed');
  assert.equal(
    result.status === 'failed' ? result.errorCode : undefined,
    'cron_delivery_envelope_invalid',
  );
  assert.equal(harness.sends.length, 0);
}

// Even the same Job instance must reject an old Run projection after a newer
// Run became authoritative.
{
  const stale = makeJob({ runtime: { run_id: 'cron_run_newer', delivery_status: 'pending' } });
  const repository = {
    async mutateJob(_id: string, mutate: (job: JobFile) => void | false) {
      return mutate(stale) === false ? null : stale;
    },
  };
  const sent: DurableRunDeliveryResult = { status: 'sent', messageId: 'om_stale' };
  const older = claim('older', {
    kind: 'message', content: 'old', messageType: 'text',
  });
  assert.equal(await projectCronDeliveryResult(
    older,
    older.route as any,
    older.payload as any,
    sent,
    repository,
  ), false);
  assert.equal(stale.runtime.delivery_status, 'pending');
}

function makeJob(
  overrides: { meta?: Partial<JobFile['meta']>; runtime?: Partial<JobFile['runtime']> } = {},
): JobFile {
  return {
    meta: {
      id: 'daily-report',
      revision: 3,
      name: 'Daily report',
      type: 'message',
      schedule: '0 9 * * *',
      schedule_human: 'daily at 09:00',
      target_chat_id: 'oc_target',
      origin_chat_id: 'oc_origin',
      status: 'active',
      created_by: 'ou_owner',
      created_at: '2026-07-19T00:00:00.000Z',
      ...overrides.meta,
    },
    runtime: {
      last_run_at: NOW,
      next_run_at: '2026-07-20T01:00:00.000Z',
      run_count: 1,
      last_error: null,
      run_id: 'cron_run_permanent',
      run_status: 'success',
      output_status: 'generated',
      delivery_status: 'pending',
      report: 'cannot deliver',
      report_type: 'job_result',
      delivery_error: null,
      ...overrides.runtime,
    },
  };
}

console.log('cron delivery smoke: PASS');
