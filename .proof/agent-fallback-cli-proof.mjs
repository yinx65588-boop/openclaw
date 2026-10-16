import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const root = await fs.mkdtemp(path.resolve('.proof/cli-'));
const stateDir = path.join(root, 'state');
const workspace = path.join(root, 'workspace');
await fs.mkdir(stateDir);
await fs.mkdir(workspace);
const requests = [];
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert(['model-a', 'model-b'].includes(payload.model));
    const primary = payload.model === 'model-a';
    assert.equal(new URL(req.url, 'http://fixture.invalid').pathname, primary ? '/v1/messages' : '/v1/chat/completions');
    requests.push({ model: payload.model, input: primary ? 100 : 200, output: primary ? 10 : 20 });
    if (primary) {
      // Anthropic retains a tool_use stop without structured calls. The embedded
      // recovery owner retries once, then returns a completed fallback-safe result.
      const events = [
        { type: 'message_start', message: { id: `msg_fixture_${requests.length}`, type: 'message', role: 'assistant', model: payload.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NO_REPLY' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    const event = {
      id: `chatcmpl_fixture_${requests.length}`, object: 'chat.completion.chunk',
      created: 1, model: payload.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Recovered after fallback.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: primary ? 100 : 200, completion_tokens: primary ? 10 : 20, total_tokens: primary ? 110 : 220 },
    };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const provider = (id, input, output) => ({
    api: id === 'model-a' ? 'anthropic-messages' : 'openai-completions', apiKey: 'synthetic-unused-fixture-key', baseUrl: id === 'model-a' ? baseUrl.replace(/\/v1$/, '') : baseUrl,
    request: { allowPrivateNetwork: true },
    models: [{ id, name: id, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input, output, cacheRead: 0, cacheWrite: 0 } }],
  });
  const configPath = path.join(root, 'openclaw.json');
  const sessionId = randomUUID();
  await fs.writeFile(configPath, JSON.stringify({
    plugins: { enabled: false }, env: { shellEnv: { enabled: false } },
    agents: { defaults: { workspace, systemAgent: { agentId: 'main' }, model: { primary: 'proof-primary/model-a', fallbacks: ['proof-fallback/model-b'] },
      models: { 'proof-primary/model-a': { agentRuntime: { id: 'openclaw' } }, 'proof-fallback/model-b': { agentRuntime: { id: 'openclaw' } } } } },
    models: { providers: { 'proof-primary': provider('model-a', 1, 2), 'proof-fallback': provider('model-b', 10, 20) } },
  }));
  async function runCli(args, label) {
  const child = spawn('pnpm', ['--silent', 'openclaw', ...args], { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timeout = setTimeout(() => child.kill('SIGTERM'), 180000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timeout);
  await fs.writeFile(`.proof/${label}.stdout.log`, stdout);
  await fs.writeFile(`.proof/${label}.stderr.log`, stderr);
  await fs.writeFile('.proof/cli-requests.json', JSON.stringify(requests, null, 2));
  assert.equal(code, 0, stderr.slice(-5000) + '\n' + stdout.slice(-3000));
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
  }
  const result = await runCli(['agent', '--local', '--agent', 'main', '--session-id', sessionId,
    '--message', 'Reply briefly without tools.', '--thinking', 'off', '--timeout', '45', '--json'], 'cli');
  const meta = result.meta.agentMeta;
  assert.equal(meta.provider, 'proof-fallback');
  assert.equal(meta.model, 'model-b');
  assert(result.payloads.some(payload => payload.text === 'Recovered after fallback.'));
  assert(requests.some(r => r.model === 'model-a'));
  assert(requests.some(r => r.model === 'model-b'));
  const input = requests.reduce((sum, r) => sum + r.input, 0);
  const output = requests.reduce((sum, r) => sum + r.output, 0);
  const cost = requests.reduce((sum, r) => sum + (r.input * (r.model === 'model-a' ? 1 : 10) + r.output * (r.model === 'model-a' ? 2 : 20)) / 1e6, 0);
  assert.equal(meta.usage.input, input);
  assert.equal(meta.usage.output, output);
  assert(Math.abs(meta.costUsd - cost) < 1e-9);
  assert.equal(meta.lastCallUsage.input, 200);
  assert.equal(meta.lastCallUsage.output, 20);
  const sessions = await runCli(['sessions', '--agent', 'main', '--json'], 'sessions');
  const session = sessions.sessions.find(row => row.sessionId === sessionId);
  assert(session, 'completed local session must be persisted');
  assert.equal(session.inputTokens, input);
  assert.equal(session.outputTokens, output);
  assert.equal(session.totalTokens, 200, 'live context belongs to the winner');
  assert.equal(session.totalTokensFresh, true);
  await fs.writeFile('.proof/cli-result.json', JSON.stringify({ requests, input, output, expectedCostUsd: cost, result, session }, null, 2));
  console.log(JSON.stringify({ proof: 'public configured fallback via pnpm openclaw agent --local and sessions --json with local HTTP fixtures', requests, input, output, costUsd: meta.costUsd, winner: meta.provider + '/' + meta.model, contextTokens: session.totalTokens }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
