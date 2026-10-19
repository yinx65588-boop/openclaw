import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireTestPortBlock } from '../src/test-utils/port-claims.ts';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-acp-cwd-cli-'));
const baseline = process.env.ACP_CWD_BASELINE === '1';
const proofDir = path.resolve('.proof', baseline ? 'cli-baseline' : 'cli-repair');
await fs.mkdir(proofDir, { recursive: true });
const workspace = path.join(root, 'workspace');
const project = path.join(workspace, 'requested');
const adopted = path.join(workspace, 'adopted');
await fs.mkdir(project, { recursive: true });
await fs.mkdir(adopted);
const claim = await acquireTestPortBlock({ offsets: [0] });
const token = 'synthetic-acp-cwd-proof-token';
const gatewayUrl = `ws://127.0.0.1:${claim.port}`;
const configPath = path.join(root, 'openclaw.json');
const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, 'state'), OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_HIDE_BANNER: '1', SHELL: '/bin/bash', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0' };
const children = [];
const ledger = [];
let stage = '';
let fixtureError;
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const results = body.messages.filter(row => row.role === 'tool').map(row => row.content);
    ledger.push({ stage, results });
    await fs.writeFile(path.join(proofDir, 'http-ledger.json'), JSON.stringify(ledger, null, 2));
    assert(ledger.filter(row => row.stage === stage).length <= 2, 'unexpected model retries');
    const delta = results.length ? { role: 'assistant', content: 'Directory checked.' } : {
      role: 'assistant', tool_calls: [{ index: 0, id: 'call_pwd', type: 'function',
        function: { name: 'exec', arguments: JSON.stringify({ command: 'pwd' }) } }],
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: 'proof', object: 'chat.completion.chunk', created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason: results.length ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    fixtureError = error;
    response.writeHead(500);
    response.end('Synthetic fixture failed');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

function cli(args, label, stdin = 'ignore') {
  const child = spawn('pnpm', ['--silent', 'openclaw', ...args], {
    env, detached: true, stdio: [stdin, 'pipe', 'pipe'],
  });
  const record = { child, label, stdout: '', stderr: '', closed: false };
  record.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => {
    record.closed = true;
    resolve(code);
  }); });
  child.stdout.on('data', chunk => record.stdout += chunk);
  child.stderr.on('data', chunk => record.stderr += chunk);
  children.push(record);
  return record;
}
async function run(args, label) {
  const record = cli(args, label);
  assert.equal(await record.done, 0, `${label} failed: ${record.stderr}`);
  return record.stdout;
}
async function stop(record) {
  if (record.closed) return;
  try { process.kill(-record.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  let timer;
  await Promise.race([record.done, new Promise(resolve => { timer = setTimeout(() => {
    try { process.kill(-record.child.pid, 'SIGKILL'); } catch {}
    resolve();
  }, 5000); })]);
  clearTimeout(timer);
}
function acp(record) {
  const pending = new Map();
  let id = 0, buffer = '';
  record.child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const newline = buffer.indexOf('\n');
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.method && message.id !== undefined) {
        const option = message.method === 'session/request_permission'
          ? message.params.options.find(option => option.kind === 'allow_once') : undefined;
        const reply = option ? { result: { outcome: { outcome: 'selected', optionId: option.optionId } } }
          : { error: { code: -32601, message: 'Unsupported fixture method' } };
        record.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...reply }) + '\n');
      } else if (pending.has(message.id)) {
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result);
      }
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)); }, 90000);
    pending.set(requestId, { resolve, reject, timer });
    record.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
  });
}
try {
  await fs.writeFile(configPath, JSON.stringify({
    gateway: { mode: 'local', auth: { mode: 'token', token } }, cron: { enabled: false },
    plugins: { enabled: false }, env: { shellEnv: { enabled: false } },
    tools: { allow: ['exec'], deny: ['process'], codeMode: { enabled: false }, exec: { host: 'gateway', mode: 'full' } },
    agents: { entries: { main: {} }, defaults: { workspace, systemAgent: { agentId: 'main' },
      model: { primary: 'proof-cwd/model' }, models: { 'proof-cwd/model': { agentRuntime: { id: 'openclaw' } } } } },
    models: { providers: { 'proof-cwd': { api: 'openai-completions', apiKey: 'synthetic-unused-key',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, request: { allowPrivateNetwork: true },
      models: [{ id: 'model', name: 'Synthetic cwd proof', reasoning: false, input: ['text'], contextWindow: 32000,
        maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  }));
  const gateway = cli(['gateway', 'run', '--port', String(claim.port), '--bind', 'loopback'], 'gateway');
  const deadline = Date.now() + 90000;
  for (;;) {
    assert(!gateway.closed, `Gateway stopped: ${gateway.stderr}`);
    try { if ((await fetch(`http://127.0.0.1:${claim.port}/healthz`)).ok) break; } catch {}
    assert(Date.now() < deadline, `Gateway did not become healthy: ${gateway.stderr}`);
    await delay(250);
  }
  const key = 'agent:main:acp-bridge:existing-cwd-proof';
  await run(['gateway', 'call', 'sessions.create', '--url', gatewayUrl, '--token', token, '--json',
    '--params', JSON.stringify({ key, cwd: adopted })], 'seed-adopted');
  const observed = [];
  for (const mode of baseline ? ['fresh'] : ['fresh', 'fresh-reset', 'adopt']) {
    stage = mode;
    const bridge = cli(['acp', '--url', gatewayUrl, '--token', token,
      ...(mode === 'fresh-reset' ? ['--reset-session'] : [])], `acp-${mode}`, 'pipe');
    const request = acp(bridge);
    try {
      await request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'cwd-proof', version: '1' } });
      const session = await request('session/new', { cwd: project, mcpServers: [], _meta: mode === 'adopt' ? { sessionKey: key } : {} });
      const result = await request('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Check the execution directory.' }] });
      assert.equal(result.stopReason, 'end_turn');
      assert.ifError(fixtureError);
      const toolResult = ledger.find(row => row.stage === mode && row.results.length)?.results[0];
      const expected = await fs.realpath(baseline ? workspace : mode === 'adopt' ? adopted : project);
      assert(toolResult?.split('\n').includes(expected), `${mode}: expected real pwd=${expected}, got ${toolResult}`);
      observed.push({ mode, requestedCwd: project, expectedCwd: expected, toolResult });
    } finally { await stop(bridge); }
  }
  await fs.writeFile(path.join(proofDir, 'summary.json'), JSON.stringify({ baseline, entry: 'built public CLI ACP stdio -> Gateway RPC -> built-in exec pwd',
    observed, paidProviderCalls: 0, modelEndpointOnlySynthetic: true }, null, 2));
  console.log(JSON.stringify(observed, null, 2));
} finally {
  for (const record of children.toReversed()) {
    await stop(record);
    await fs.writeFile(path.join(proofDir, `${record.label}.stdout.log`), record.stdout);
    await fs.writeFile(path.join(proofDir, `${record.label}.stderr.log`), record.stderr);
  }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await claim.release();
}
