import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "win32", "This proof requires a real Windows host");
const runFile = promisify(execFile);
const runtimeRoot = path.resolve(".proof/runtime/node_modules/openclaw");
const cliPath = path.join(runtimeRoot, "openclaw.mjs");
const packageInfo = JSON.parse(await readFile(path.join(runtimeRoot, "package.json"), "utf8"));
assert.equal(packageInfo.version, "2026.10.3");
const root = await mkdtemp(path.join(tmpdir(), "openclaw-173190-"));
const stateDir = path.join(root, "state");
const workspace = path.join(root, "workspace");
const configPath = path.join(stateDir, "openclaw.json");
const port = 19831;
const token = randomBytes(24).toString("hex");
const sessionKey = "agent:main:proof-windows-env-173190";
const lines = [];
let gatewayOutput = "";
let gateway;
function redact(value) {
  return String(value).replaceAll(token, "[REDACTED]")
    .replaceAll(root, "<isolated-proof-root>")
    .replaceAll("127.0.0.1", "[loopback]")
    .replaceAll("::1", "[loopback]");
}
function report(value) {
  const line = redact(value);
  lines.push(line);
  console.log(line);
}
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/TOKEN|SECRET|PASSWORD|API_KEY|OPENCLAW|ANTHROPIC|OPENAI|CLAUDE|CODEX/i.test(key)) delete env[key];
}
Object.assign(env, {
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_GATEWAY_TOKEN: token,
  NO_COLOR: "1",
});
async function cli(args, timeout = 90_000) {
  try {
    const result = await runFile(process.execPath, [cliPath, ...args], {
      env, cwd: root, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout;
  } catch (error) {
    throw new Error(redact(`CLI failed: ${args.slice(0, 3).join(" ")}\n${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message}`));
  }
}
async function rpc(method, params) {
  const output = await cli([
    "gateway", "call", method, "--params", JSON.stringify(params),
    "--url", `ws://127.0.0.1:${port}`, "--token", token,
    "--timeout", "90000", "--json",
  ]);
  try { return JSON.parse(output); }
  catch { throw new Error(redact(`Non-JSON ${method} output: ${output}`)); }
}
try {
  await mkdir(stateDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(configPath, JSON.stringify({
    gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token }, controlUi: { enabled: false } },
    agents: { defaults: { workspace, memorySearch: { enabled: false } } },
    cron: { enabled: false },
    discovery: { mdns: { mode: "off" } },
    browser: { enabled: false },
    update: { checkOnStart: false },
  }, null, 2));
  report(`platform=${process.platform} node=${process.version} openclaw=${packageInfo.version}`);
  report(`entrypoint=node <published-package>/openclaw.mjs; isolated state, workspace and loopback port; no model credentials`);
  report(`openclaw --version: ${(await cli(["--version"])).trim()}`);
  gateway = spawn(process.execPath, [cliPath, "gateway", "run", "--allow-unconfigured", "--bind", "loopback", "--port", String(port), "--auth", "token", "--token", token], {
    env, cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  gateway.stdout.on("data", chunk => { gatewayOutput = (gatewayOutput + chunk).slice(-500_000); });
  gateway.stderr.on("data", chunk => { gatewayOutput = (gatewayOutput + chunk).slice(-500_000); });
  gateway.on("error", error => { gatewayOutput += error.message; });
  let ready = false;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (gateway.exitCode !== null) throw new Error(`Gateway exited ${gateway.exitCode}\n${gatewayOutput}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(1000);
  }
  assert.ok(ready, `Gateway did not become ready\n${gatewayOutput}`);
  report("Gateway /readyz: HTTP 200");
  const created = await rpc("sessions.create", { agentId: "main", key: sessionKey, label: "Windows storage-fact worker proof" });
  assert.equal(created.key, sessionKey);
  assert.ok(created.sessionId);
  assert.ok(!created.runError, JSON.stringify(created.runError));
  report("sessions.create: success; explicit non-main durable session created; no initial model turn requested");
  const resolved = await rpc("sessions.resolve", { key: sessionKey });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.key, sessionKey);
  report("sessions.resolve: success; created session resolved through running Windows Gateway");
  const listed = await rpc("sessions.list", { limit: 10 });
  assert.ok(listed.sessions?.some(session => session.key === sessionKey));
  report("sessions.list: success; created durable session returned");
  const history = await rpc("sessions.get", { key: sessionKey });
  assert.ok(history && typeof history === "object");
  report("sessions.get: success; stored session transcript read through public Gateway RPC");
  report("PASS: published Windows Gateway session create/resolve/list/get completed without DataCloneError");
} catch (error) {
  report(`FAIL: ${error.stack ?? error}`);
  report(`Gateway diagnostics:\n${gatewayOutput}`);
  process.exitCode = 1;
} finally {
  if (gateway?.pid && gateway.exitCode === null) {
    const closed = once(gateway, "exit");
    await runFile("taskkill.exe", ["/PID", String(gateway.pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
    await Promise.race([closed, delay(10_000)]);
  }
  await writeFile(path.resolve(".proof/windows-session-proof.txt"), lines.join("\n") + "\n");
  const expectedPrefix = path.resolve(tmpdir()) + path.sep + "openclaw-173190-";
  assert.ok(path.isAbsolute(root) && root.startsWith(expectedPrefix), "Refuse cleanup outside the owned proof directory");
  await rm(root, { recursive: true, force: true }).catch(error => report(`Temporary proof cleanup: ${error.message}`));
}
