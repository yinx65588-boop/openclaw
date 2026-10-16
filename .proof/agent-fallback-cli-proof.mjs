import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
    assert.equal(req.url, '/v1/chat/completions');
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    assert(['model-a', 'model-b'].includes(payload.model));
    const primary = payload.model === 'model-a';
    requests.push({ model: payload.model, input: primary ? 100 : 200, output: primary ? 10 : 20 });
    const event = {
      id: `chatcmpl_fixture_${requests.length}`, object: 'chat.completion.chunk',
      created: 1, model: payload.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: primary ? '' : 'Recovered after fallback.' }, finish_reason: 'stop' }],
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
    api: 'openai-completions', apiKey: 'synthetic-unused-fixture-key', baseUrl,
    request: { allowPrivateNetwork: true },
    models: [{ id, name: id, reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024,
      cost: { input, output, cacheRead: 0, cacheWrite: 0 } }],
  });
  const configPath = path.join(root, 'openclaw.json');
  await fs.writeFile(configPath, JSON.stringify({
    plugins: { enabled: false }, env: { shellEnv: { enabled: false } },
    agents: { defaults: { systemAgent: { agentId: 'main' }, model: { primary: 'proof-primary/model-a' },
      models: { 'proof-primary/model-a': { agentRuntime: { id: 'openclaw' } }, 'proof-fallback/model-b': { agentRuntime: { id: 'openclaw' } } } } },
    models: { providers: { 'proof-primary': provider('model-a', 1, 2), 'proof-fallback': provider('model-b', 10, 20) } },
  }));
  const args = ['--silent', 'openclaw', 'agent', 'exec', 'Reply briefly without tools.', '--config', configPath,
    '--cwd', workspace, '--state-dir', stateDir, '--model', 'proof-primary/model-a', '--fallback', 'proof-fallback/model-b',
    '--code-mode', 'direct', '--thinking', 'off', '--timeout', '45', '--json'];
  const child = spawn('pnpm', args, { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timeout = setTimeout(() => child.kill('SIGTERM'), 180000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timeout);
  await fs.writeFile('.proof/cli.stdout.log', stdout);
  await fs.writeFile('.proof/cli.stderr.log', stderr);
  await fs.writeFile('.proof/cli-requests.json', JSON.stringify(requests, null, 2));
  assert.equal(code, 0, stderr.slice(-5000) + '\n' + stdout.slice(-3000));
  const envelope = JSON.parse(stdout.slice(stdout.indexOf('{')));
  assert.equal(envelope.ok, true);
  assert.equal(envelope.provider, 'proof-fallback');
  assert.equal(envelope.model, 'model-b');
  assert.equal(envelope.final, 'Recovered after fallback.');
  assert(requests.some(r => r.model === 'model-a'));
  assert(requests.some(r => r.model === 'model-b'));
  const input = requests.reduce((sum, r) => sum + r.input, 0);
  const output = requests.reduce((sum, r) => sum + r.output, 0);
  const cost = requests.reduce((sum, r) => sum + (r.input * (r.model === 'model-a' ? 1 : 10) + r.output * (r.model === 'model-a' ? 2 : 20)) / 1e6, 0);
  assert.equal(envelope.usage.input, input);
  assert.equal(envelope.usage.output, output);
  assert(Math.abs(envelope.costUsd - cost) < 1e-9);
  await fs.writeFile('.proof/cli-result.json', JSON.stringify({ requests, input, output, expectedCostUsd: cost, envelope }, null, 2));
  console.log(JSON.stringify({ proof: 'public pnpm openclaw agent exec with local HTTP provider fixtures', requests, input, output, costUsd: envelope.costUsd, winner: envelope.provider + '/' + envelope.model }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
