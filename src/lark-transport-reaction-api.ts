import type * as Lark from '@larksuiteoapi/node-sdk';
import { feishuApiCall } from './feishu-retry.js';

export async function addReactionViaRaw(
  raw: Lark.Client,
  messageId: string,
  emojiType: string,
): Promise<string | undefined> {
  const resp = await feishuApiCall('lark_transport.reaction.create', () =>
    raw.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: {
        reaction_type: { emoji_type: emojiType },
      },
    }),
    { retryTimeout: false },
  );
  return (resp as any)?.data?.reaction_id;
}

export async function removeReactionViaRaw(
  raw: Lark.Client,
  messageId: string,
  reactionId: string,
): Promise<void> {
  await feishuApiCall('lark_transport.reaction.delete', () =>
    raw.im.v1.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }),
  );
}
