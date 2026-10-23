"""Secretless shipped-CLI proof. Run only in the isolated CI network namespace."""
import http.server
import json
import os
from pathlib import Path
import signal
import socket
import ssl
import subprocess
import threading
import time
import traceback

root = Path(os.environ["PROOF_ROOT"])
root.mkdir(parents=True, exist_ok=True)
sessions = {}
ledger = []
usage = {"input_tokens": 30, "output_tokens": 5, "total_tokens": 35}


def session_record(sid):
    state = sessions[sid]
    return {"id": sid, "object": "agent.session", "status": "idle", "error": None,
            "environment": {"type": "openai_hosted", "id": "env-fixture"},
            "required_actions": [], "usage": usage, "agent": state["agent"]}


def turn_record(sid):
    return {"id": "turn-" + sid, "session_id": sid, "subagent_id": None,
            "object": "agent.session.turn", "agent_id": "agent-fixture",
            "created_at": 1, "started_at": 1, "completed_at": 2,
            "status": "completed", "error": None, "usage": usage}


def items(sid):
    turn = "turn-" + sid
    return [
        {"id": "user-" + sid, "type": "message", "role": "user", "turn_id": turn,
         "status": "completed", "content": [{"type": "input_text", "text": sessions[sid].get("input", "Fixture cron request")}]},
        {"id": "answer-" + sid, "type": "message", "role": "assistant", "turn_id": turn,
         "phase": "final_answer", "status": "completed",
         "content": [{"type": "output_text", "text": "CRON_NATIVE_COMPLETED"}]},
    ]


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def respond(self, value, status=200):
        body = json.dumps(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def route(self):
        path = self.path.split("?")[0]
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        ledger.append({"method": self.command, "path": path, "at": time.monotonic()})
        parts = path.strip("/").split("/")
        if path == "/v1/models":
            return self.respond({"object": "list", "data": [{"id": "gpt-5.4", "object": "model"}]})
        if path == "/v1/agents/sessions" and self.command == "POST":
            sid = "session-fixture-" + str(len(sessions) + 1)
            sessions[sid] = {"agent": body.get("agent", {}), "submitted": threading.Event()}
            if body.get("input"):
                sessions[sid]["submitted"].set()
            return self.respond(session_record(sid))
        if len(parts) < 4 or parts[:3] != ["v1", "agents", "sessions"]:
            return self.respond({"error": {"message": "Fixture unexpected route: " + path}}, 404)
        sid = parts[3]
        state = sessions[sid]
        suffix = parts[4:]
        if not suffix:
            if self.command == "DELETE":
                return self.respond({"id": sid, "deleted": True})
            return self.respond(session_record(sid))
        if suffix[0] == "events" and self.command == "POST":
            events = body.get("events", [])
            for event in events:
                if event["type"] == "agent.session.input.message":
                    state["input"] = "\n".join(part.get("text", "") for message in event.get("input", [])
                                                for part in message.get("content", []))
                    state["submitted"].set()
                    state["native_completed_at"] = time.monotonic()
                elif event["type"] == "agent.session.input.cancel":
                    state["cancelled"] = True
            return self.respond({"object": "list", "data": [], "has_more": False})
        if suffix[0] == "events" and self.command == "GET":
            # The SDK establishes the subscription before submitting input.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.flush()
            self.close_connection = True
            if not state["submitted"].wait(60):
                self.wfile.write(b'data: {"type":"error","error":{"message":"Fixture input never arrived"}}\n\n')
                return
            events = [
                {"type": "agent.session.turn.item.done", "session_id": sid,
                 "turn_id": "turn-" + sid, "item": items(sid)[1]},
                {"type": "agent.session.turn.completed", "session_id": sid, "turn": turn_record(sid)},
                {"type": "agent.session.idle", "session_id": sid, "session": session_record(sid)},
            ]
            data = ("".join("data: " + json.dumps(event) + "\n\n" for event in events) + "data: [DONE]\n\n").encode()
            self.wfile.write(data)
            return
        if suffix[0] == "turns":
            turns = [turn_record(sid)] if state["submitted"].is_set() else []
            return self.respond(turn_record(sid) if len(suffix) > 1 else
                                {"object": "list", "data": turns, "has_more": False})
        if suffix[0] == "items":
            return self.respond({"object": "list", "data": items(sid) if state["submitted"].is_set() else [], "has_more": False})
        if suffix[0] == "artifacts":
            return self.respond({"object": "list", "data": [], "has_more": False})
        return self.respond({"error": {"message": "Fixture unexpected route: " + path}}, 404)

    def do_GET(self):
        self.route()

    def do_POST(self):
        self.route()

    def do_DELETE(self):
        self.route()


server = http.server.ThreadingHTTPServer(("93.184.216.34", 443), Handler)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(root / "server.crt", root / "server.key")
server.socket = tls.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()

state = root / "state"
workspace = root / "workspace"
workspace.mkdir(exist_ok=True)
(workspace / "AGENTS.md").write_text("Synthetic cron proof. Reply briefly. Do not use tools.\n")
config = {
    "plugins": {"allow": ["openai", "agentsapi"], "slots": {"memory": "none"},
                "entries": {"openai": {"enabled": True}, "agentsapi": {"enabled": True,
                "config": {"nativeTools": [], "forwarding": {"gatewayTools": False, "mcpServers": False}}}}},
    "agents": {"defaults": {"workspace": str(workspace), "model": {"primary": "openai/gpt-5.4"},
                "models": {"openai/gpt-5.4": {"agentRuntime": {"id": "agentsapi"}}},
                "thinkingDefault": "off", "timeoutSeconds": 180, "skills": []}, "entries": {"main": {}}},
    "models": {"providers": {"openai": {"api": "openai-responses", "baseUrl": "https://api.openai.com/v1",
               "apiKey": "fixture-not-a-real-provider-key", "models": [{"id": "gpt-5.4", "name": "Fixture Model"}]}}},
    "gateway": {"mode": "local", "bind": "loopback", "port": 18791,
                "auth": {"mode": "token", "token": "fixture-isolated-gateway-token"}, "controlUi": {"enabled": False}},
    "tools": {"web": {"search": {"enabled": False}}},
    "logging": {"file": str(root / "gateway.log"), "level": "debug"},
}
config_path = root / "openclaw.json"
config_path.write_text(json.dumps(config))
env = dict(os.environ, OPENCLAW_STATE_DIR=str(state), OPENCLAW_CONFIG_PATH=str(config_path),
           OPENAI_API_KEY="fixture-not-a-real-provider-key", OPENCLAW_SKIP_CHANNELS="1",
           OPENCLAW_SKIP_BROWSER_CONTROL_SERVER="1", OPENCLAW_SKIP_CANVAS_HOST="1")
base = ["pnpm", "--silent", "openclaw"]


def cli(args, timeout=60, check=True):
    result = subprocess.run(base + args, env=env, capture_output=True, text=True, timeout=timeout)
    (root / ("cli-" + "-".join(args[:2]) + ".log")).write_text(result.stdout + result.stderr)
    if check and result.returncode:
        raise RuntimeError("CLI failed: " + " ".join(args) + "\n" + result.stdout + result.stderr)
    return result


gateway_log = (root / "gateway-process.log").open("w")
gateway = subprocess.Popen(base + ["gateway", "run"], env=env, stdout=gateway_log, stderr=subprocess.STDOUT,
                           start_new_session=True)
try:
    deadline = time.monotonic() + 240
    while time.monotonic() < deadline:
        if gateway.poll() is not None:
            raise RuntimeError("Gateway exited before readiness")
        try:
            with socket.create_connection(("127.0.0.1", 18791), timeout=1):
                break
        except OSError:
            time.sleep(1)
    else:
        raise RuntimeError("Gateway readiness timeout")
    created = cli(["cron", "add", "--name", "native-cleanup-proof", "--agent", "main", "--every", "1h",
                   "--session", "isolated", "--message", "Fixture cron request", "--model", "openai/gpt-5.4",
                   "--no-deliver", "--timeout-seconds", "180", "--json"], timeout=120)
    job = json.loads(created.stdout)
    job_id = job.get("id", job.get("job", {}).get("id"))
    assert job_id, created.stdout
    completed = cli(["cron", "run", job_id, "--wait", "--wait-timeout", "125s", "--poll-interval", "500ms"],
                    timeout=160, check=False)
    history = cli(["cron", "runs", job_id], timeout=30)
    recorded = json.loads(history.stdout)
    native = [entry for entry in sessions.values() if "native_completed_at" in entry]
    assert native, "Fixture never received a real native agent input"
    after_native_ms = round((time.monotonic() - native[-1]["native_completed_at"]) * 1000)
    report = {"variant": os.environ.get("VARIANT"), "nativeSessions": len(native),
              "elapsedAfterNativeMs": after_native_ms, "cliRunExit": completed.returncode,
              "history": recorded, "requests": ledger}
    (root / "result.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2), flush=True)
    assert completed.returncode == 0, "Shipped cron run did not observe completion"
    assert recorded.get("entries") and recorded["entries"][0]["status"] == "ok", "No successful durable cron history"
    assert after_native_ms < 30_000, "Native completion still blocked on cleanup"
    assert not any(entry.get("cancelled") for entry in native), "Terminal native turn was cancelled by cleanup"
    print("All shipped CLI, native cleanup and durable-history assertions passed.", flush=True)
except Exception:
    gateway_log.flush()
    print("Gateway diagnostic tail:", (root / "gateway-process.log").read_text()[-8000:], flush=True)
    print("Synthetic request ledger:", json.dumps(ledger), flush=True)
    raise
finally:
    (root / "request-ledger.json").write_text(json.dumps(ledger, indent=2))
    if gateway.poll() is None:
        os.killpg(gateway.pid, signal.SIGTERM)
        try:
            gateway.wait(timeout=20)
        except subprocess.TimeoutExpired:
            os.killpg(gateway.pid, signal.SIGKILL)
            gateway.wait(timeout=10)
    gateway_log.close()
    for proof_file in [*root.glob("*.log"), *root.glob("*.json")]:
        proof_file.chmod(0o644)
    server.shutdown()
