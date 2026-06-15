import type * as Lark from '@larksuiteoapi/node-sdk';
import { feishuApiCall } from './feishu-retry.js';

export async function downloadResourceViaRaw(
  raw: Lark.Client,
  messageId: string,
  fileKey: string,
  resourceType: 'image' | 'file',
): Promise<unknown> {
  return await feishuApiCall(
    'lark_transport.messageResource.get',
    () =>
      raw.im.v1.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: resourceType },
      }),
  );
}

export async function uploadImageViaRaw(raw: Lark.Client, data: Buffer): Promise<string | undefined> {
  const resp = await feishuApiCall('lark_transport.image.create', () =>
    raw.im.v1.image.create({
      data: {
        image_type: 'message',
        image: data as any,
      },
    }),
    { retryTimeout: false },
  );
  return (resp as any)?.data?.image_key ?? (resp as any)?.image_key;
}

export async function uploadFileViaRaw(
  raw: Lark.Client,
  data: Buffer,
  fileName: string,
): Promise<string | undefined> {
  const resp = await feishuApiCall('lark_transport.file.create', () =>
    raw.im.v1.file.create({
      data: {
        file_type: 'stream',
        file_name: fileName,
        file: data as any,
      },
    }),
    { retryTimeout: false },
  );
  return (resp as any)?.data?.file_key ?? (resp as any)?.file_key;
}
