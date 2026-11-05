import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.env.PROOF_ROOT;
assert(root);
const packageRoot = (name) => path.join(root, name, "node_modules", "openclaw");
const installed = packageRoot("stable");
const candidate = packageRoot("beta");
const installedVersion = "2026.10.10";
const candidateVersion = "2026.11.5-beta.1";
for (const [dir, version] of [[installed, installedVersion], [candidate, candidateVersion]]) {
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version, version);
}
const heartbeat = {
  every: "1h",
  activeHours: { start: "08:00", end: "22:00", timezone: "local" },
  model: "deepseek/deepseek-v4-flash",
  lightContext: true,
  isolatedSession: true,
};
for (const [name, defaults, requestedChannel, expected] of [
  ["valid-control", {}, null, "admit"],
  ["unknown-field-control", { proofUnknown: true }, null, "refuse"],
  ["heartbeat", { heartbeat }, null, undefined],
  ["heartbeat-explicit-channel", { heartbeat }, "beta", undefined],
]) {
  const home = path.join(root, name);
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");
  const workspace = path.join(home, "workspace");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify({
    agents: { defaults, entries: { main: { workspace } } },
    gateway: { mode: "local" },
    update: { channel: "beta" },
  }), { mode: 0o600 });
  const before = fs.readFileSync(configPath);
  const contextPath = path.join(home, "context.json");
  fs.writeFileSync(contextPath, JSON.stringify({
    protocol: 1,
    installation: {
      root: installed, canonicalRoot: fs.realpathSync(installed), version: installedVersion,
      installKind: "package", packageManager: "npm",
    },
    target: {
      spec: "openclaw@" + candidateVersion, version: candidateVersion,
      source: "registry", channel: "beta", tag: candidateVersion,
    },
    request: { yes: true, noRestart: true, acceptCapabilities: false, json: true, requestedChannel },
    run: { id: "heartbeat-defaults-" + name },
    supervisor: { version: installedVersion, host: "fixture", pid: process.pid },
  }), { mode: 0o600, flag: "wx" });
  const result = spawnSync(process.execPath, [
    path.join(candidate, "dist/index.js"), "update", "admit", "--context", contextPath,
  ], {
    cwd: candidate,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      NODE_DISABLE_COMPILE_CACHE: "1",
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.ifError(result.error);
  assert.deepEqual(fs.readFileSync(configPath), before);
  let verdict;
  try {
    verdict = JSON.parse(result.stdout);
  } catch {
    throw new Error("Missing candidate verdict for " + name + ": " + result.stderr.slice(-1200).replaceAll(root, "<fixture>"));
  }
  const config = verdict.facts?.checks?.find((check) => check.name === "config");
  const reasonCodes = verdict.reasons?.map((reason) => reason.code);
  console.log(JSON.stringify({ name, exit: result.status, verdict: verdict.verdict, config: config?.status, reasonCodes }));
  assert.equal(verdict.candidateVersion, candidateVersion);
  assert(config, "config check must run");
  if (expected) {
    assert.equal(verdict.verdict, expected);
    assert.equal(config.status, expected === "admit" ? "ok" : "refuse");
  }
}
