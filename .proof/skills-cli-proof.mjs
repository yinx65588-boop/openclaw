import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const mode = process.argv[2];
assert(['baseline', 'fixed'].includes(mode));
await fs.mkdir('.proof', { recursive: true });
const root = await fs.mkdtemp(path.resolve('.proof/skill-case-'));
const workspace = path.join(root, 'CaseWorkspace');
const configured = path.join(root, 'caseworkspace');
const skillDir = path.join(workspace, 'skills', 'case-native-proof-181107');
await fs.mkdir(skillDir, { recursive: true });
await fs.writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: case-native-proof-181107\ndescription: Filesystem spelling reproduction fixture\n---\n\nReturn the synthetic case fixture.\n');
const physical = await fs.stat(workspace);
const alias = await fs.stat(configured);
assert.equal(alias.dev, physical.dev);
assert.equal(alias.ino, physical.ino, 'proof requires an actual case-insensitive volume');
const stateDir = path.join(root, 'state');
await fs.mkdir(stateDir);
const configPath = path.join(root, 'openclaw.json');
await fs.writeFile(configPath, JSON.stringify({
  plugins: { enabled: false },
  env: { shellEnv: { enabled: false } },
  agents: { ownership: 'explicit', entries: { 'case-repro': { workspace: configured } } },
  gateway: { mode: 'local', port: 19231 },
}));
const child = spawn('pnpm', ['--silent', 'openclaw', 'skills', 'check', '--agent', 'case-repro', '--json'], {
  env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
child.stdout.on('data', chunk => stdout += chunk);
child.stderr.on('data', chunk => stderr += chunk);
const timer = setTimeout(() => child.kill('SIGTERM'), 600_000);
let code;
try {
  code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
} finally { clearTimeout(timer); }
await fs.writeFile(`.proof/skills-cli-${mode}.stdout.log`, stdout);
await fs.writeFile(`.proof/skills-cli-${mode}.stderr.log`, stderr);
assert.equal(code, 0, `skills check must run successfully: ${stderr.slice(-3000)}`);
const report = JSON.parse(stdout.slice(stdout.indexOf('{')));
const loaded = report.eligible.includes('case-native-proof-181107');
const escaped = stderr.includes('resolved path escapes skill root');
assert.equal(loaded, mode === 'fixed', `unexpected skill visibility for ${mode}`);
assert.equal(escaped, mode === 'baseline', `unexpected boundary diagnostic for ${mode}`);
const summary = { mode, command: 'openclaw skills check --agent case-repro --json', sameDirectoryIdentity: true,
  configuredSpelling: 'caseworkspace', physicalSpelling: 'CaseWorkspace', exit: code, skillLoaded: loaded, escapedRootWarning: escaped };
await fs.writeFile(`.proof/skills-cli-${mode}.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));