import os from 'node:os';
import path from 'node:path';

export type ConfigCategory =
  | 'Credentials'
  | 'Messaging'
  | 'Acknowledgement'
  | 'Reliability'
  | 'CronJob'
  | 'Memory'
  | 'Identity'
  | 'Privacy'
  | 'Quoted cards'
  | 'Resource governance';

type ConfigPrimitive = string | number | boolean | null;

interface ConfigResolutionContext {
  homeDir: string;
  systemTimezone: string;
  get(key: string): ConfigPrimitive;
}

type ConfigDefault<T extends ConfigPrimitive> =
  | T
  | ((context: ConfigResolutionContext) => T);

interface CommonDefinition {
  category: ConfigCategory;
  required: boolean;
  sensitive: boolean;
  defaultDisplay: string;
  description: {
    en: string;
    zh: string;
  };
  features: readonly string[];
  deprecated?: {
    replacement?: string;
    note: string;
  };
}

interface StringDefinition extends CommonDefinition {
  type: 'string';
  default?: ConfigDefault<string | null>;
  empty: 'default' | 'preserve' | 'null' | 'error';
  nullable?: true;
  absolutePath?: true;
}

interface NumberDefinition extends CommonDefinition {
  type: 'number';
  default: ConfigDefault<number>;
  number: {
    integer?: true;
    minimum?: number;
    maximum?: number;
    exclusiveMinimum?: true;
    message: string;
  };
  normalize?: (value: number, context: ConfigResolutionContext) => number;
}

interface BooleanDefinition extends CommonDefinition {
  type: 'boolean';
  default: ConfigDefault<boolean>;
}

interface ChoiceDefinition<T extends readonly string[] = readonly string[]>
  extends CommonDefinition {
  type: 'choice';
  default: ConfigDefault<T[number]>;
  choices: T;
}

export type ConfigDefinition =
  | StringDefinition
  | NumberDefinition
  | BooleanDefinition
  | ChoiceDefinition;

type DefinitionOptions = Omit<CommonDefinition, 'required' | 'sensitive'> & {
  required?: boolean;
  sensitive?: boolean;
};

function stringConfig<const T extends Omit<StringDefinition, keyof CommonDefinition | 'type'>>(
  options: DefinitionOptions & T,
): CommonDefinition & { type: 'string' } & T {
  return {
    type: 'string',
    required: false,
    sensitive: false,
    ...options,
  };
}

function numberConfig<const T extends Omit<NumberDefinition, keyof CommonDefinition | 'type'>>(
  options: DefinitionOptions & T,
): CommonDefinition & { type: 'number' } & T {
  return {
    type: 'number',
    required: false,
    sensitive: false,
    ...options,
  };
}

function booleanConfig<const T extends Omit<BooleanDefinition, keyof CommonDefinition | 'type'>>(
  options: DefinitionOptions & T,
): CommonDefinition & { type: 'boolean' } & T {
  return {
    type: 'boolean',
    required: false,
    sensitive: false,
    ...options,
  };
}

function choiceConfig<
  const TChoices extends readonly string[],
  const T extends Omit<ChoiceDefinition<TChoices>, keyof CommonDefinition | 'type' | 'choices'>,
>(
  choices: TChoices,
  options: DefinitionOptions & T,
): CommonDefinition & { type: 'choice'; choices: TChoices } & T {
  return {
    type: 'choice',
    choices,
    required: false,
    sensitive: false,
    ...options,
  };
}

const positive = (message = 'Expected a positive number.') => ({
  exclusiveMinimum: true as const,
  minimum: 0,
  message,
});

const nonNegative = (message = 'Expected a non-negative number.') => ({
  minimum: 0,
  message,
});

const messaging = (en: string, zh: string, features: readonly string[] = ['messaging']) => ({
  category: 'Messaging' as const,
  description: { en, zh },
  features,
});

const reliability = (en: string, zh: string) => ({
  category: 'Reliability' as const,
  description: { en, zh },
  features: ['lark-api'] as const,
});

const memory = (en: string, zh: string) => ({
  category: 'Memory' as const,
  description: { en, zh },
  features: ['memory'] as const,
});

const resources = (en: string, zh: string) => ({
  category: 'Resource governance' as const,
  description: { en, zh },
  features: ['resource-governance'] as const,
});

export const configSchema = {
  LARK_APP_ID: stringConfig({
    category: 'Credentials',
    required: true,
    sensitive: false,
    defaultDisplay: '-',
    description: { en: 'Feishu/Lark application ID.', zh: '飞书/Lark 应用 ID。' },
    features: ['bootstrap'],
    empty: 'error',
  }),
  LARK_APP_SECRET: stringConfig({
    category: 'Credentials',
    required: true,
    sensitive: true,
    defaultDisplay: '-',
    description: { en: 'Feishu/Lark application secret.', zh: '飞书/Lark 应用密钥。' },
    features: ['bootstrap'],
    empty: 'error',
  }),
  LARK_TEXT_CHUNK_LIMIT: numberConfig({
    ...messaging('Maximum characters per text message chunk.', '每个文本消息分片的最大字符数。'),
    default: 4_000,
    defaultDisplay: '4000',
    number: positive(),
  }),
  LARK_QUEUE_HANDLER_TIMEOUT_MS: numberConfig({
    ...messaging(
      'Per-thread queue timeout; zero disables it and positive values are raised above the exec timeout.',
      '每个会话队列的超时；0 表示关闭，正值会被提升到 exec 超时以上。',
    ),
    default: (context) => Number(context.get('LARK_CODEX_EXEC_TIMEOUT_MS')) + 60_000,
    defaultDisplay: 'LARK_CODEX_EXEC_TIMEOUT_MS + 60000',
    number: nonNegative(),
    normalize: (value, context) =>
      value === 0
        ? 0
        : Math.max(value, Number(context.get('LARK_CODEX_EXEC_TIMEOUT_MS')) + 60_000),
  }),
  LARK_REPLY_OBLIGATION_TIMEOUT_MS: numberConfig({
    ...messaging(
      'Maximum wait for a visible reply or defer result.',
      '等待可见回复或 defer 结果的最长时间。',
    ),
    default: (context) =>
      Math.max(60_000, Number(context.get('LARK_CODEX_EXEC_TIMEOUT_MS')) + 60_000),
    defaultDisplay: 'max(60000, LARK_CODEX_EXEC_TIMEOUT_MS + 60000)',
    number: positive(),
  }),
  LARK_CODEX_EXEC_COMMAND: stringConfig({
    ...messaging('Codex CLI command used for exec delivery.', 'exec 投递使用的 Codex CLI 命令。'),
    default: 'codex',
    defaultDisplay: 'codex',
    empty: 'default',
  }),
  LARK_CODEX_EXEC_CWD: stringConfig({
    ...messaging('Working directory for foreground Codex exec turns.', '前台 Codex exec 回合的工作目录。'),
    default: ({ homeDir }) => path.join(homeDir, '.codex', 'channels', 'lark', 'codex-exec-workdir'),
    defaultDisplay: '~/.codex/channels/lark/codex-exec-workdir',
    empty: 'default',
  }),
  LARK_CODEX_EXEC_TIMEOUT_MS: numberConfig({
    ...messaging('Timeout for one foreground Codex exec run.', '单次前台 Codex exec 运行超时。'),
    default: 600_000,
    defaultDisplay: '600000',
    number: positive(),
  }),
  LARK_CODEX_EXEC_SANDBOX: choiceConfig(
    ['read-only', 'workspace-write', 'danger-full-access'] as const,
    {
      ...messaging('Sandbox mode passed to foreground Codex exec.', '传给前台 Codex exec 的沙盒模式。'),
      default: 'workspace-write',
      defaultDisplay: 'workspace-write',
    },
  ),
  LARK_CODEX_EXEC_MODEL: stringConfig({
    ...messaging('Optional global model override for Codex exec.', 'Codex exec 的可选全局模型覆盖。'),
    default: null,
    defaultDisplay: '(empty)',
    empty: 'null',
    nullable: true,
  }),
  LARK_CODEX_EXEC_PROFILE: stringConfig({
    ...messaging('Optional Codex configuration profile.', '可选的 Codex 配置 profile。'),
    default: null,
    defaultDisplay: '(empty)',
    empty: 'null',
    nullable: true,
  }),
  LARK_CODEX_EXEC_IGNORE_USER_CONFIG: booleanConfig({
    ...messaging('Prevent child exec turns from loading user Codex configuration.', '阻止子 exec 回合加载用户 Codex 配置。'),
    default: true,
    defaultDisplay: 'true',
  }),
  LARK_CODEX_EXEC_USE_SESSIONS: booleanConfig({
    ...messaging('Resume one Codex session per Feishu chat or thread.', '每个飞书会话或话题复用一个 Codex session。'),
    default: true,
    defaultDisplay: 'true',
  }),
  LARK_EXEC_PROGRESS_ENABLED: booleanConfig({
    ...messaging('Enable bounded progress updates for long foreground turns.', '为长时间前台回合启用有界过程消息。'),
    default: true,
    defaultDisplay: 'true',
  }),
  LARK_EXEC_PROGRESS_MAX_MESSAGES: numberConfig({
    ...messaging('Maximum progress messages per foreground turn.', '每个前台回合最多发送的过程消息数。'),
    default: 3,
    defaultDisplay: '3',
    number: positive(),
  }),
  LARK_EXEC_PROGRESS_MAX_CHARS: numberConfig({
    ...messaging('Maximum characters in one progress message.', '单条过程消息的最大字符数。'),
    default: 300,
    defaultDisplay: '300',
    number: positive(),
  }),
  LARK_EXEC_PROGRESS_MIN_INTERVAL_MS: numberConfig({
    ...messaging('Minimum interval between progress messages.', '过程消息之间的最小间隔。'),
    default: 15_000,
    defaultDisplay: '15000',
    number: nonNegative(),
  }),
  LARK_EXEC_PROGRESS_POLL_INTERVAL_MS: numberConfig({
    ...messaging('Parent-side progress side-channel polling interval.', '父进程轮询过程消息侧通道的间隔。'),
    default: 250,
    defaultDisplay: '250',
    number: positive(),
  }),
  LARK_CODEX_EXEC_TOOL_TRACE: booleanConfig({
    ...messaging('Write sanitized Codex tool execution traces locally.', '在本地写入脱敏后的 Codex 工具执行 trace。'),
    default: false,
    defaultDisplay: 'false',
  }),
  LARK_CODEX_EXEC_TOOL_TRACE_MODE: choiceConfig(['compact', 'full', 'hidden'] as const, {
    ...messaging('Local Codex tool trace detail level.', '本地 Codex 工具 trace 的详细程度。'),
    default: 'compact',
    defaultDisplay: 'compact',
  }),
  LARK_CODEX_EXEC_TRACE_LOG: stringConfig({
    ...messaging('Path of the local Codex tool trace log.', '本地 Codex 工具 trace 日志路径。'),
    default: ({ homeDir }) => path.join(homeDir, '.codex', 'channels', 'lark', 'logs', 'trace.log'),
    defaultDisplay: '~/.codex/channels/lark/logs/trace.log',
    empty: 'default',
  }),
  LARK_CARD_FOOTER_METRICS_ENABLED: booleanConfig({
    ...messaging('Append compact runtime metrics to generated card replies.', '在生成的卡片回复底部附加紧凑运行指标。'),
    default: true,
    defaultDisplay: 'true',
  }),
  LARK_CARD_FOOTER_METRICS_TOKEN_USAGE_THRESHOLD: numberConfig({
    ...messaging('Token threshold for showing usage in card footers.', '在卡片页脚显示 token 用量的阈值。'),
    default: 20_000,
    defaultDisplay: '20000',
    number: nonNegative(),
  }),
  LARK_CODEX_SESSION_RETENTION_DAYS: numberConfig({
    ...messaging('Retention age for Codex exec session pointers.', 'Codex exec session 指针的保留天数。'),
    default: 14,
    defaultDisplay: '14',
    number: positive(),
  }),
  LARK_CODEX_SESSION_RETENTION_SCAN_INTERVAL_HOURS: numberConfig({
    ...messaging('Interval for scanning expired Codex session pointers.', '扫描过期 Codex session 指针的间隔。'),
    default: 24,
    defaultDisplay: '24',
    number: nonNegative(),
  }),
  LARK_CODEX_SESSION_RETENTION_DRY_RUN: booleanConfig({
    ...messaging('Preview Codex session cleanup without deleting records.', '仅预览 Codex session 清理而不删除记录。'),
    default: false,
    defaultDisplay: 'false',
  }),
  LARK_CONTINUATION_ENABLED: booleanConfig({
    ...messaging('Enable durable background continuation creation and execution.', '启用持久化后台 continuation 的创建与执行。', ['continuation']),
    default: true,
    defaultDisplay: 'true',
  }),
  LARK_CONTINUATION_MAX_CONCURRENCY: numberConfig({
    ...messaging('Maximum concurrent continuation executions.', 'continuation 的最大并发执行数。', ['continuation']),
    default: 1,
    defaultDisplay: '1',
    number: { integer: true, minimum: 1, maximum: 4, message: 'Expected an integer between 1 and 4.' },
  }),
  LARK_CONTINUATION_MAX_ATTEMPTS: numberConfig({
    ...messaging('Maximum attempts per continuation Job.', '每个 continuation Job 的最大 attempt 数。', ['continuation']),
    default: 5,
    defaultDisplay: '5',
    number: { integer: true, minimum: 1, maximum: 20, message: 'Expected an integer between 1 and 20.' },
  }),
  LARK_CONTINUATION_MAX_RETRIES: numberConfig({
    ...messaging('Retryable failures allowed within the attempt budget.', 'attempt 预算内允许的可重试失败次数。', ['continuation']),
    default: 3,
    defaultDisplay: '3',
    number: { integer: true, minimum: 0, maximum: 10, message: 'Expected an integer between 0 and 10.' },
  }),
  LARK_CONTINUATION_MAX_TOTAL_MINUTES: numberConfig({
    ...messaging('Maximum lifetime of one continuation Job.', '单个 continuation Job 的最长生命周期。', ['continuation']),
    default: 30,
    defaultDisplay: '30',
    number: { integer: true, minimum: 5, maximum: 1_440, message: 'Expected an integer between 5 and 1440.' },
  }),
  LARK_CONTINUATION_RETENTION_DAYS: numberConfig({
    ...messaging('Days to retain terminal continuation details and artifacts.', '终态 continuation 详情与产物的保留天数。', ['continuation']),
    default: 30,
    defaultDisplay: '30',
    number: { integer: true, minimum: 1, maximum: 3_650, message: 'Expected an integer between 1 and 3650.' },
  }),
  LARK_CONTINUATION_WORKING_ROOT: stringConfig({
    ...messaging('Absolute authorized root for continuation working directories.', 'continuation 工作目录允许使用的绝对根路径。', ['continuation']),
    default: (context) => String(context.get('LARK_CODEX_EXEC_CWD')),
    defaultDisplay: 'LARK_CODEX_EXEC_CWD',
    empty: 'default',
    absolutePath: true,
  }),
  LARK_SESSION_HEALTH_ENABLED: booleanConfig({
    ...messaging('Enable owner nudges for long-running Codex sessions.', '启用长时间 Codex session 的 owner 提醒。'),
    default: false,
    defaultDisplay: 'false',
  }),
  LARK_SESSION_HEALTH_TURN_THRESHOLD: numberConfig({
    ...messaging('Session turn threshold for a health nudge.', '触发 session 健康提醒的回合数阈值。'),
    default: 80,
    defaultDisplay: '80',
    number: positive(),
  }),
  LARK_SESSION_HEALTH_PROMPT_BYTES_THRESHOLD: numberConfig({
    ...messaging('Prompt-byte threshold for a session health nudge.', '触发 session 健康提醒的 prompt 字节数阈值。'),
    default: 512 * 1_024,
    defaultDisplay: '524288',
    number: positive(),
  }),
  LARK_SESSION_HEALTH_TOKEN_THRESHOLD: numberConfig({
    ...messaging('Reported token threshold for a session health nudge.', '触发 session 健康提醒的已报告 token 阈值。'),
    default: 160_000,
    defaultDisplay: '160000',
    number: positive(),
  }),
  LARK_SESSION_HEALTH_IDLE_DELAY_MS: numberConfig({
    ...messaging('Idle delay before checking session health gates.', '检查 session 健康门槛前的空闲延迟。'),
    default: 30_000,
    defaultDisplay: '30000',
    number: nonNegative(),
  }),
  LARK_SESSION_HEALTH_COOLDOWN_MS: numberConfig({
    ...messaging('Initial cooldown between session health nudges.', 'session 健康提醒的初始冷却时间。'),
    default: 30 * 60 * 1_000,
    defaultDisplay: '1800000',
    number: positive(),
  }),
  LARK_SESSION_HEALTH_MAX_COOLDOWN_MS: numberConfig({
    ...messaging('Maximum exponential session health cooldown.', 'session 健康提醒的最大指数冷却时间。'),
    default: 6 * 60 * 60 * 1_000,
    defaultDisplay: '21600000',
    number: positive(),
  }),
  LARK_SESSION_HEALTH_MAX_NUDGES: numberConfig({
    ...messaging('Maximum health nudges per session episode.', '每个 session 阶段最多发送的健康提醒数。'),
    default: 3,
    defaultDisplay: '3',
    number: positive(),
  }),
  LARK_ACK_EMOJI: stringConfig({
    category: 'Acknowledgement',
    description: { en: 'Emoji reaction added when a message is received.', zh: '收到消息时添加的 emoji reaction。' },
    features: ['acknowledgement'],
    default: 'MeMeMe',
    defaultDisplay: 'MeMeMe',
    empty: 'preserve',
  }),
  LARK_DOC_COMMENT_ACK_EMOJI: stringConfig({
    category: 'Acknowledgement',
    description: { en: 'Persistent reaction for inbound document-comment mentions.', zh: '文档评论提及消息使用的持久 reaction。' },
    features: ['acknowledgement', 'doc-comment'],
    default: 'THUMBSUP',
    defaultDisplay: 'THUMBSUP',
    empty: 'preserve',
  }),
  LARK_BOT_MESSAGE_TRACKER_SIZE: numberConfig({
    category: 'Acknowledgement',
    description: { en: 'Maximum bot message IDs retained for routing and mutation guards.', zh: '为路由与消息变更保护保留的 bot message ID 上限。' },
    features: ['reactions', 'message-mutation'],
    default: 500,
    defaultDisplay: '500',
    number: nonNegative(),
  }),
  LARK_FEISHU_API_TIMEOUT_MS: numberConfig({
    ...reliability('Timeout for one Feishu API call.', '单次飞书 API 调用超时。'),
    default: 30_000,
    defaultDisplay: '30000',
    number: nonNegative(),
  }),
  LARK_FEISHU_API_RETRY_ATTEMPTS: numberConfig({
    ...reliability('Attempts for retryable Feishu API failures.', '飞书 API 可重试失败的尝试次数。'),
    default: 3,
    defaultDisplay: '3',
    number: positive(),
  }),
  LARK_FEISHU_API_RETRY_BASE_DELAY_MS: numberConfig({
    ...reliability('Base delay for exponential Feishu API retries.', '飞书 API 指数退避重试的基础延迟。'),
    default: 250,
    defaultDisplay: '250',
    number: nonNegative(),
  }),
  LARK_DOWNLOAD_MAX_BYTES: numberConfig({
    ...reliability('Maximum bytes accepted for one downloaded attachment.', '单个下载附件允许的最大字节数。'),
    default: 25 * 1_024 * 1_024,
    defaultDisplay: '26214400',
    number: positive(),
  }),
  LARK_DOWNLOAD_TIMEOUT_MS: numberConfig({
    ...reliability('Attachment and image download timeout.', '附件和图片下载超时。'),
    default: 60_000,
    defaultDisplay: '60000',
    number: nonNegative(),
  }),
  LARK_CRON_SCAN_INTERVAL: numberConfig({
    category: 'CronJob',
    description: { en: 'Cron schedule scan interval in seconds.', zh: 'Cron 调度扫描间隔（秒）。' },
    features: ['cron'],
    default: 60,
    defaultDisplay: '60',
    number: positive(),
  }),
  LARK_CRON_TIMEZONE: stringConfig({
    category: 'CronJob',
    description: { en: 'Default IANA timezone for new CronJobs and local logs.', zh: '新 CronJob 与本地日志使用的默认 IANA 时区。' },
    features: ['cron', 'logging'],
    default: ({ systemTimezone }) => systemTimezone,
    defaultDisplay: 'system timezone',
    empty: 'default',
  }),
  LARK_MIN_SEARCH_SCORE: numberConfig({
    ...memory('Minimum relevance score for episode search results.', 'episode 搜索结果的最低相关度分数。'),
    default: 0.3,
    defaultDisplay: '0.3',
    number: nonNegative(),
  }),
  LARK_MAX_SEARCH_RESULTS: numberConfig({
    ...memory('Maximum episode search results injected into a turn.', '单个回合最多注入的 episode 搜索结果数。'),
    default: 2,
    defaultDisplay: '2',
    number: positive(),
  }),
  LARK_INACTIVITY_HOURS: numberConfig({
    ...memory('Inactivity threshold before flushing buffered conversation memory.', '刷新缓冲会话记忆前的空闲小时数阈值。'),
    default: 3,
    defaultDisplay: '3',
    number: positive(),
  }),
  LARK_MAX_EPISODE_BYTES: numberConfig({
    ...memory('Maximum bytes persisted in one episode file.', '单个 episode 文件持久化的最大字节数。'),
    default: 64 * 1_024,
    defaultDisplay: '65536',
    number: nonNegative(),
  }),
  LARK_MAX_EPISODE_FILES_PER_SCOPE: numberConfig({
    ...memory('Maximum episode files retained per chat or thread scope.', '每个会话或话题范围保留的 episode 文件上限。'),
    default: 200,
    defaultDisplay: '200',
    number: nonNegative(),
  }),
  LARK_MAX_EPISODE_SCOPE_BYTES: numberConfig({
    ...memory('Maximum total episode bytes retained per scope.', '每个范围保留的 episode 总字节数上限。'),
    default: 10 * 1_024 * 1_024,
    defaultDisplay: '10485760',
    number: nonNegative(),
  }),
  LARK_PROFILE_DISTILLATION_ENABLED: booleanConfig({
    ...memory('Enable profile distillation from recent episodes.', '启用从近期 episode 进行 profile 提炼。'),
    default: false,
    defaultDisplay: 'false',
  }),
  LARK_PROFILE_DISTILLATION_MIN_EPISODES: numberConfig({
    ...memory('Minimum episodes required before profile distillation.', '启动 profile 提炼所需的最少 episode 数。'),
    default: 3,
    defaultDisplay: '3',
    number: positive(),
  }),
  LARK_PROFILE_DISTILLATION_MAX_EPISODES: numberConfig({
    ...memory('Maximum recent episodes included in one distillation prompt.', '单次提炼 prompt 包含的近期 episode 上限。'),
    default: 5,
    defaultDisplay: '5',
    number: positive(),
  }),
  LARK_PROFILE_DISTILLATION_COOLDOWN_MS: numberConfig({
    ...memory('Per-user cooldown between profile distillation dispatches.', '每个用户两次 profile 提炼之间的冷却时间。'),
    default: 24 * 60 * 60 * 1_000,
    defaultDisplay: '86400000',
    number: nonNegative(),
  }),
  LARK_MEMORY_DEDUP_WINDOW_MS: numberConfig({
    ...memory('Window for suppressing unchanged memory blocks.', '抑制未变化记忆块的时间窗口。'),
    default: 30 * 60 * 1_000,
    defaultDisplay: '1800000',
    number: nonNegative(),
  }),
  LARK_OWNER_OPEN_ID: stringConfig({
    category: 'Identity',
    description: { en: 'Immutable operator identity and terminal-skill trust root.', zh: '不可变的 operator 身份与终端 skill 信任根。' },
    features: ['identity', 'authorization'],
    default: null,
    defaultDisplay: '(empty)',
    empty: 'null',
    nullable: true,
  }),
  LARK_IDENTITY_SESSION_TTL_MS: numberConfig({
    category: 'Identity',
    description: { en: 'Lifetime of server-derived caller identity sessions.', zh: '服务端派生调用者身份 session 的生命周期。' },
    features: ['identity'],
    default: (context) =>
      Math.max(2 * 60 * 60 * 1_000, Number(context.get('LARK_INACTIVITY_HOURS')) * 2 * 60 * 60 * 1_000),
    defaultDisplay: 'max(2h, LARK_INACTIVITY_HOURS x 2h)',
    number: positive(),
  }),
  LARK_IDENTITY_SESSION_MAX_ENTRIES: numberConfig({
    category: 'Identity',
    description: { en: 'Maximum server-derived caller identity session entries.', zh: '服务端派生调用者身份 session 条目上限。' },
    features: ['identity'],
    default: 5_000,
    defaultDisplay: '5000',
    number: positive(),
  }),
  LARK_AUDIT_LOG: stringConfig({
    category: 'Privacy',
    description: { en: 'Path of the append-only sensitive-operation audit log.', zh: '敏感操作追加式审计日志的路径。' },
    features: ['audit'],
    default: ({ homeDir }) => path.join(homeDir, '.codex', 'channels', 'lark', 'logs', 'audit.log'),
    defaultDisplay: '~/.codex/channels/lark/logs/audit.log',
    empty: 'default',
  }),
  LARK_CARD_CONTEXT_CACHE_SIZE: numberConfig({
    category: 'Quoted cards',
    description: { en: 'Maximum cached parent or root card contexts.', zh: '缓存的父级或根卡片上下文上限。' },
    features: ['quoted-context'],
    default: 200,
    defaultDisplay: '200',
    number: nonNegative(),
  }),
  LARK_CARD_CONTEXT_CACHE_TTL_MS: numberConfig({
    category: 'Quoted cards',
    description: { en: 'Lifetime of fetched card context cache entries.', zh: '已拉取卡片上下文缓存条目的生命周期。' },
    features: ['quoted-context'],
    default: 30 * 60 * 1_000,
    defaultDisplay: '1800000',
    number: nonNegative(),
  }),
  LARK_QUOTED_CONTEXT_MAX_DEPTH: numberConfig({
    category: 'Quoted cards',
    description: { en: 'Maximum quoted-message chain depth hydrated for Codex.', zh: '为 Codex 补齐的引用消息链最大深度。' },
    features: ['quoted-context'],
    default: 4,
    defaultDisplay: '4',
    number: positive(),
  }),
  LARK_QUOTED_CONTEXT_MAX_BYTES: numberConfig({
    category: 'Quoted cards',
    description: { en: 'UTF-8 byte budget for hydrated quoted-message context.', zh: '补齐后的引用消息上下文 UTF-8 字节预算。' },
    features: ['quoted-context'],
    default: 12_000,
    defaultDisplay: '12000',
    number: positive(),
  }),
  LARK_QUOTED_CARD_USER_FETCH_ENABLED: booleanConfig({
    category: 'Quoted cards',
    description: { en: 'Allow user-identity fallback when bot card hydration fails.', zh: 'bot 身份补齐卡片失败时允许使用 user 身份回退。' },
    features: ['quoted-context'],
    default: true,
    defaultDisplay: 'true',
  }),
  LARK_QUOTED_CARD_USER_FETCH_COMMAND: stringConfig({
    category: 'Quoted cards',
    description: { en: 'lark-cli command used for quoted-card user fallback.', zh: '引用卡片 user 身份回退使用的 lark-cli 命令。' },
    features: ['quoted-context'],
    default: 'lark-cli',
    defaultDisplay: 'lark-cli',
    empty: 'default',
  }),
  LARK_QUOTED_CARD_USER_FETCH_TIMEOUT_MS: numberConfig({
    category: 'Quoted cards',
    description: { en: 'Timeout for quoted-card user-identity fallback.', zh: '引用卡片 user 身份回退的超时。' },
    features: ['quoted-context'],
    default: 10_000,
    defaultDisplay: '10000',
    number: positive(),
  }),
  LARK_QUOTED_CARD_USER_FETCH_MAX_BYTES: numberConfig({
    category: 'Quoted cards',
    description: { en: 'Maximum output bytes captured from quoted-card user fallback.', zh: '引用卡片 user 身份回退可捕获的最大输出字节数。' },
    features: ['quoted-context'],
    default: 256 * 1_024,
    defaultDisplay: '262144',
    number: positive(),
  }),
  LARK_DEBUG_LOG: stringConfig({
    ...resources('Path of the local runtime debug log.', '本地运行时 debug 日志路径。'),
    default: ({ homeDir }) => path.join(homeDir, '.codex', 'channels', 'lark', 'logs', 'debug.log'),
    defaultDisplay: '~/.codex/channels/lark/logs/debug.log',
    empty: 'default',
  }),
  LARK_LOG_MAX_BYTES: numberConfig({
    ...resources('Log size threshold before rotation.', '触发日志轮转的文件大小阈值。'),
    default: 5 * 1_024 * 1_024,
    defaultDisplay: '5242880',
    number: nonNegative(),
  }),
  LARK_LOG_MAX_FILES: numberConfig({
    ...resources('Number of rotated log files retained.', '保留的轮转日志文件数。'),
    default: 5,
    defaultDisplay: '5',
    number: nonNegative(),
  }),
  LARK_LOG_ARCHIVE_RETENTION_MONTHS: numberConfig({
    ...resources('Number of monthly log archive directories retained.', '保留的月度日志归档目录数。'),
    default: 6,
    defaultDisplay: '6',
    number: nonNegative(),
  }),
  LARK_INBOX_MAX_AGE_HOURS: numberConfig({
    ...resources('Maximum age of downloaded inbox files during cleanup.', '清理时下载 inbox 文件允许保留的最大小时数。'),
    default: 168,
    defaultDisplay: '168',
    number: nonNegative(),
  }),
  LARK_INBOX_MAX_BYTES: numberConfig({
    ...resources('LRU byte cap for downloaded inbox files.', '下载 inbox 文件的 LRU 字节上限。'),
    default: 200 * 1_024 * 1_024,
    defaultDisplay: '209715200',
    number: nonNegative(),
  }),
  LARK_NAME_CACHE_SIZE: numberConfig({
    ...resources('Maximum cached user and chat display names.', '缓存的用户与会话显示名称上限。'),
    default: 1_000,
    defaultDisplay: '1000',
    number: nonNegative(),
  }),
  LARK_CHAT_TYPE_CACHE_SIZE: numberConfig({
    ...resources('Maximum cached Feishu chat types.', '缓存的飞书会话类型上限。'),
    default: 1_000,
    defaultDisplay: '1000',
    number: nonNegative(),
  }),
  LARK_LATEST_MESSAGE_TRACKER_SIZE: numberConfig({
    ...resources('Maximum latest-inbound-message tracker entries.', '最新入站消息追踪器的条目上限。'),
    default: 1_000,
    defaultDisplay: '1000',
    number: nonNegative(),
  }),
} as const satisfies Record<string, ConfigDefinition>;

export type ConfigKey = keyof typeof configSchema;

type ValueForDefinition<T> =
  T extends { type: 'number' }
    ? number
    : T extends { type: 'boolean' }
      ? boolean
      : T extends { type: 'choice'; choices: readonly (infer C extends string)[] }
        ? C
        : T extends { type: 'string'; nullable: true }
          ? string | null
          : string;

export type ConfigValues = {
  [K in ConfigKey]: ValueForDefinition<(typeof configSchema)[K]>;
};

export const configSchemaKeys = Object.keys(configSchema).sort() as ConfigKey[];

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

function validateNumber(key: ConfigKey, value: number, definition: NumberDefinition): number {
  const rules = definition.number;
  const belowMinimum =
    rules.minimum !== undefined &&
    (rules.exclusiveMinimum ? value <= rules.minimum : value < rules.minimum);
  const aboveMaximum = rules.maximum !== undefined && value > rules.maximum;
  if ((rules.integer && !Number.isInteger(value)) || belowMinimum || aboveMaximum) {
    throw new Error(`Invalid ${key}: ${value}. ${rules.message}`);
  }
  return value;
}

export function readConfigValues(options?: {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  systemTimezone?: string;
  dryRun?: boolean;
}): ConfigValues {
  const env = options?.env ?? process.env;
  const homeDir = options?.homeDir ?? os.homedir();
  const systemTimezone =
    options?.systemTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dryRun = options?.dryRun ?? false;
  const values = new Map<ConfigKey, ConfigPrimitive>();
  const resolving = new Set<ConfigKey>();

  const context: ConfigResolutionContext = {
    homeDir,
    systemTimezone,
    get: (key) => resolve(key as ConfigKey),
  };

  function defaultValue(key: ConfigKey, definition: ConfigDefinition): ConfigPrimitive {
    const configuredDefault = 'default' in definition ? definition.default : undefined;
    if (configuredDefault === undefined) {
      if (dryRun && (key === 'LARK_APP_ID' || key === 'LARK_APP_SECRET')) {
        return `dry_run_${key.toLowerCase()}`;
      }
      throw new Error(`Missing required env var: ${key}`);
    }
    return typeof configuredDefault === 'function'
      ? configuredDefault(context)
      : configuredDefault;
  }

  function resolve(key: ConfigKey): ConfigPrimitive {
    if (values.has(key)) return values.get(key)!;
    if (resolving.has(key)) throw new Error(`Circular configuration default dependency: ${key}`);
    resolving.add(key);
    try {
      const definition = configSchema[key] as ConfigDefinition;
      const raw = env[key];
      let value: ConfigPrimitive;

      if (definition.type === 'string') {
        if (raw === undefined || (raw === '' && definition.empty !== 'preserve')) {
          value = definition.empty === 'null' ? null : defaultValue(key, definition);
        } else {
          value = raw;
        }
        if (definition.absolutePath && typeof value === 'string' && !path.isAbsolute(value)) {
          throw new Error(`Invalid ${key}: expected an absolute path.`);
        }
      } else if (raw === undefined || raw === '') {
        value = defaultValue(key, definition);
      } else if (definition.type === 'number') {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) {
          throw new Error(`Invalid ${key}: ${raw}. Expected a number.`);
        }
        value = validateNumber(key, parsed, definition);
      } else if (definition.type === 'boolean') {
        const normalized = raw.toLowerCase();
        if (TRUE_VALUES.has(normalized)) value = true;
        else if (FALSE_VALUES.has(normalized)) value = false;
        else {
          throw new Error(
            `Invalid ${key}: ${raw}. Expected one of: true, false, 1, 0, yes, no, on, off.`,
          );
        }
      } else {
        if (!(definition.choices as readonly string[]).includes(raw)) {
          throw new Error(
            `Invalid ${key}: ${raw}. Expected one of: ${definition.choices.join(', ')}`,
          );
        }
        value = raw;
      }

      if (definition.type === 'number') {
        value = validateNumber(key, Number(value), definition);
        if (definition.normalize) value = definition.normalize(Number(value), context);
      }
      values.set(key, value);
      return value;
    } finally {
      resolving.delete(key);
    }
  }

  for (const key of configSchemaKeys) resolve(key);
  return Object.fromEntries(values) as ConfigValues;
}
