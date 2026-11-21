import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function probeCodexExecWithLoopback(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  overrides: string[];
  command: string;
  marker: string;
  authorization?: string;
  launch?: (transportOverrides: string[], loopbackBaseUrl: string) => Promise<string>;
}): Promise<void> {
  const callId = `call_managed_git_fixture_${randomBytes(8).toString('hex')}`;
  const itemId = randomBytes(8).toString('hex');
  let requests = 0;
  let handlerFailure: unknown;
  // Scripted local responses with no upstream forwarding or real credentials.
  const server = createServer(async (request, response) => {
    try {
      const route = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (input.authorization && request.method === 'GET' && route === '/v1/models') {
        assert.ok(request.headers.authorization === input.authorization || request.headers.authorization === undefined, 'Unexpected fixture authorization.');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ models: [], data: [] }));
        return;
      }
      assert.equal(request.method, 'POST', `Unexpected fixture route: ${route}`);
      assert.equal(request.url, '/v1/responses');
      assert.ok(request.headers.authorization === input.authorization, 'Unexpected fixture authorization.');
      let raw = '';
      request.setEncoding('utf8');
      for await (const chunk of request) {
        raw += chunk;
        assert.ok(raw.length < 2 * 1024 * 1024, 'Fixture request exceeded its size limit.');
      }
      const body = JSON.parse(raw);
      const id = `resp_managed_git_${itemId}_${++requests}`;
      let item;
      if (requests === 1) {
        const tool = body.tools?.find((entry: { name?: string }) => entry.name === 'exec_command' || entry.name === 'shell_command');
        assert.ok(tool, 'Codex did not advertise an expected shell function.');
        const args = tool.name === 'exec_command' ? { cmd: input.command } : { command: input.command };
        item = { type: 'function_call', id: `fc_managed_git_${itemId}`, name: tool.name, call_id: callId,
          arguments: JSON.stringify(args), status: 'completed' };
      } else {
        assert.equal(requests, 2);
        const result = body.input?.find((entry: { type?: string; call_id?: string }) =>
          entry.type === 'function_call_output' && entry.call_id === callId);
        const output = JSON.stringify(result?.output ?? null);
        assert.ok(output.includes(input.marker), `The sandboxed command did not send its success marker: ${output.slice(0, 2_000)}`);
        item = { type: 'message', id: `msg_managed_git_${itemId}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'fixture finished', annotations: [] }] };
      }
      const payload = { id, object: 'response', model: body.model, status: 'completed', output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      for (const event of [
        { type: 'response.created', response: { ...payload, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: payload },
      ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    } catch (error) {
      handlerFailure = error;
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Unexpected fixture request.' } }));
    }
  });
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const transport = ['model="gpt-5.4"', 'model_provider="lark-fixture"', 'web_search="disabled"',
      `model_providers.lark-fixture={name="Loopback fixture",base_url=${JSON.stringify(baseUrl)},wire_api="responses",request_max_retries=0,stream_max_retries=0}`];
    let output: string;
    if (input.launch) output = await input.launch(transport, baseUrl);
    else {
      const overrides = [...input.overrides, ...transport];
      const running = exec('codex', ['exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
        '--skip-git-repo-check', ...overrides.flatMap((entry) => ['--config', entry]), '-'], {
        cwd: input.cwd, env: input.env, maxBuffer: 1024 * 1024, timeout: 40_000, killSignal: 'SIGKILL',
      });
      running.child.stdin?.on('error', () => {});
      running.child.stdin?.end('Run the single scripted fixture operation.');
      output = (await running).stdout;
    }
    assert.equal(requests, 2);
    assert.ok(output.includes('fixture finished'));
  } catch (error) {
    throw handlerFailure ?? error;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
