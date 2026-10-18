import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

assert.equal(process.platform, 'darwin');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-zsh-upgrade-'));
const stateDir = path.join(root, 'state');
const workspace = path.join(root, 'workspace');
const prefix = path.join(root, 'installation');
const configPath = path.join(root, 'openclaw.json');
await fs.mkdir(stateDir);
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, 'existing-settings-marker.txt'), 'Existing workspace retained.\n');
const commands = ['echo before; echo ===; echo after', 'echo before; echo no-such-file-*.txt; echo after'];
const cli = path.join(prefix, 'bin', 'openclaw');
const childEnv = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
  SHELL: '/bin/zsh', OPENCLAW_EXEC_SHELL_SNAPSHOT: '0', ZDOTDIR: workspace };
let stage;
let fixtureError;
let results = [];
const ledger = [];
async function run(command, args, label, env = childEnv) {
  const child = spawn(command, args, { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk);
  child.stderr.on('data', chunk => stderr += chunk);
  const timer = setTimeout(() => child.kill('SIGTERM'), 300000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timer);
  await fs.writeFile(`.proof/zsh-cli-${label}.stdout.log`, stdout);
  await fs.writeFile(`.proof/zsh-cli-${label}.stderr.log`, stderr);
  assert.equal(code, 0, `${label} failed; inspect its stderr artifact`);
  return stdout;
}
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, 'POST');
    assert.equal(new URL(request.url, 'http://fixture.invalid').pathname, '/v1/chat/completions');
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const toolResults = body.messages.filter(message => message.role === 'tool');
    results = toolResults.map(message => ({ id: message.tool_call_id, content: message.content }));
    ledger.push({ stage, request: ledger.length + 1, results });
    assert(ledger.filter(row => row.stage === stage).length <= 2, 'unexpected model retries');
    if (!toolResults.length) assert(body.tools.some(tool => tool.function.name === 'exec'), 'built-in exec must be advertised');
    const delta = toolResults.length ? { role: 'assistant', content: 'Both exec results were received.' } : {
      role: 'assistant', tool_calls: commands.map((command, index) => ({ index, id: `call_${index}`, type: 'function',
        function: { name: 'exec', arguments: JSON.stringify({ command, workdir: workspace, yieldMs: 10000 }) } })),
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ id: `chatcmpl_${stage}`, object: 'chat.completion.chunk', created: 1,
      model: body.model, choices: [{ index: 0, delta, finish_reason: toolResults.length ? 'stop' : 'tool_calls' }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
  } catch (error) {
    fixtureError = error;
    response.writeHead(500);
    response.end('Synthetic exec proof fixture failed.');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  await fs.writeFile(configPath, JSON.stringify({
    plugins: { enabled: false }, env: { shellEnv: { enabled: false } },
    tools: { allow: ['exec'], deny: ['process'], codeMode: { enabled: false }, exec: { host: 'gateway', mode: 'full' } },
    agents: { defaults: { workspace, systemAgent: { agentId: 'main' }, model: { primary: 'proof-zsh/model' },
      models: { 'proof-zsh/model': { agentRuntime: { id: 'openclaw' } } } } },
    models: { providers: { 'proof-zsh': { api: 'openai-completions', apiKey: 'synthetic-unused-fixture-key',
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, request: { allowPrivateNetwork: true },
      models: [{ id: 'model', name: 'Synthetic zsh exec proof', reasoning: false, input: ['text'],
        contextWindow: 32000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } },
  }));
  await run('npm', ['install', '-g', '--prefix', prefix, 'openclaw@2026.10.4', '--no-audit', '--no-fund'], 'stable-install');
  const stableVersion = (await run(cli, ['--version'], 'stable-version')).trim();
  async function execute(label) {
    stage = label;
    results = [];
    const stdout = await run(cli, ['agent', '--local', '--agent', 'main', '--session-id', randomUUID(),
      '--message', 'Run the two specified shell command checks.', '--thinking', 'off', '--timeout', '60', '--json'], label);
    assert.ifError(fixtureError);
    assert.equal(results.length, 2, 'both real exec results must reach the HTTP provider');
    const output = results.sort((a,b) => a.id.localeCompare(b.id)).map(row => row.content);
    const result = JSON.parse(stdout.slice(stdout.indexOf('{')));
    assert(result.payloads.some(payload => payload.text.includes('Both exec results were received.')));
    return output;
  }
  const baseline = await execute('stable');
  assert(baseline[0].includes('not found'), 'stable equals expansion must reproduce');
  assert(baseline[1].includes('no matches found'), 'stable unmatched glob must reproduce');
  assert(baseline.every(text => !text.includes('after')), 'stable command chains must stop early');
  const existingConfig = await fs.readFile(configPath);
  const digest = value => createHash('sha256').update(value).digest('hex');
  await run('npm', ['install', '-g', '--prefix', prefix, path.resolve(process.argv[2]), '--no-audit', '--no-fund'], 'repair-upgrade');
  assert.equal(digest(await fs.readFile(configPath)), digest(existingConfig), 'existing settings must remain byte-identical after package replacement');
  const repairedVersion = (await run(cli, ['--version'], 'repair-version')).trim();
  const repaired = await execute('repair');
  assert(repaired[0].includes('before\n===\nafter'), 'repaired separator chain must complete through actual exec');
  assert(repaired[1].includes('before\nno-such-file-*.txt\nafter'), 'repaired unmatched-glob chain must complete through actual exec');
  assert(repaired.every(text => !text.includes('not found') && !text.includes('no matches found')));
  assert.equal(digest(await fs.readFile(configPath)), digest(existingConfig));
  assert.equal(await fs.readFile(path.join(workspace, 'existing-settings-marker.txt'), 'utf8'), 'Existing workspace retained.\n');
  const summary = { platform: os.release(), node: process.version, shell: '/bin/zsh', stableVersion, repairedVersion,
    entry: 'installed openclaw agent --local -> real HTTP adapter -> built-in exec -> native zsh',
    upgrade: 'manual npm replacement in the same isolated prefix', existingSettingsByteIdentical: true, workspaceMarkerRetained: true,
    shellSnapshot: 'disabled identically before and after', commands, baseline, repaired, paidProviderCalls: 0 };
  await fs.writeFile('.proof/zsh-cli-summary.json', JSON.stringify(summary, null, 2));
  await fs.writeFile('.proof/zsh-cli-request-ledger.json', JSON.stringify(ledger, null, 2));
  console.log(JSON.stringify(summary, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
