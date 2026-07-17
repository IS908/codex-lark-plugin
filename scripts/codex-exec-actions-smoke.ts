import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_CRON_TIMEZONE = 'Asia/Shanghai';

const { appConfig } = await import('../src/config.js');
const { IdentitySession } = await import('../src/identity-session.js');
const { BotMessageTracker } = await import('../src/message-trackers.js');
const { TurnObligationTracker } = await import('../src/turn-obligation.js');
const { MemoryStore } = await import('../src/memory/file.js');
const { accessControlStore } = await import('../src/runtime-access-control.js');
  const { createInitialJobRuntime } = await import('../src/job-store.js');
  const { ContinuationServiceError } = await import('../src/continuation/service.js');
const {
  createCodexExecActionDispatcher,
  parseCodexExecActionEnvelope,
} = await import('../src/codex-exec-actions.js');

function parseActionEnvelopeForTest(parsed: unknown): any {
  const envelope = parseCodexExecActionEnvelope(parsed);
  if (!envelope.ok) {
    return {
      kind: 'invalid_actions',
      actions: [],
      error: envelope.error,
    };
  }
  return {
    kind: 'actions',
    replyText: envelope.envelope.reply?.trim() || '',
    actions: envelope.envelope.actions,
  };
}

function assertInitialRuntimeShape(job: any): void {
  const expected = createInitialJobRuntime(job.runtime.next_run_at);
  assert.deepEqual(Object.keys(job.runtime).sort(), Object.keys(expected).sort());
  for (const key of Object.keys(expected)) {
    assert.equal(job.runtime[key], (expected as any)[key], `runtime.${key}`);
  }
}

const root = mkdtempSync(join(tmpdir(), 'codex-exec-actions-'));
const oldJobsDir = (appConfig as any).jobsDir;
const oldInboxDir = (appConfig as any).inboxDir;
const oldOwnerOpenId = appConfig.ownerOpenId;
const oldTraceEnabled = appConfig.codexExecToolTraceEnabled;
const oldTraceLogPath = appConfig.codexExecTraceLogPath;
const oldAccessSnapshot = accessControlStore.snapshot();
try {
  const jobsDir = join(root, 'jobs');
  const memoriesDir = join(root, 'memories');
  const inboxDir = join(root, 'inbox');
  const traceLogPath = join(root, 'trace.log');
  const localCliConfigPath = join(root, 'local-cli-tools.json');
  (appConfig as any).jobsDir = jobsDir;
  (appConfig as any).inboxDir = inboxDir;
  (appConfig as any).ownerOpenId = 'ou_user';
  (appConfig as any).codexExecToolTraceEnabled = true;
  (appConfig as any).codexExecTraceLogPath = traceLogPath;
  await accessControlStore.load(join(root, 'access-control.json'));
  await mkdir(jobsDir, { recursive: true });
  await mkdir(inboxDir, { recursive: true });
  writeFileSync(
    localCliConfigPath,
    JSON.stringify({
      tools: {
        echo: {
          command: '/bin/echo',
          fixedArgs: [],
          paramBlocklist: ['--secret'],
          envAllowlist: [],
          inheritEnv: false,
          allowedCallers: 'public',
          timeoutMs: 5000,
          maxOutputBytes: 1024,
        },
      },
    }),
    'utf-8',
  );

  const parsed = parseActionEnvelopeForTest({
    version: 1,
    reply: 'Done.',
    actions: [
      {
        type: 'save_memory',
        memory_type: 'profile',
        content: '- prefers concise updates',
        reason: 'Useful durable user preference',
        tier: 'private',
      },
    ],
  });
  assert.equal(parsed.kind, 'actions');
  assert.equal(parsed.replyText, 'Done.');
  assert.equal(parsed.actions.length, 1);

  const invalid = parseActionEnvelopeForTest({ version: 2, actions: [] });
  assert.equal(invalid.kind, 'invalid_actions');
  assert.match(invalid.error, /version/i);

  const missingScheduleParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [
      {
        type: 'create_job',
        name: 'Missing schedule',
        job_type: 'message',
        content: 'standup reminder',
      },
    ],
  });
  assert.equal(missingScheduleParsed.kind, 'invalid_actions');
  assert.match(missingScheduleParsed.error, /actions\.0\.schedule/i);

  for (const schedule of ['once', 'now', 'later']) {
    const unsupportedScheduleParsed = parseActionEnvelopeForTest({
      version: 1,
      actions: [
        {
          type: 'create_job',
          name: `Unsupported ${schedule}`,
          job_type: 'message',
          schedule,
          content: 'standup reminder',
        },
      ],
    });
    assert.equal(unsupportedScheduleParsed.kind, 'invalid_actions');
    assert.match(unsupportedScheduleParsed.error, /unsupported schedule/i);
    assert.match(unsupportedScheduleParsed.error, /daily at 09:00/i);
  }

  const recallParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [{ type: 'recall_message', message_id: 'om_bot_recall_action' }],
  });
  assert.equal(recallParsed.kind, 'actions');
  assert.equal(recallParsed.actions[0].type, 'recall_message');

  const traceQueryParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [{ type: 'get_run_trace', source: 'message', target: 'quoted', within_hours: 12 }],
  });
  assert.equal(traceQueryParsed.kind, 'actions');
  assert.equal(traceQueryParsed.actions[0].type, 'get_run_trace');

  const continuationTraceQueryParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [{ type: 'get_run_trace', source: 'continuation', log_id: 'job_0123456789abcdef01234567' }],
  });
  assert.equal(continuationTraceQueryParsed.kind, 'actions');
  assert.equal(continuationTraceQueryParsed.actions[0].source, 'continuation');

  const runJobParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [{ type: 'run_job', job_id: 'exec-action-job' }],
  });
  assert.equal(runJobParsed.kind, 'actions');
  assert.equal(runJobParsed.actions[0].type, 'run_job');

  const invalidTraceQueryParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [{ type: 'get_run_trace', source: 'cronjob', target: 'quoted', log_id: 'job_daily' }],
  });
  assert.equal(invalidTraceQueryParsed.kind, 'invalid_actions');
  assert.match(invalidTraceQueryParsed.error, /target is only supported/i);

  for (const removedAction of [
    {
      type: 'create_github_issue',
      title: 'Provider-specific issue creation should not be a Lark action',
      body: 'External issue creation belongs to custom local tools or skills.',
      target_repo: 'IS908/codex-lark-plugin',
    },
    {
      type: 'create_issue_proposal',
      title: 'Provider-specific issue proposal should not be a Lark action',
      body: 'Project governance proposals belong to custom workflow layers.',
      target_repo: 'IS908/codex-lark-plugin',
    },
    { type: 'list_issue_proposals', status: 'pending' },
    { type: 'reject_issue_proposal', id: 'proposal-abc123' },
    { type: 'create_issue_from_proposal', id: 'proposal-abc123' },
    { type: 'create_low_risk_pr_from_proposal', id: 'proposal-abc123' },
    { type: 'create_default_review_jobs', target_repo: 'IS908/codex-lark-plugin', target_chat_id: 'oc_exec' },
  ]) {
    const parsedRemovedAction = parseActionEnvelopeForTest({
      version: 1,
      actions: [removedAction],
    });
    assert.equal(parsedRemovedAction.kind, 'invalid_actions', `${removedAction.type} should be rejected`);
    assert.match(parsedRemovedAction.error, /Invalid discriminator|create_|issue_proposal/i);
  }

  const directIssueParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [
      {
        type: 'create_issue',
        title: 'Direct issue filing should not need a second approval',
        body: 'The user explicitly asked to file this GitHub issue.',
        evidence: ['explicit user request'],
        priority: 'P1',
        automation_level: 'discovery-only',
        target_repo: 'IS908/codex-lark-plugin',
        target_chat_id: 'oc_exec',
        tool: 'gh',
      },
    ],
  });
  assert.equal(directIssueParsed.kind, 'invalid_actions');
  assert.match(directIssueParsed.error, /create_issue|Invalid discriminator/i);

  const sendMessageParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [{ type: 'send_message', message: { kind: 'image', source: 'current_message:first_image' } }],
  });
  assert.equal(sendMessageParsed.kind, 'actions');
  if (sendMessageParsed.kind !== 'actions') throw new Error('sendMessageParsed should be actions');
  assert.equal(sendMessageParsed.actions[0].type, 'send_message');

  const richSendMessageParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [
      {
        type: 'send_message',
        message: {
          kind: 'rich',
          parts: [
            { type: 'text', text: 'Before\n' },
            { type: 'image', source: 'local_path', path: './diagram.png', alt: 'diagram' },
            { type: 'text', text: '\nAfter' },
          ],
        },
      },
    ],
  });
  assert.equal(richSendMessageParsed.kind, 'actions');
  if (richSendMessageParsed.kind !== 'actions') throw new Error('richSendMessageParsed should be actions');
  assert.equal(richSendMessageParsed.actions[0].type, 'send_message');

  const invalidSendMessageParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [{ type: 'send_message', message: { kind: 'file', source: 'local_path' } }],
  });
  assert.equal(invalidSendMessageParsed.kind, 'invalid_actions');
  assert.match(invalidSendMessageParsed.error, /path is required/i);

  const invalidRichSendMessageParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [{ type: 'send_message', message: { kind: 'rich', parts: [{ type: 'image', source: 'local_path' }] } }],
  });
  assert.equal(invalidRichSendMessageParsed.kind, 'invalid_actions');
  assert.match(invalidRichSendMessageParsed.error, /path is required/i);

  const unsupportedSendMessageKindParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [{ type: 'send_message', message: { kind: 'audio', source: 'local_path', path: './clip.mp3' } }],
  });
  assert.equal(unsupportedSendMessageKindParsed.kind, 'invalid_actions');
  assert.match(unsupportedSendMessageKindParsed.error, /image|file|rich|Invalid discriminator/i);

  const identitySession = new IdentitySession(() => 'ou_owner');
  identitySession.setCaller('oc_exec', 'thread_exec', 'ou_user');
  identitySession.setCaller('oc_other', 'thread_other', 'ou_other');
  const continuationJobId = 'job_0123456789abcdef01234567';
  const continuationLookups: Array<{ jobId: string; actor: string; owner?: string | null }> = [];
  const continuationCreates: any[] = [];
  const currentImagePath = join(root, 'current-image.png');
  const localFilePath = join(root, 'report.txt');
  writeFileSync(currentImagePath, 'fake image bytes', 'utf-8');
  writeFileSync(localFilePath, 'report bytes', 'utf-8');
  const sendReplyRequests: any[] = [];
  class ThisBoundQuotedTransport {
    private readonly contexts = new Map<string, any>([
      ['om_quoted_image', {
        messageId: 'om_quoted_image',
        text: '[Image]',
        msgType: 'image',
        attachments: [{ fileKey: 'img_quoted', fileName: 'quoted.png', fileType: 'image' }],
      }],
      ['om_quoted_text', {
        messageId: 'om_quoted_text',
        text: 'quoted text only',
        msgType: 'text',
        attachments: [],
      }],
    ]);

    private readonly downloadMarker = 'quoted image bytes';

    async recallMessage(): Promise<void> {}

    async fetchMessageContext(messageId: string): Promise<any> {
      return this.contexts.get(messageId) ?? {
        messageId,
        text: 'quoted text only',
        msgType: 'text',
        attachments: [],
      };
    }

    async downloadResource(messageId: string, fileKey: string, resourceType: 'image' | 'file'): Promise<Buffer> {
      assert.equal(messageId, 'om_quoted_image');
      assert.equal(fileKey, 'img_quoted');
      assert.equal(resourceType, 'image');
      return Buffer.from(this.downloadMarker);
    }
  }
  const runJobNowRequests: any[] = [];
  const dispatcher = createCodexExecActionDispatcher({
    memoryStore: new MemoryStore(memoriesDir),
    identitySession,
    localCliToolsConfigPath: localCliConfigPath,
    validateChatAccess: async (chatId) => {
      if (chatId === 'oc_missing') throw new Error('Chat oc_missing does not exist.');
    },
    sendReply: async (request: any) => {
      sendReplyRequests.push(request);
      if (request.richParts) {
        const fileSentCount = request.richParts.filter((part: any) => part.type === 'image').length;
        const failed = request.richParts.some((part: any) => part.type === 'text' && part.text === 'partial-rich-failure');
        return {
          sentCount: 1,
          fileSentCount: failed ? 0 : fileSentCount,
          richDeliveryMode: 'rich_post',
          statusText: 'Sent 1 rich post message',
        };
      }
      const fileSentCount = request.text === 'caption-only-failure' ? 0 : request.files?.length ?? 0;
      const textSentCount = request.text ? 1 : 0;
      return {
        sentCount: textSentCount + fileSentCount,
        fileSentCount,
        statusText: `Sent ${textSentCount + fileSentCount} message(s)`,
      };
    },
    larkTransport: new ThisBoundQuotedTransport(),
    continuationService: {
      async createFromMessage(action: any) {
        continuationCreates.push(action);
        return {
          job: {
            jobId: `job_created_${continuationCreates.length}`,
            title: action.title,
            permissions: {
              profile: 'bounded',
              filesystem: { requestedPaths: [] },
              network: 'none',
              externalSideEffects: 'denied',
            },
          },
          created: true,
        };
      },
      async getForActor(jobId: string, actor: string, owner?: string | null) {
        continuationLookups.push({ jobId, actor, owner });
        if (jobId === continuationJobId && actor === 'ou_user') return { jobId } as any;
        throw new ContinuationServiceError('not_accessible', 'Task not found or not accessible.');
      },
    } as any,
    runJobNow: async (job: any) => {
      runJobNowRequests.push(job);
      return { started: true };
    },
  });

  const continuationAction = (requiredTools: string[]) => ({
    type: 'create_continuation_job' as const,
    title: 'Inspect repository',
    objective: 'Inspect the local repository and summarize its structure.',
    acceptance_criteria: ['Return a concise repository summary.'],
    context_snapshot: {
      summary: 'No work completed yet.',
      completed_steps: [],
      remaining_steps: ['Inspect files and summarize.'],
      constraints: ['Read-only analysis.'],
      decisions: [],
      references: [],
    },
    required_tools: requiredTools,
    working_directory: '.',
  });
  const continuationMessage = {
    messageId: 'om_continuation_tools',
    chatId: 'oc_exec',
    threadId: 'thread_exec',
    chatType: 'group' as const,
    senderId: 'ou_user',
    text: 'continue repository analysis',
    messageType: 'text' as const,
    rawContent: '{}',
  };
  const rejectedBuiltinTools = await dispatcher.execute({
    message: continuationMessage,
    actions: [continuationAction(['exec_command', 'apply_patch'])],
  });
  assert.equal(rejectedBuiltinTools[0].ok, false);
  assert.match(rejectedBuiltinTools[0].message, /not configured host CLI tools.*apply_patch, exec_command/i);
  assert.match(rejectedBuiltinTools[0].message, /standard Codex tools must not be declared/i);
  assert.equal(continuationCreates.length, 0);

  const emptyHostTools = await dispatcher.execute({
    message: { ...continuationMessage, messageId: 'om_continuation_empty_tools' },
    actions: [continuationAction([])],
  });
  assert.equal(emptyHostTools[0].ok, true);
  assert.equal(continuationCreates.length, 1);

  const hiddenContinuation = await dispatcher.execute({
    message: { ...continuationMessage, messageId: 'om_continuation_not_permitted' },
    actions: [continuationAction([])],
    continuationPermitted: false,
  });
  assert.equal(hiddenContinuation[0].ok, false);
  assert.match(hiddenContinuation[0].message, /not permitted for this foreground turn/i);
  assert.equal(continuationCreates.length, 1);

  const configuredHostTool = await dispatcher.execute({
    message: { ...continuationMessage, messageId: 'om_continuation_echo_tool' },
    actions: [continuationAction(['echo'])],
  });
  assert.equal(configuredHostTool[0].ok, true);
  assert.deepEqual(continuationCreates[1].required_tools, ['echo']);

  const traceTimestamp = new Date().toISOString();
  writeFileSync(traceLogPath, [
    `${traceTimestamp}  om_exec_trace  runmsg1  exec_command  completed  item_1  1000ms  {"cmd":"npm test"}`,
    `${traceTimestamp}  om_quoted_trace  runquoted1  github.get_issue  completed  call_quoted  1000ms  {"issue":248}`,
    `${traceTimestamp}  trace-job  runcron1  command_execution  completed  item_cron  1000ms  {"cmd":"cron"}`,
    `${traceTimestamp}  ${continuationJobId}  runcontinuation1  command_execution  completed  item_continuation  1000ms  {"cmd":"continue"}`,
    '',
  ].join('\n'));
  writeFileSync(join(jobsDir, 'trace-job.json'), JSON.stringify({
    meta: {
      id: 'trace-job',
      name: 'Trace Job',
      type: 'prompt',
      schedule: 'daily at 09:00',
      schedule_human: 'daily at 09:00',
      timezone: 'Asia/Shanghai',
      prompt: 'trace me',
      target_chat_id: 'oc_exec',
      origin_chat_id: 'oc_exec',
      status: 'active',
      created_by: 'ou_user',
      created_at: '2026-07-12T00:00:00.000Z',
    },
    runtime: createInitialJobRuntime('2026-07-13T01:00:00.000Z'),
  }, null, 2), 'utf-8');

  const traceResult = await dispatcher.execute({
    message: {
      messageId: 'om_exec_trace',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'show current trace',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'get_run_trace', source: 'message' }],
  });
  assert.equal(traceResult[0].ok, true, JSON.stringify(traceResult));
  assert.match(traceResult[0].message, /"log_id": "om_exec_trace"/);
  assert.match(traceResult[0].message, /"run_ids": \[\s*"runmsg1"\s*\]/);

  const quotedTraceResult = await dispatcher.execute({
    message: {
      messageId: 'om_exec_trace_quoted_request',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'show quoted trace',
      messageType: 'text',
      rawContent: '{}',
      parentId: 'om_quoted_trace',
    },
    actions: [{ type: 'get_run_trace', source: 'message', target: 'quoted' }],
  });
  assert.equal(quotedTraceResult[0].ok, true, JSON.stringify(quotedTraceResult));
  assert.match(quotedTraceResult[0].message, /"log_id": "om_quoted_trace"/);

  const deniedMessageTraceResult = await dispatcher.execute({
    message: {
      messageId: 'om_exec_trace_denied',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'show another message trace',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'get_run_trace', source: 'message', log_id: 'om_quoted_trace' }],
  });
  assert.equal(deniedMessageTraceResult[0].ok, false);
  assert.match(deniedMessageTraceResult[0].message, /"status": "unauthorized"/);
  assert.match(deniedMessageTraceResult[0].message, /current message trace or the quoted message trace/i);

  const cronTraceResult = await dispatcher.execute({
    message: {
      messageId: 'om_exec_trace_cron',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'show cron trace',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'get_run_trace', source: 'cronjob', log_id: 'trace-job' }],
  });
  assert.equal(cronTraceResult[0].ok, true, JSON.stringify(cronTraceResult));
  assert.match(cronTraceResult[0].message, /"log_id": "trace-job"/);

  const continuationTraceResult = await dispatcher.execute({
    message: {
      messageId: 'om_exec_trace_continuation',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'show continuation trace',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'get_run_trace', source: 'continuation', log_id: continuationJobId }],
  });
  assert.equal(continuationTraceResult[0].ok, true, JSON.stringify(continuationTraceResult));
  assert.match(continuationTraceResult[0].message, /"log_id": "job_0123456789abcdef01234567"/);
  assert.deepEqual(continuationLookups[0], {
    jobId: continuationJobId,
    actor: 'ou_user',
    owner: 'ou_user',
  });

  const missingContinuationTraceIdResult = await dispatcher.execute({
    message: {
      messageId: 'om_exec_trace_continuation_missing_id',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'show continuation trace',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'get_run_trace', source: 'continuation' }],
  });
  assert.equal(missingContinuationTraceIdResult[0].ok, false);
  assert.match(missingContinuationTraceIdResult[0].message, /requires log_id/i);

  const deniedContinuationTraceResult = await dispatcher.execute({
    message: {
      messageId: 'om_exec_trace_continuation_denied',
      chatId: 'oc_other',
      threadId: 'thread_other',
      chatType: 'group',
      senderId: 'ou_other',
      text: 'show another continuation trace',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'get_run_trace', source: 'continuation', log_id: continuationJobId }],
  });
  assert.equal(deniedContinuationTraceResult[0].ok, false);
  assert.match(deniedContinuationTraceResult[0].message, /"status": "unauthorized"/);

  const noContinuationRuntimeDispatcher = createCodexExecActionDispatcher({
    memoryStore: new MemoryStore(memoriesDir),
    identitySession,
  });
  const unavailableContinuationTraceResult = await noContinuationRuntimeDispatcher.execute({
    message: {
      messageId: 'om_exec_trace_continuation_unavailable',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'show continuation trace',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'get_run_trace', source: 'continuation', log_id: continuationJobId }],
  });
  assert.equal(unavailableContinuationTraceResult[0].ok, false);
  assert.match(unavailableContinuationTraceResult[0].message, /continuation runtime is unavailable/i);

  const invalidCronTraceLogIdResult = await dispatcher.execute({
    message: {
      messageId: 'om_exec_trace_invalid_cron',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'show invalid cron trace',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'get_run_trace', source: 'cronjob', log_id: '../trace-job' }],
  });
  assert.equal(invalidCronTraceLogIdResult[0].ok, false);
  assert.match(invalidCronTraceLogIdResult[0].message, /"status": "unauthorized"/);
  assert.match(invalidCronTraceLogIdResult[0].message, /stable job_id/i);

  (appConfig as any).codexExecToolTraceEnabled = false;
  const disabledAfterToggle = await dispatcher.execute({
    message: {
      messageId: 'om_exec_trace',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'show trace while disabled',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'get_run_trace', source: 'message' }],
  });
  assert.equal(disabledAfterToggle[0].ok, false);
  assert.match(disabledAfterToggle[0].message, /"status": "disabled"/);
  (appConfig as any).codexExecToolTraceEnabled = true;

  const results = await dispatcher.execute({
    message: {
      messageId: 'om_exec',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'remember this and create a job',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [
      {
        type: 'save_memory',
        memory_type: 'profile',
        content: '- prefers concise updates',
        reason: 'Useful durable user preference',
        tier: 'private',
      },
      {
        type: 'create_job',
        name: 'Exec Action Job',
        job_type: 'message',
        schedule: 'daily at 09:00',
        content: 'standup reminder',
        target_chat_id: 'oc_exec',
      },
      {
        type: 'run_local_cli_tool',
        tool: 'echo',
        args: ['hello-from-action'],
      },
    ],
  });

  assert.equal(results.length, 3);
  assert.ok(results.every((result: any) => result.ok), JSON.stringify(results));
  assert.match(results[1].message, /job_id: exec-action-job/i);
  assert.match(results[1].message, /Next run: .*Asia\/Shanghai; UTC /);
  const privateProfile = readFileSync(join(memoriesDir, 'profiles', 'ou_user', 'private.md'), 'utf-8');
  assert.match(privateProfile, /prefers concise updates/);
  assert.equal(existsSync(join(jobsDir, 'exec-action-job.json')), true);
  assertInitialRuntimeShape(JSON.parse(readFileSync(join(jobsDir, 'exec-action-job.json'), 'utf-8')));
  assert.match(results[2].message, /hello-from-action/);

  const runJobResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_run_job',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'rerun the quoted cronjob',
      messageType: 'text',
      rawContent: '{}',
      quotedCronJobId: 'exec-action-job',
    },
    actions: [{ type: 'run_job', job_id: 'exec-action-job' }],
  });
  assert.equal(runJobResults[0].ok, true, JSON.stringify(runJobResults));
  assert.match(runJobResults[0].message, /Reran job "exec-action-job"/);
  assert.equal(runJobNowRequests.length, 1);
  assert.equal(runJobNowRequests[0].meta.prompt, undefined);
  assert.equal(runJobNowRequests[0].meta.content, 'standup reminder');

  const deniedRunJobResults = await dispatcher.execute({
    message: {
      messageId: 'om_other_run_job',
      chatId: 'oc_other',
      threadId: 'thread_other',
      chatType: 'p2p',
      senderId: 'ou_other',
      text: 'rerun it',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'run_job', job_id: 'exec-action-job' }],
  });
  assert.equal(deniedRunJobResults[0].ok, false);
  assert.match(deniedRunJobResults[0].message, /not the owner/i);
  assert.equal(runJobNowRequests.length, 1);

  const accessResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_access_current',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'allow this chat',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'manage_access_control', action: 'add', list: 'allowed_chat_ids', value: 'current' }],
  });
  assert.equal(accessResults.length, 1);
  assert.equal(accessResults[0].ok, true, JSON.stringify(accessResults));
  assert.equal(accessControlStore.snapshot().allowed_chat_ids.includes('oc_exec'), true);
  assert.equal(accessResults[0].message, 'Chat access added.');
  assert.doesNotMatch(accessResults[0].message, /oc_exec|allowed_chat_ids|resolved_from_current_chat|snapshot/);

  const invalidAccessResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_access_invalid',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'bad chat id',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'manage_access_control', action: 'add', list: 'allowed_chat_ids', value: 'not-a-chat' }],
  });
  assert.equal(invalidAccessResults[0].ok, false);
  assert.match(invalidAccessResults[0].message, /oc_\.\.\. format/);

  const imageActionResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_media_image',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'send current image',
      messageType: 'image',
      rawContent: '{}',
      imagePath: currentImagePath,
    },
    actions: [{ type: 'send_message', message: { kind: 'image', source: 'current_message:first_image' } }],
  });
  assert.equal(imageActionResults.length, 1);
  assert.equal(imageActionResults[0].ok, true, JSON.stringify(imageActionResults));
  assert.equal(sendReplyRequests.at(-1).chat_id, 'oc_exec');
  assert.equal(sendReplyRequests.at(-1).reply_to, 'om_exec_media_image');
  assert.equal(sendReplyRequests.at(-1).thread_id, 'thread_exec');
  assert.deepEqual(sendReplyRequests.at(-1).files, [{ path: currentImagePath, type: 'image' }]);

  const quotedImageActionResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_quoted_media_image',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'send quoted image',
      messageType: 'text',
      rawContent: '{}',
      parentId: 'om_quoted_image',
    },
    actions: [{ type: 'send_message', message: { kind: 'image', source: 'quoted_message:first_image' } }],
  });
  assert.equal(quotedImageActionResults[0].ok, true, JSON.stringify(quotedImageActionResults));
  const quotedImageFile = sendReplyRequests.at(-1).files[0].path;
  assert.equal(sendReplyRequests.at(-1).reply_to, 'om_exec_quoted_media_image');
  assert.equal(sendReplyRequests.at(-1).files[0].type, 'image');
  assert.equal(existsSync(quotedImageFile), true);
  assert.match(readFileSync(quotedImageFile, 'utf-8'), /quoted image bytes/);

  const fileActionResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_media_file',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'send local file',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'send_message', message: { kind: 'file', source: 'local_path', path: localFilePath, text: 'Report attached.' } }],
  });
  assert.equal(fileActionResults[0].ok, true, JSON.stringify(fileActionResults));
  assert.equal(sendReplyRequests.at(-1).text, 'Report attached.');
  assert.deepEqual(sendReplyRequests.at(-1).files, [{ path: localFilePath, type: 'file' }]);

  const fileUploadFailureResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_media_file_upload_failure',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'send local file',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [
      {
        type: 'send_message',
        message: { kind: 'file', source: 'local_path', path: localFilePath, text: 'caption-only-failure' },
      },
    ],
  });
  assert.equal(fileUploadFailureResults[0].ok, false);
  assert.match(fileUploadFailureResults[0].message, /Media was not delivered/i);

  const richActionResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_media_rich',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'send rich message',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [
      {
        type: 'send_message',
        message: {
          kind: 'rich',
          parts: [
            { type: 'text', text: 'Before\n' },
            { type: 'image', source: 'local_path', path: localFilePath, alt: 'report' },
            { type: 'text', text: '\nAfter' },
          ],
        },
      },
    ],
  });
  assert.equal(richActionResults[0].ok, true, JSON.stringify(richActionResults));
  assert.deepEqual(sendReplyRequests.at(-1).richParts, [
    { type: 'text', text: 'Before\n' },
    { type: 'image', path: localFilePath, alt: 'report' },
    { type: 'text', text: '\nAfter' },
  ]);

  const richImageFailureResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_media_rich_failure',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'send rich message',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [
      {
        type: 'send_message',
        message: {
          kind: 'rich',
          parts: [
            { type: 'text', text: 'partial-rich-failure' },
            { type: 'image', source: 'local_path', path: localFilePath },
          ],
        },
      },
    ],
  });
  assert.equal(richImageFailureResults[0].ok, false);
  assert.match(richImageFailureResults[0].message, /Not all rich message images/i);

  const missingImageActionResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_media_missing',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'send missing image',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'send_message', message: { kind: 'image', source: 'current_message:first_image' } }],
  });
  assert.equal(missingImageActionResults[0].ok, false);
  assert.match(missingImageActionResults[0].message, /No current-message image/i);

  const missingQuotedImageActionResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_quoted_media_missing',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'send quoted image',
      messageType: 'text',
      rawContent: '{}',
      parentId: 'om_quoted_text',
    },
    actions: [{ type: 'send_message', message: { kind: 'image', source: 'quoted_message:first_image' } }],
  });
  assert.equal(missingQuotedImageActionResults[0].ok, false);
  assert.match(missingQuotedImageActionResults[0].message, /no downloadable image/i);

  const jobManagementParsed = parseActionEnvelopeForTest({
    version: 1,
    actions: [
      { type: 'list_jobs', status: 'all' },
      { type: 'update_job', name: 'Exec Action Job', content: 'updated reminder', schedule: 'weekdays at 10:00' },
      { type: 'disable_job', job_id: 'exec-action-job' },
      {
        type: 'upsert_job',
        name: 'Exec Action Job',
        job_type: 'message',
        schedule: 'daily at 11:00',
        content: 'upserted reminder',
        target_chat_id: 'oc_exec',
      },
      { type: 'delete_job', job_id: 'exec-action-job' },
    ],
  });
  assert.equal(jobManagementParsed.kind, 'actions');
  if (jobManagementParsed.kind !== 'actions') {
    throw new Error(`expected job management actions, got ${JSON.stringify(jobManagementParsed)}`);
  }
  assert.deepEqual(
    jobManagementParsed.actions.map((action: any) => action.type),
    ['list_jobs', 'update_job', 'disable_job', 'upsert_job', 'delete_job'],
  );
  const jobManagementResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_jobs',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'manage the reminder',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: jobManagementParsed.actions,
  });
  assert.equal(jobManagementResults.length, 5);
  assert.ok(jobManagementResults.every((result: any) => result.ok), JSON.stringify(jobManagementResults));
  assert.match(jobManagementResults[0].message, /exec-action-job/);
  assert.match(jobManagementResults[0].message, /standup reminder/);
  assert.match(jobManagementResults[1].message, /Updated job "exec-action-job"/);
  assert.match(jobManagementResults[1].message, /weekdays at 10:00/);
  assert.match(jobManagementResults[1].message, /Next run: .*Asia\/Shanghai; UTC /);
  assert.match(jobManagementResults[2].message, /Status: paused/i);
  assert.match(jobManagementResults[2].message, /Next run: - \(paused\)/);
  assert.match(jobManagementResults[3].message, /Upserted job "exec-action-job"/);
  assert.match(jobManagementResults[3].message, /daily at 11:00/);
  assert.match(jobManagementResults[3].message, /Next run: .*Asia\/Shanghai; UTC /);
  assert.match(jobManagementResults[4].message, /Deleted job "exec-action-job"/);
  assert.equal(existsSync(join(jobsDir, 'exec-action-job.json')), false);

  const upsertNewResults = await dispatcher.execute({
    message: {
      messageId: 'om_exec_upsert_new',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'upsert a new reminder',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [
      {
        type: 'upsert_job',
        name: 'Exec Upsert New Job',
        job_type: 'message',
        schedule: 'daily at 12:00',
        content: 'new upsert reminder',
        target_chat_id: 'oc_exec',
      },
    ],
  });
  assert.equal(upsertNewResults[0].ok, true, JSON.stringify(upsertNewResults));
  assertInitialRuntimeShape(JSON.parse(readFileSync(join(jobsDir, 'exec-upsert-new-job.json'), 'utf-8')));

  const recallCalls: string[] = [];
  const botTracker = new BotMessageTracker(10);
  botTracker.add('om_bot_recall_action', { chatId: 'oc_exec', threadId: 'thread_exec' });
  const turnObligations = new TurnObligationTracker({ timeoutMs: 60_000 });
  turnObligations.begin({
    messageId: 'om_exec_recall_turn',
    chatId: 'oc_exec',
    threadId: 'thread_exec',
    caller: 'ou_user',
    mode: 'exec',
  });
  const recallDispatcher = createCodexExecActionDispatcher({
    memoryStore: new MemoryStore(memoriesDir),
    identitySession,
    localCliToolsConfigPath: localCliConfigPath,
    botMessageTracker: botTracker,
    turnObligations,
    larkTransport: {
      recallMessage: async (messageId: string) => {
        recallCalls.push(messageId);
      },
    },
  });
  const recallResults = await recallDispatcher.execute({
    message: {
      messageId: 'om_exec_recall_turn',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'recall that bot message',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'recall_message', message_id: 'om_bot_recall_action' }],
  });
  assert.deepEqual(recallCalls, ['om_bot_recall_action']);
  assert.equal(recallResults.length, 1);
  assert.equal(recallResults[0].ok, true);
  assert.equal(turnObligations.getStatus('om_exec_recall_turn'), 'satisfied');

  const deniedRecall = await recallDispatcher.execute({
    message: {
      messageId: 'om_exec_recall_denied',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'recall unknown',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'recall_message', message_id: 'om_unknown' }],
  });
  assert.equal(deniedRecall[0].ok, false);
  assert.match(deniedRecall[0].message, /not a tracked bot message/i);

  botTracker.add('om_bot_other_scope', { chatId: 'oc_other', threadId: 'thread_exec' });
  const wrongScopeRecall = await recallDispatcher.execute({
    message: {
      messageId: 'om_exec_recall_wrong_scope',
      chatId: 'oc_exec',
      threadId: 'thread_exec',
      chatType: 'group',
      senderId: 'ou_user',
      text: 'recall wrong scope',
      messageType: 'text',
      rawContent: '{}',
    },
    actions: [{ type: 'recall_message', message_id: 'om_bot_other_scope' }],
  });
  assert.equal(wrongScopeRecall[0].ok, false);
  assert.match(
    wrongScopeRecall[0].message,
    /recall_message denied: om_bot_other_scope belongs to chat=oc_other thread=thread_exec, does not belong to chat=oc_exec thread=thread_exec/i,
  );
} finally {
  (appConfig as any).jobsDir = oldJobsDir;
  (appConfig as any).inboxDir = oldInboxDir;
  (appConfig as any).ownerOpenId = oldOwnerOpenId;
  (appConfig as any).codexExecToolTraceEnabled = oldTraceEnabled;
  (appConfig as any).codexExecTraceLogPath = oldTraceLogPath;
  accessControlStore.replaceForTest(oldAccessSnapshot);
  rmSync(root, { recursive: true, force: true });
}

console.log('codex-exec-actions smoke: PASS');
