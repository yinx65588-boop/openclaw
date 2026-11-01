import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve('.proof/cli');
const stateDir = path.join(root, 'state');
const workspace = path.join(root, 'workspace');
await fs.mkdir(stateDir, { recursive: true });
await fs.mkdir(workspace, { recursive: true });
const fixtureText = 'RESPONSES_PROOF_TOOL_CONTENT_20261101';
const fixturePath = path.join(workspace, 'fixture.txt');
await fs.writeFile(fixturePath, fixtureText + '\n');
const requests = [];
const fixtureFailures = [];
const server = http.createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/responses');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const payload = JSON.parse(raw);
    requests.push(payload);
    await fs.writeFile(path.join(root, 'request-ledger.json'), JSON.stringify(requests, null, 2));
    assert.equal(payload.model, 'proof-model');
    assert(requests.length <= 4, 'unexpected retry or additional model request');
    const toolTurn = requests.length % 2 === 1;
    if (toolTurn) {
      assert(payload.tools.some(tool => tool.name === 'read'), 'real read tool must be available');
    } else {
      assert(payload.input.some(item => item.type === 'function_call_output' && item.output.includes(fixtureText)), 'actual file-read result must reach the provider');
    }
    const id = `resp_proof_${requests.length}`;
    const item = toolTurn
      ? { id: `fc_proof_${requests.length}`, type: 'function_call', status: 'completed', call_id: `call_proof_${requests.length}`, name: 'read', arguments: JSON.stringify({ path: fixturePath }) }
      : { id: `msg_proof_${requests.length}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Proof turn ${requests.length / 2} complete.`, annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id, model: 'proof-model', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: toolTurn ? { ...item, arguments: '', status: 'in_progress' } : { ...item, content: [], status: 'in_progress' } },
      ...(toolTurn ? [{ type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: item.arguments }] : [
        { type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text: item.content[0].text },
      ]),
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id, model: 'proof-model', status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  } catch (error) {
    fixtureFailures.push(String(error));
    res.writeHead(500);
    res.end(String(error));
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const configPath = path.join(root, 'openclaw.json');
await fs.writeFile(configPath, JSON.stringify({
  plugins: { enabled: false }, env: { shellEnv: { enabled: false } },
  tools: { codeMode: false, toolSearch: false, allow: ['read'] },
  agents: { defaults: { workspace, systemAgent: { agentId: 'main' }, model: { primary: 'proof-custom/proof-model' }, models: { 'proof-custom/proof-model': { agentRuntime: { id: 'openclaw' } } } } },
  models: { providers: { 'proof-custom': { api: 'openai-responses', apiKey: 'synthetic-unused-fixture-key', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, request: { allowPrivateNetwork: true }, models: [{ id: 'proof-model', name: 'proof-model', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
}));
const sessionId = randomUUID();
const result = { variant: process.env.VARIANT, fixtureFailures, requests: 0, passed: false };
try {
  for (const turn of [1, 2]) {
    const child = spawn('pnpm', ['--silent', 'openclaw', 'agent', '--local', '--agent', 'main', '--session-id', sessionId, '--message', `Read fixture.txt and finish proof turn ${turn}.`, '--thinking', 'off', '--timeout', '60', '--json'], { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => stdout += chunk);
    child.stderr.on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => child.kill('SIGTERM'), 180000);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    clearTimeout(timer);
    await fs.writeFile(path.join(root, `turn-${turn}.stdout.log`), stdout);
    await fs.writeFile(path.join(root, `turn-${turn}.stderr.log`), stderr);
    assert.equal(code, 0, stderr.slice(-5000) + stdout.slice(-3000));
    const response = JSON.parse(stdout.slice(stdout.indexOf('{')));
    assert(response.payloads.some(payload => payload.text === `Proof turn ${turn} complete.`));
    assert.equal(response.meta.agentMeta.provider, 'proof-custom');
    assert.equal(response.meta.agentMeta.model, 'proof-model');
    assert.equal(requests.length, turn * 2);
  }
  result.requests = requests.length;
  assert.deepEqual(fixtureFailures, []);
  const first = requests[0];
  const reopened = requests[2];
  const carrier = item => item.role === 'user' && JSON.stringify(item.content).includes('OpenClaw runtime context:');
  result.firstCarrierCount = first.input.filter(carrier).length;
  assert(result.firstCarrierCount > 0, 'first request must contain runtime context to test retention');
  result.reopenedPrefixMatches = JSON.stringify(reopened.input.slice(0, first.input.length)) === JSON.stringify(first.input);
  result.reopenedCarrierCount = reopened.input.filter(carrier).length;
  result.firstCarrierRetained = first.input.every((item, index) => !carrier(item) || JSON.stringify(reopened.input[index]) === JSON.stringify(item));
  result.instructionsMatch = first.instructions === reopened.instructions;
  result.toolsMatch = JSON.stringify(first.tools) === JSON.stringify(reopened.tools);
  assert(result.instructionsMatch, 'cold-reopened system instructions must match');
  assert(result.toolsMatch, 'cold-reopened tool schemas must match');
  assert(result.firstCarrierRetained, 'historical runtime carrier must be retained after cold reopen');
  assert(result.reopenedPrefixMatches, 'previous serialized request input must remain an exact prefix');
  result.passed = true;
} catch (error) {
  result.failure = String(error);
  process.exitCode = 1;
} finally {
  result.requests = requests.length;
  await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
