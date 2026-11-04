import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir } from "node:fs/promises";
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
const env = { ...process.env, ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: "local-test-fixture",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1", DISABLE_AUTOUPDATER: "1",
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1", MAX_THINKING_TOKENS: "0",
  CLAUDE_CONFIG_DIR: path.join(root, ".claude") };
async function run(args) {
  const child = spawn(claude, ["-p", "--verbose", "--output-format", "stream-json", "--model", model,
    "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', ...args], {
    cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  let stderr = "";
  child.stdout.on("data", (data) => stdout.push(data));
  child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-1000); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
  const [code] = await once(child, "close");
  clearTimeout(timer);
  const lines = Buffer.concat(stdout).toString("utf8").trim().split("\n");
  const maxLineChars = Math.max(...lines.map((line) => line.length));
  const frames = lines.map((line) => {
    try { return JSON.parse(line); } catch { return {}; }
  });
  const init = frames.find((frame) => frame.type === "system" && frame.subtype === "init");
  const result = frames.findLast((frame) => frame.type === "result");
  if (code !== 0 || result?.is_error || !init?.session_id) {
    console.log(JSON.stringify({ code, requests, unexpected, frameTypes: frames.map(({type, subtype}) => ({type, subtype})), stderr }));
    throw new Error("Native CLI direct fixture did not complete");
  }
  return { sessionId: init.session_id, maxLineChars, text: result.result };
}
try {
  const first = await run(["Start the proof turn."]);
  assert(first.maxLineChars > 8 * 1024 * 1024, "Native stream did not emit an oversized record");
  assert(first.text.includes(marker));
  const second = await run(["--resume", first.sessionId, "Continue the proof turn."]);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.text, "resumed-marker-seen");
  assert.deepEqual(requests.map((x) => x.priorVisible), [false, true]);
  console.log(JSON.stringify({ nativeClaude: "2.1.311", sameSession: true,
    firstMaxLineChars: first.maxLineChars, resumeReceivedPriorMarker: true, requests: requests.length }));
} finally {
  server.close();
}
