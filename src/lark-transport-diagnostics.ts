import { redactErrorForLog } from './safe-log.js';

export type SdkFallbackBehavior =
  | 'fallback-to-raw'
  | 'fail-closed'
  | 'best-effort-raw-context'
  | 'raw-only';

export type SdkFallbackOperation =
  | 'send'
  | 'recall'
  | 'edit_message'
  | 'update_card'
  | 'add_reaction'
  | 'remove_reaction'
  | 'remove_reaction_by_emoji'
  | 'download_resource'
  | 'fetch_message_text'
  | 'doc_comment';

export interface SdkFallbackPolicy {
  operation: SdkFallbackOperation;
  behavior: SdkFallbackBehavior;
  rawFallback: boolean;
}

export const SDK_FALLBACK_POLICIES: SdkFallbackPolicy[] = [
  { operation: 'send', behavior: 'fallback-to-raw', rawFallback: true },
  { operation: 'recall', behavior: 'fallback-to-raw', rawFallback: true },
  { operation: 'edit_message', behavior: 'fail-closed', rawFallback: false },
  { operation: 'update_card', behavior: 'fail-closed', rawFallback: false },
  { operation: 'add_reaction', behavior: 'fail-closed', rawFallback: false },
  { operation: 'remove_reaction', behavior: 'fail-closed', rawFallback: false },
  { operation: 'remove_reaction_by_emoji', behavior: 'fail-closed', rawFallback: false },
  { operation: 'download_resource', behavior: 'fail-closed', rawFallback: false },
  { operation: 'fetch_message_text', behavior: 'best-effort-raw-context', rawFallback: true },
  { operation: 'doc_comment', behavior: 'raw-only', rawFallback: false },
];

function valuePart(name: string, value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return `${name}=${String(value)}`;
}

function safeJsonPart(name: string, value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  try {
    return `${name}=${JSON.stringify(value)}`;
  } catch {
    return null;
  }
}

export function sdkFallbackPolicy(operation: SdkFallbackOperation): SdkFallbackPolicy {
  const policy = SDK_FALLBACK_POLICIES.find((candidate) => candidate.operation === operation);
  if (!policy) {
    throw new Error(`Unknown SDK fallback operation: ${operation}`);
  }
  return policy;
}

export function sdkFailureDiagnostic(err: unknown): string {
  const direct = redactErrorForLog(err);
  const raw = err as any;
  const cause = redactErrorForLog(raw?.cause);
  const directRecord = direct && typeof direct === 'object' ? (direct as any) : {};
  const causeRecord = cause && typeof cause === 'object' ? (cause as any) : {};
  const feishu = directRecord.feishu ?? causeRecord.feishu;
  const parts = [
    valuePart('name', directRecord.name ?? raw?.name),
    valuePart('message', directRecord.message ?? raw?.message ?? String(err)),
    valuePart('code', directRecord.code ?? raw?.code),
    valuePart('status', directRecord.status ?? causeRecord.status),
    valuePart('feishu_code', feishu?.code),
    valuePart('feishu_msg', feishu?.msg),
    safeJsonPart('context', raw?.context),
    safeJsonPart('cause', cause),
  ].filter((part): part is string => !!part);
  return parts.join(' ');
}

export function formatSdkFallbackLog(operation: SdkFallbackOperation, err: unknown): string {
  return `[lark-transport] SDK ${operation} failed; falling back to raw OpenAPI ${sdkFailureDiagnostic(err)}`;
}
