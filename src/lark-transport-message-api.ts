import type * as Lark from '@larksuiteoapi/node-sdk';
import { randomUUID } from 'node:crypto';
import { feishuApiCall } from './feishu-retry.js';
import type {
  LarkTransportInput,
  LarkTransportSendRequest,
  LarkTransportSendResult,
} from './lark-transport-contracts.js';

export function serializeTransportInput(input: LarkTransportInput): { msg_type: string; content: string } {
  if ('text' in input) {
    return { msg_type: 'text', content: JSON.stringify({ text: input.text }) };
  }
  if ('card' in input) {
    return { msg_type: 'interactive', content: JSON.stringify(input.card) };
  }
  if ('imageKey' in input) {
    return { msg_type: 'image', content: JSON.stringify({ image_key: input.imageKey }) };
  }
  if ('fileKey' in input) {
    return {
      msg_type: 'file',
      content: JSON.stringify({ file_key: input.fileKey, file_name: input.fileName }),
    };
  }
  return { msg_type: input.raw.msgType, content: input.raw.content };
}

export function rawMessageId(resp: any): string | undefined {
  return resp?.data?.message_id ?? resp?.message_id;
}

export async function sendMessageViaRaw(
  raw: Lark.Client,
  request: LarkTransportSendRequest,
): Promise<LarkTransportSendResult> {
  const payload = serializeTransportInput(request.input);
  const uuid = request.uuid ?? randomUUID();
  if (request.replyTo) {
    const resp = await feishuApiCall('lark_transport.message.reply', () =>
      raw.im.v1.message.reply({
        path: { message_id: request.replyTo! },
        data: {
          content: payload.content,
          msg_type: payload.msg_type,
          ...(request.replyInThread ? { reply_in_thread: true } : {}),
          uuid,
        } as any,
      }),
      request.retry,
    );
    return { messageId: rawMessageId(resp) };
  }

  const resp = await feishuApiCall('lark_transport.message.create', () =>
    raw.im.v1.message.create({
      params: { receive_id_type: request.receiveIdType ?? 'chat_id' },
      data: {
        receive_id: request.chatId,
        content: payload.content,
        msg_type: payload.msg_type,
        uuid,
      },
    }),
    request.retry,
  );
  return { messageId: rawMessageId(resp) };
}

export async function editMessageViaRaw(
  raw: Lark.Client,
  request: { messageId: string; text: string },
): Promise<void> {
  await feishuApiCall('lark_transport.message.patch.text', () =>
    raw.im.v1.message.patch({
      path: { message_id: request.messageId },
      data: { content: JSON.stringify({ text: request.text }) },
    }),
    { retryTimeout: false },
  );
}

export async function updateCardViaRaw(
  raw: Lark.Client,
  request: { messageId: string; card: object | string },
): Promise<void> {
  const content = typeof request.card === 'string' ? request.card : JSON.stringify(request.card);
  await feishuApiCall('lark_transport.message.patch.card', () =>
    raw.im.v1.message.patch({
      path: { message_id: request.messageId },
      data: { content },
    }),
    { retryTimeout: false },
  );
}

export async function recallMessageViaRaw(raw: Lark.Client, messageId: string): Promise<void> {
  await feishuApiCall('lark_transport.message.delete', () =>
    raw.im.v1.message.delete({
      path: { message_id: messageId },
    }),
    { retryTimeout: false },
  );
}
