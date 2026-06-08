import assert from 'node:assert/strict';

process.env.LARK_APP_ID ||= 'cli_test_app_id';
process.env.LARK_APP_SECRET ||= 'test_app_secret';
process.env.LARK_ALLOWED_USER_IDS = '';
process.env.LARK_ALLOWED_CHAT_IDS = '';

const { LarkChannel } = await import('../src/channel.js');

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(predicate(), true, 'timed out waiting for queued message handler');
}

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
  const channel = new LarkChannel();
  const text = (channel as any).extractText(JSON.stringify(legacyCard), 'interactive');
  assert.match(text, /Incident Report/);
  assert.match(text, /Status:\*\* mitigated|Status:\s*mitigated/);
  assert.match(text, /Owner: @oncall/);
  assert.match(text, /Acknowledge/);
  assert.doesNotMatch(text, /secret_token_123/);
  assert.doesNotMatch(text, /internal\.example\.com/);
  assert.doesNotMatch(text, /Dangerous Confirm Title/);
}

{
  const channel = new LarkChannel();
  const text = (channel as any).extractText(JSON.stringify({ config: {} }), 'interactive');
  assert.equal(text, '[Interactive Card]');
}

{
  const channel = new LarkChannel();
  let captured: any;
  channel.setMessageHandler(async (message: any) => {
    captured = message;
  });
  (channel as any).nameCache.set('ou_quote_card', 'Quote Tester');
  (channel as any).client = {
    im: {
      v1: {
        message: {
          get: async (args: any) => {
            assert.equal(args.path.message_id, 'om_parent_card');
            return {
              data: {
                items: [
                  {
                    msg_type: 'interactive',
                    body: {
                      content: JSON.stringify({
                        header: {
                          title: { tag: 'plain_text', content: 'Deployment Summary' },
                          subtitle: { tag: 'plain_text', content: 'prod / build 42' },
                        },
                        body: {
                          elements: [
                            {
                              tag: 'markdown',
                              content: 'Roll back completed for **api-gateway**.',
                            },
                            {
                              tag: 'button',
                              text: { tag: 'plain_text', content: 'View Details' },
                              behaviors: [
                                {
                                  type: 'open_url',
                                  default_url: 'https://internal.example.com/deploy/42',
                                },
                              ],
                            },
                          ],
                        },
                      }),
                    },
                    mentions: [],
                  },
                ],
              },
            };
          },
        },
        messageReaction: {
          create: async () => ({ data: { reaction_id: 'reaction_quote_card' } }),
          delete: async () => ({}),
        },
      },
    },
  };

  await (channel as any).handleMessageEvent({
    message: {
      message_id: 'om_child_quote',
      chat_id: 'oc_quote_card',
      chat_type: 'p2p',
      content: JSON.stringify({ text: 'what does this mean?' }),
      message_type: 'text',
      parent_id: 'om_parent_card',
      root_id: 'omt_quote_card',
    },
    sender: { sender_id: { open_id: 'ou_quote_card' } },
  });

  await waitFor(() => Boolean(captured));
  assert.match(captured.text, /\[Quoted Message\]/);
  assert.match(captured.text, /Deployment Summary/);
  assert.match(captured.text, /prod \/ build 42/);
  assert.match(captured.text, /Roll back completed for \*\*api-gateway\*\*\./);
  assert.match(captured.text, /View Details/);
  assert.doesNotMatch(captured.text, /internal\.example\.com/);
}

console.log('PASS');
