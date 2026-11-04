import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.env.HOME;
const claude = process.env.PROOF_CLAUDE;
assert(root && claude);
const workspace = path.join(root, "workspace");
await mkdir(workspace, { recursive: true });
const marker = "prior-reply-proof-3d70";
const model = "claude-sonnet-4-6";
const requests = [];
const unexpected = [];
const server = createServer(async (req, res) => {
  const body = [];
  for await (const chunk of req) body.push(chunk);
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  if (pathname === "/v1/messages/count_tokens") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ input_tokens: 10 }));
    return;
  }
  if (pathname !== "/v1/messages") {
    unexpected.push(pathname);
    res.writeHead(404).end();
    return;
  }
  const data = JSON.parse(Buffer.concat(body).toString());
  const priorVisible = JSON.stringify(data.messages).includes(marker);
  requests.push({ stream: data.stream === true, priorVisible });
  const text = requests.length === 1 ? marker + " " + "x".repeat(8 * 1024 * 1024 + 10)
    : priorVisible ? "resumed-marker-seen" : "resumed-marker-missing";
  const message = { id: "msg_proof" + requests.length, type: "message", role: "assistant",
    model: data.model, content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  if (!data.stream) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...message, content: [{ type: "text", text }], stop_reason: "end_turn" }));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  send({ type: "message_start", message });
  send({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  for (let offset = 0; offset < text.length; offset += 32768) {
    if (!send({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(offset, offset + 32768) } })) {
      await once(res, "drain");
    }
  }
  send({ type: "content_block_stop", index: 0 });
  send({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } });
  send({ type: "message_stop" });
  res.end();
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}`;
const sessionId = "0b50d9a3-2fc4-4f83-8394-3fca5b1b5cb3";
const stateDir = path.join(root, ".openclaw");
const configPath = path.join(stateDir, "openclaw.json");
const bin = path.join(root, "bin");
const invocationPath = path.join(root, "native-invocations.jsonl");
await mkdir(stateDir, { recursive: true });
await mkdir(bin, { recursive: true });
await writeFile(path.join(bin, "claude"), `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
const readFlag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
fs.appendFileSync(process.env.PROOF_INVOCATIONS, JSON.stringify({
  action: args[0] === "auth" ? "auth" : args.includes("--version") ? "version" : "run",
  resume: readFlag("--resume"), fresh: readFlag("--session-id")
}) + "\\n");
const result = cp.spawnSync(process.env.PROOF_CLAUDE, args, {
  env: { ...process.env, ANTHROPIC_BASE_URL: process.env.PROOF_MODEL_URL,
    ANTHROPIC_AUTH_TOKEN: "local-test-fixture", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1", MAX_THINKING_TOKENS: "0",
    DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1" },
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
`, { mode: 0o755 });
await writeFile(configPath, JSON.stringify({
  plugins: { entries: { anthropic: { enabled: true } } },
  agents: { defaults: { workspace, model: { primary: `claude-cli/${model}` },
    models: { [`claude-cli/${model}`]: {} } } },
}));
const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH,
  OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
  PROOF_INVOCATIONS: invocationPath, PROOF_MODEL_URL: url, CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
};
async function runAgent(message) {
  const child = spawn(process.execPath, ["openclaw.mjs", "agent", "--local", "--session-id", sessionId,
    "--message", message, "--json", "--timeout", "60"], {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout = (stdout + data).slice(-30000); });
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-30000); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
  const [code] = await once(child, "close");
  clearTimeout(timer);
  const output = stdout + stderr;
  const log = await readFile(invocationPath, "utf8").catch(() => "");
  const calls = log.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const safe = output.split("\n").filter((line) => /cli run|output exceeded|session|Error|auth|marker|reason|failed/i.test(line))
    .slice(-22).map((line) => line.slice(0, 250).replaceAll(url, "<loopback>"));
  return { code, calls, safe, limit: /CLI JSONL output exceeded|CLI JSONL line exceeded|CLI JSONL.*limit/i.test(output),
    resumedMarker: output.includes("resumed-marker-seen"), missingMarker: output.includes("resumed-marker-missing") };
}
try {
  const first = await runAgent("Start the proof turn.");
  console.log(JSON.stringify({ phase: "first", ...first, requests, unexpected }));
  assert.equal(requests.length, 1, "First command must reach the actual Claude CLI provider once");
  assert(first.limit, "First command must hit the real OpenClaw streaming parser limit");
  const second = await runAgent("Continue the proof turn.");
  console.log(JSON.stringify({ phase: "second", ...second, requests, unexpected }));
  assert.equal(requests.length, 2);
  assert.equal(second.code, 0);
  assert.equal(requests[1].priorVisible, false, "Baseline unexpectedly retained the native context");
  assert(second.missingMarker);
  const runs = second.calls.filter((call) => call.action === "run");
  assert(runs.length >= 2);
  assert(!runs.at(-1).resume);
  console.log("BASELINE_REPRODUCED_FIRST_TURN_CLAUDE_BINDING_LOST");
} finally {
  server.close();
}
