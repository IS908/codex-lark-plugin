import assert from 'node:assert/strict';
import {
  extractMessageAttachments,
  extractMessageText,
  fetchedMessageContentText,
  messageItemText,
  normalizeFetchedMessageText,
  resolveMentionPlaceholders,
} from '../src/message-content.js';

const legacyCard = {
  title: { content: 'Incident Report' },
  elements: [
    {
      tag: 'div',
      text: {
        tag: 'lark_md',
        content: '**Status:** mitigated\nOwner: @oncall',
      },
    },
    {
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: 'Acknowledge' },
          confirm: {
            title: { tag: 'plain_text', content: 'Dangerous Confirm Title' },
          },
          url: 'https://internal.example.com/secrets',
          value: { token: 'secret_token_123' },
        },
      ],
    },
  ],
};

{
  const text = extractMessageText(JSON.stringify(legacyCard), 'interactive');
  assert.match(text, /Incident Report/);
  assert.match(text, /Status:\*\* mitigated|Status:\s*mitigated/);
  assert.match(text, /Owner: @oncall/);
  assert.match(text, /Acknowledge/);
  assert.doesNotMatch(text, /secret_token_123/);
  assert.doesNotMatch(text, /internal\.example\.com/);
  assert.doesNotMatch(text, /Dangerous Confirm Title/);
}

{
  const post = {
    content: [
      [
        { tag: 'text', text: 'Hello ' },
        { tag: 'a', text: 'docs', href: 'https://example.com' },
        { tag: 'img', image_key: 'img_1' },
      ],
      [{ tag: 'text', text: '@_user_1 please review' }],
    ],
  };
  const text = resolveMentionPlaceholders(
    extractMessageText(JSON.stringify(post), 'post'),
    [{ id: 'ou_alice', name: 'Alice' }],
  );
  assert.equal(text, 'Hello docs\n@Alice please review');
}

{
  assert.equal(normalizeFetchedMessageText('<card title="Build Result"><p>passed<br>details</p></card>'), 'Build Result\npassed\ndetails');
  assert.equal(
    fetchedMessageContentText(
      JSON.stringify({
        header: { title: { tag: 'plain_text', content: 'SDK Card' } },
        elements: [{ tag: 'div', text: { tag: 'plain_text', content: 'JSON body' } }],
      }),
      'interactive',
    ),
    'SDK Card\nJSON body',
  );
  assert.equal(
    fetchedMessageContentText('<card title="Compact Card"><p>compact<br>body</p></card>', 'interactive'),
    'Compact Card\ncompact\nbody',
  );
  const item = {
    msg_type: 'text',
    body: { content: JSON.stringify({ text: '@_user_1 approved' }) },
    mentions: [{ id: { open_id: 'ou_bob' }, name: 'Bob' }],
  };
  assert.deepEqual(messageItemText(item), { text: '@Bob approved', messageType: 'text' });
}

{
  assert.deepEqual(
    extractMessageAttachments({ message_type: 'image', content: JSON.stringify({ image_key: 'img_1' }) }),
    [{ fileKey: 'img_1', fileName: 'image.png', fileType: 'image' }],
  );
  assert.deepEqual(
    extractMessageAttachments({ message_type: 'file', content: JSON.stringify({ file_key: 'file_1', file_name: 'report.pdf' }) }),
    [{ fileKey: 'file_1', fileName: 'report.pdf', fileType: 'file' }],
  );
  assert.deepEqual(
    extractMessageAttachments({ message_type: 'audio', content: JSON.stringify({ file_key: 'audio_1' }) }),
    [{ fileKey: 'audio_1', fileName: 'audio', fileType: 'audio' }],
  );
  assert.deepEqual(
    extractMessageAttachments({ message_type: 'video', content: JSON.stringify({ file_key: 'video_1' }) }),
    [{ fileKey: 'video_1', fileName: 'video', fileType: 'video' }],
  );
}

console.log('message-content smoke: PASS');
