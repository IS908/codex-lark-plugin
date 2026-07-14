import type * as Lark from '@larksuiteoapi/node-sdk';
import { buildCommentElements } from './doc-comment-api.js';
import { feishuApiCall } from './feishu-retry.js';
import type { LarkDocCommentRequest } from './lark-transport-contracts.js';

export async function replyDocCommentViaRaw(
  raw: Lark.Client,
  request: Required<Pick<LarkDocCommentRequest, 'docToken' | 'commentId' | 'content' | 'fileType'>>,
): Promise<{ replyId?: string }> {
  const elements = buildCommentElements(request.content);
  const resp = await feishuApiCall(
    'lark_transport.doc_comment.reply',
    () => raw.request({
      method: 'POST',
      url: `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(request.docToken)}/comments/${encodeURIComponent(request.commentId)}/replies`,
      params: { file_type: request.fileType, user_id_type: 'open_id' },
      data: { content: { elements } },
    }),
    { retryTimeout: false },
  );
  return { replyId: (resp as any)?.data?.reply_id };
}

export async function createDocCommentViaRaw(
  raw: Lark.Client,
  request: Omit<LarkDocCommentRequest, 'commentId'>,
): Promise<{ commentId?: string }> {
  const elements = buildCommentElements(request.content);
  const resp = await feishuApiCall(
    'lark_transport.doc_comment.create',
    () => raw.request({
      method: 'POST',
      url: `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(request.docToken)}/comments`,
      params: { file_type: request.fileType, user_id_type: 'open_id' },
      data: { reply_list: { replies: [{ content: { elements } }] } },
    }),
    { retryTimeout: false },
  );
  return { commentId: (resp as any)?.data?.comment_id };
}
