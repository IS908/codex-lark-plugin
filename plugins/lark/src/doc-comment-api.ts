import { feishuApiCall } from './feishu-retry.js';

export interface DocCommentHttpClient {
  request: (req: {
    method: 'POST';
    url: string;
    params: { file_type: string; user_id_type?: string };
    data: unknown;
  }) => Promise<{ data?: { reply_id?: string; comment_id?: string } }>;
}

export function buildCommentElements(content: string): unknown[] {
  const text = content.trim();
  if (!text) throw new Error('doc comment content cannot be empty');
  if (text.length > 1000) throw new Error('doc comment content cannot exceed 1000 characters');
  return [{ type: 'text_run', text_run: { text } }];
}

export function splitDocCommentText(content: string, maxLen = 1000): string[] {
  const text = content.trim();
  if (!text) return [];
  if (maxLen <= 0) throw new Error('maxLen must be positive');

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    const window = rest.slice(0, maxLen + 1);
    let cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf(' '));
    if (cut < Math.floor(maxLen * 0.6)) cut = maxLen;
    const chunk = rest.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

export async function postDocCommentReply(
  client: DocCommentHttpClient,
  args: {
    docToken: string;
    commentId: string;
    content: string;
    fileType: string;
  },
): Promise<{ data?: { reply_id?: string } }> {
  const elements = buildCommentElements(args.content);
  return (await feishuApiCall(
    'reply_doc_comment.create',
    () => client.request({
      method: 'POST',
      url: `https://open.feishu.cn/open-apis/drive/v1/files/${encodeURIComponent(args.docToken)}/comments/${encodeURIComponent(args.commentId)}/replies`,
      params: { file_type: args.fileType, user_id_type: 'open_id' },
      data: { content: { elements } },
    }),
    { retryTimeout: false },
  )) as { data?: { reply_id?: string } };
}
