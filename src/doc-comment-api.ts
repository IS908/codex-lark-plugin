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
