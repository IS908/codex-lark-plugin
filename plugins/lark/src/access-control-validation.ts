import type * as Lark from '@larksuiteoapi/node-sdk';
import { feishuApiCall, getFeishuApiCode } from './feishu-retry.js';
import type { AccessControlAction, AccessControlListName } from './runtime-access-control.js';

export interface AccessControlValidationInput {
  action: AccessControlAction;
  list: AccessControlListName;
  value: string;
  currentChatId: string;
  currentChatType?: string;
  validateChatAccess?: (chatId: string) => Promise<void>;
}

export interface AccessControlValidationResult {
  action: AccessControlAction;
  list: AccessControlListName;
  value: string;
  resolvedFromCurrentChat: boolean;
}

const CURRENT_CHAT_REFERENCES = new Set([
  'current',
  'here',
  'current_chat',
  'current-chat',
  'this_chat',
  'this-chat',
  '当前群聊',
  '当前群聊id',
  '当前群',
  '本群',
  '这里',
]);

function isCurrentChatReference(value: string): boolean {
  return CURRENT_CHAT_REFERENCES.has(value.trim().toLowerCase());
}

function isUserId(value: string): boolean {
  return /^ou_[A-Za-z0-9_-]+$/.test(value);
}

function isChatId(value: string): boolean {
  return /^oc_[A-Za-z0-9_-]+$/.test(value);
}

function chatAccessError(chatId: string, err: unknown): Error {
  const code = getFeishuApiCode(err);
  const message = err instanceof Error ? err.message : String(err);
  if (/permission|forbidden|not\s*authorized|visibility|access/i.test(message) || code === 99991672) {
    return new Error(`Chat ${chatId} exists but is not accessible to this app. Check bot membership and Feishu app permissions.`);
  }
  if (/not\s*found|不存在|does\s*not\s*exist/i.test(message)) {
    return new Error(`Chat ${chatId} does not exist.`);
  }
  return new Error(`Chat ${chatId} does not exist or is not accessible to this app: ${message}`);
}

export async function validateFeishuChatAccess(raw: Lark.Client, chatId: string): Promise<void> {
  try {
    await feishuApiCall(
      'access_control.chat.get',
      () => raw.im.v1.chat.get({ path: { chat_id: chatId } }),
      { retryTimeout: false },
    );
  } catch (err) {
    throw chatAccessError(chatId, err);
  }
}

export async function validateAccessControlMutation(
  input: AccessControlValidationInput,
): Promise<AccessControlValidationResult> {
  let value = input.value.trim();
  if (!value) throw new Error('access-control value must not be empty');

  let resolvedFromCurrentChat = false;
  if (input.list === 'allowed_chat_ids' || input.list === 'group_no_mention_chat_ids') {
    if (isCurrentChatReference(value)) {
      if (input.currentChatType !== 'group') {
        throw new Error('Current chat reference can only be used from a group chat.');
      }
      value = input.currentChatId;
      resolvedFromCurrentChat = true;
    }
    if (!isChatId(value)) {
      throw new Error('chat ID must use oc_... format.');
    }
    await input.validateChatAccess?.(value);
  } else if (!isUserId(value)) {
    throw new Error('user open_id must use ou_... format.');
  }

  return {
    action: input.action,
    list: input.list,
    value,
    resolvedFromCurrentChat,
  };
}

export function formatAccessControlMutationMessage(
  changed: boolean,
  action: AccessControlAction,
  list: AccessControlListName,
  _value: string,
): string {
  if (list === 'allowed_user_ids') {
    if (changed) return action === 'add' ? 'User access added.' : 'User access removed.';
    return action === 'add' ? 'User access already allowed.' : 'User access was not configured.';
  }
  if (list === 'allowed_chat_ids') {
    if (changed) return action === 'add' ? 'Chat access added.' : 'Chat access removed.';
    return action === 'add' ? 'Chat access already allowed.' : 'Chat access was not configured.';
  }

  if (changed) return action === 'add' ? 'No-mention mode enabled.' : 'No-mention mode disabled.';
  return action === 'add' ? 'No-mention mode already enabled.' : 'No-mention mode already disabled.';
}
