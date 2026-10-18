import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const root = await fs.mkdtemp(path.resolve('.proof/validation-cli-'));
const stateDir = path.join(root, 'state');
const workspace = path.join(root, 'workspace');
await fs.mkdir(stateDir);
await fs.mkdir(workspace);
const requests = [];
let fixtureError;
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url, 'http://fixture.invalid').pathname, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const toolResults = body.messages.filter(message => message.role === 'tool');
    requests.push({ number: requests.length + 1, toolResults: toolResults.map(message => message.content) });
    const first = requests.length === 1;
    if (requests.length > 2) {
      // A provider unable to author the isolated final reply must leave the
      // genuine tool failure visible. This is an intentional failed-turn case.
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic finalization unavailable', type: 'server_error' } }));
      return;
    }
    if (first) assert(body.tools.some(tool => tool.function.name === 'process'), 'real process tool must be advertised');
    const delta = first
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'call_schema_rejection', type: 'function', function: { name: 'process', arguments: JSON.stringify({ action: 'delete', private: 'PRIVATE_ARGUMENT_FIXTURE' }) } }] }
      : { role: 'assistant', content: '' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({
      id: `chatcmpl_validation_${requests.length}`, object: 'chat.completion.chunk', created: 1, model: body.model,
      choices: [{ index: 0, delta, finish_reason: first ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
    })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    fixtureError = error;
    response.writeHead(500);
    response.end('Synthetic proof fixture failed.');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const configPath = path.join(root, 'openclaw.json');
  await fs.writeFile(configPath, JSON.stringify({
    plugins: { enabled: false }, env: { shellEnv: { enabled: false } },
    tools: { allow: ['process'], codeMode: { enabled: false } },
    agents: { defaults: {
      workspace, systemAgent: { agentId: 'main' }, model: { primary: 'proof-warning/model' },
      models: { 'proof-warning/model': { agentRuntime: { id: 'openclaw' } } },
    } },
    models: { providers: { 'proof-warning': {
      api: 'openai-completions', apiKey: 'synthetic-unused-fixture-key',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, request: { allowPrivateNetwork: true },
      models: [{ id: 'model', name: 'Synthetic validation proof', reasoning: false, input: ['text'],
        contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    } } },
  }));
  const child = spawn('pnpm', ['--silent', 'openclaw', 'agent', '--local', '--agent', 'main',
    '--session-id', randomUUID(), '--message', 'Inspect process status.', '--thinking', 'off', '--timeout', '45', '--json'], {
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  await fs.writeFile('.proof/validation-cli.stdout.log', stdout);
  await fs.writeFile('.proof/validation-cli.stderr.log', stderr);
  await fs.writeFile('.proof/validation-cli.requests.json', JSON.stringify(requests, null, 2));
  assert.ifError(fixtureError);
  assert.equal(code, 1, 'the intentionally failed finalization must produce a failed CLI turn');
  const result = JSON.parse(stdout.slice(stdout.indexOf('{')));
  assert(requests.some(request => request.toolResults.some(text => text.includes('Validation failed for tool'))), 'actual schema-rejected result must be returned to the HTTP provider');
  assert(result.payloads.some(payload => payload.text === '⚠️ Process failed: invalid arguments' && payload.isError === true), 'public CLI must expose the corrected fallback warning');
  assert(!JSON.stringify(result.payloads).includes('PRIVATE_ARGUMENT_FIXTURE'));
  await fs.writeFile('.proof/validation-cli.result.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ proof: 'public local-agent CLI with real HTTP provider adapter and built-in process schema rejection',
    requests: requests.length, expectedCliExit: code, schemaRejected: true, payloads: result.payloads, rawArgumentsPrivate: true }));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
