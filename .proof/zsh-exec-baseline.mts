import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareHostExecSpawn } from '../src/agents/bash-tools.exec-host-spawn.js';
import { getBashShellConfig } from '../src/agents/shell-utils.js';

assert.equal(process.platform, 'darwin', 'this proof requires actual macOS zsh');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openclaw-zsh-repro-'));
process.env.SHELL = '/bin/zsh';
process.env.OPENCLAW_EXEC_SHELL_SNAPSHOT = '0';
const env = { PATH: '/usr/bin:/bin', HOME: root, ZDOTDIR: root, SHELL: '/bin/zsh' };
const results = [];
try {
  for (const [name, command, diagnostic] of [
    ['equals', 'echo before; echo ===; echo after', 'not found'],
    ['nomatch', 'echo before; echo no-such-file-*.txt; echo after', 'no matches found'],
  ]) {
    for (const usePty of [false, true]) {
      const prepared = await prepareHostExecSpawn({ command, workdir: root, env, usePty });
      assert.equal(prepared.argv[0], '/bin/zsh');
      assert.equal(prepared.mode, usePty ? 'pty' : 'child');
      // Exercise the production-prepared argv with a real zsh process. PTY
      // preparation is covered here; this probe does not open a native PTY.
      const child = spawnSync(prepared.argv[0], prepared.argv.slice(1), { cwd: root, env, encoding: 'utf8' });
      assert.ifError(child.error);
      assert.equal(child.status, 1);
      assert.equal(child.stdout, 'before\n');
      assert(child.stderr.includes(diagnostic));
      results.push({ name, preparation: prepared.mode, argv: prepared.argv, exit: child.status, stdout: child.stdout, stderr: child.stderr });
    }
  }
  const explicit = getBashShellConfig('/bin/zsh');
  assert.deepEqual(explicit.args, ['-f', '-c']);
  const version = spawnSync('/bin/zsh', ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0);
  const record = { platform: os.release(), zsh: version.stdout.trim(), results, explicitSessionArgs: explicit.args };
  await fs.writeFile('.proof/zsh-baseline.json', JSON.stringify(record, null, 2));
  console.log(JSON.stringify(record));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
