import type * as Lark from '@larksuiteoapi/node-sdk';
import { buildCommentElements } from './doc-comment-api.js';
import { feishuApiCall } from './feishu-retry.js';
import type {
  LarkDocCommentReplyMarkerRequest,
  LarkDocCommentReplyRequest,
  LarkDocCommentRequest,
} from './lark-transport-contracts.js';

export async function replyDocCommentViaRaw(
  raw: Lark.Client,
  request: LarkDocCommentReplyRequest,
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
    request.retry ?? { retryTimeout: false },
  );
  return { replyId: (resp as any)?.data?.reply_id };
}

export async function findDocCommentReplyByMarkerViaRaw(
  raw: Lark.Client,
  request: LarkDocCommentReplyMarkerRequest,
): Promise<{ replyId?: string } | null> {
  let pageToken: string | undefined;
  for (let page = 0; page < 3; page += 1) {
    const response = await feishuApiCall(
      'lark_transport.doc_comment.reply.list',
      () => raw.request({
        method: 'GET',
        url: `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(request.docToken)}/comments/${encodeURIComponent(request.commentId)}/replies`,
        params: {
          file_type: request.fileType,
          user_id_type: 'open_id',
          need_reaction: false,
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      }),
      { retryTimeout: false },
    );
    const data = (response as any)?.data ?? {};
    const items = Array.isArray(data.items) ? data.items.slice(0, 50) : [];
    for (const item of items) {
      if (firstLine(commentReplyText(item)) === request.marker) {
        return { replyId: optionalText(item?.reply_id) };
      }
    }
    if (!data.has_more) return null;
    const nextPageToken = optionalText(data.page_token);
    if (!nextPageToken || nextPageToken === pageToken) return null;
    pageToken = nextPageToken;
  }
  return null;
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

function commentReplyText(item: unknown): string {
  const elements = (item as any)?.content?.elements;
  if (!Array.isArray(elements)) return '';
  const parts: string[] = [];
  for (const element of elements.slice(0, 100)) collectElementText(element, parts, 0);
  return parts.join('').trim();
}

function collectElementText(value: unknown, parts: string[], depth: number): void {
  if (depth > 5 || parts.length >= 200 || value === null || value === undefined) return;
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) collectElementText(item, parts, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.text === 'string') parts.push(record.text);
  for (const [key, child] of Object.entries(record)) {
    if (key === 'text' || key === 'reply_id') continue;
    collectElementText(child, parts, depth + 1);
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]?.trim() ?? '';
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
