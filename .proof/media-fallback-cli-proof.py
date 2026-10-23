"""Own synthetic HTTP transport; product owners execute unmodified in secretless CI."""
import hashlib
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
import urllib.request

root = Path(os.environ['PROOF_ROOT'])
root.mkdir(parents=True, exist_ok=True)
ledger = []
release_video = threading.Event()
completion_entered = threading.Event()
release_completion = threading.Event()
completion_requests = []
mp4 = (root / 'fixture.mp4').read_bytes()
class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *_): pass
    def send(self, value, status=200, mime='application/json'):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def route(self):
        path = self.path.split('?')[0]
        body_bytes = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        body = json.loads(body_bytes or b'{}')
        ledger.append({'host': self.headers.get('Host'), 'method': self.command, 'path': path, 'at': time.monotonic()})
        if path == '/v1/models': return self.send({'object':'list','data':[{'id':'fixture-model','object':'model'}]})
        if path == '/v1/chat/completions':
            serialized = json.dumps(body)
            completing = 'completed successfully' in serialized or ('video_generate' in serialized and 'task_completion' in serialized)
            if completing:
                completion_requests.append(body)
                completion_entered.set()
                if not release_completion.wait(90): raise RuntimeError('Completion transport gate timed out')
            text = 'Video generated successfully by xai/grok-imagine-video.' if completing else 'Fixture session initialized.'
            chunk = {'id':'chatcmpl-fixture','object':'chat.completion.chunk','created':1,'model':'fixture-model',
                     'choices':[{'index':0,'delta':{'role':'assistant','content':text},'finish_reason':'stop'}],
                     'usage':{'prompt_tokens':20,'completion_tokens':5,'total_tokens':25}}
            return self.send(('data: '+json.dumps(chunk)+'\n\ndata: [DONE]\n\n').encode(), mime='text/event-stream')
        if path == '/fal-ai/minimax/video-01-live':
            if not release_video.wait(60): raise RuntimeError('Initial status transport gate timed out')
            return self.send({'error':{'message':'Synthetic primary media rejection'}}, 400)
        if path == '/v1/videos/generations': return self.send({'request_id':'video-fixture'})
        if path == '/v1/videos/video-fixture': return self.send({'status':'done','video':{'url':'https://api.x.ai/fixture.mp4'}})
        if path == '/fixture.mp4': return self.send(mp4, mime='video/mp4')
        return self.send({'error':{'message':'Unexpected fixture path '+path}},404)
    def do_GET(self):
        try: self.route()
        except Exception: traceback.print_exc(); self.close_connection=True
    do_POST = do_GET
server = http.server.ThreadingHTTPServer(('93.184.216.34',443), Handler)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(root/'server.crt', root/'server.key')
server.socket = tls.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever,daemon=True).start()
state = root/'state'
workspace=root/'workspace'
workspace.mkdir(exist_ok=True)
(workspace/'AGENTS.md').write_text('Synthetic isolated media proof. Reply briefly.\n')
config = {
 'plugins': {'allow':['openai','fal','xai'], 'slots':{'memory':'none'}, 'entries':{p:{'enabled':True} for p in ['openai','fal','xai']}},
 'env':{'shellEnv':{'enabled':False}},
 'agents':{'defaults':{'workspace':str(workspace),'model':{'primary':'proof-model/fixture-model'},
                     'models':{'proof-model/fixture-model':{'agentRuntime':{'id':'openclaw'}}},
                     'mediaModels':{'video':{'primary':'fal/fal-ai/minimax/video-01-live','fallbacks':['xai/grok-imagine-video']}},
                     'thinkingDefault':'off','timeoutSeconds':180,'skills':[]},'entries':{'main':{}}},
 'models':{'providers':{
  'proof-model':{'api':'openai-completions','apiKey':'synthetic-model-key','baseUrl':'https://proof-model.test/v1','models':[{'id':'fixture-model','name':'Synthetic model','reasoning':False,'input':['text'],'contextWindow':32000,'maxTokens':1024}]},
  'fal':{'baseUrl':'https://proof-model.test','apiKey':'synthetic-fal-key','models':[]},
  'xai':{'baseUrl':'https://api.x.ai/v1','apiKey':'synthetic-xai-key','models':[]}}},
 'gateway':{'mode':'local','bind':'loopback','port':18792,'auth':{'mode':'token','token':'synthetic-media-gateway-token'},'controlUi':{'enabled':False}},
 'tools':{'web':{'search':{'enabled':False}}},
 'logging':{'file':str(root/'gateway.log'),'level':'debug'}}
config_path=root/'openclaw.json'
config_path.write_text(json.dumps(config))
env=dict(os.environ, OPENCLAW_STATE_DIR=str(state), OPENCLAW_CONFIG_PATH=str(config_path),
         OPENCLAW_SKIP_CHANNELS='1', OPENCLAW_SKIP_BROWSER_CONTROL_SERVER='1', OPENCLAW_SKIP_CANVAS_HOST='1')
base=['pnpm','--silent','openclaw']
def cli(args, timeout=90):
    result=subprocess.run(base+args,env=env,capture_output=True,text=True,timeout=timeout)
    (root/('cli-'+ '-'.join(args[:2])+'.log')).write_text(result.stdout+result.stderr)
    assert result.returncode == 0, result.stdout+result.stderr
    return json.loads(result.stdout[result.stdout.find('{'):])
def invoke(args):
    req=urllib.request.Request('http://127.0.0.1:18792/tools/invoke', data=json.dumps({'tool':'video_generate','args':args,'sessionKey':'agent:main:main'}).encode(),
        headers={'Authorization':'Bearer synthetic-media-gateway-token','Content-Type':'application/json','x-openclaw-message-channel':'webchat'})
    with urllib.request.urlopen(req,timeout=60) as response:
        value=json.load(response)
    assert value.get('ok'),value
    return value['result']
log=(root/'gateway-process.log').open('w')
gateway=subprocess.Popen(base+['gateway','run'],env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
report={'source':os.environ['SOURCE_SHA'],'variant':os.environ['VARIANT']}
try:
    deadline=time.monotonic()+240
    while time.monotonic()<deadline:
        assert gateway.poll() is None,'Gateway exited during startup'
        try:
            with socket.create_connection(('127.0.0.1',18792),timeout=1): break
        except OSError: time.sleep(1)
    else: raise RuntimeError('Gateway readiness timeout')
    report['initialTurn']=cli(['agent','--agent','main','--session-key','agent:main:main','--message','Initialize the fixture conversation.','--thinking','off','--timeout','120','--json'],150)
    launched=invoke({'prompt':'Create a tiny synthetic sunset video.','filename':'fallback-proof.mp4'})
    report['launched']=launched
    assert launched['details'].get('async') is True,launched
    initial=invoke({'action':'status'})
    report['initialStatus']=initial
    assert initial['details']['provider']=='fal',initial
    release_video.set()
    assert completion_entered.wait(90),'No real completion model request reached HTTP fixture'
    during=invoke({'action':'status'})
    report['deliveryStatus']=during
    serialized=json.dumps(completion_requests)
    assert 'xai' in serialized and 'grok-imagine-video' in serialized,'Real completion wake lacks successful candidate attribution'
    files=list((state/'media').rglob('*.mp4'))
    report['savedMedia']=[{'name':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files]
    assert any(p.read_bytes()==mp4 for p in files),'Real media save did not retain provider bytes'
    release_completion.set()
    deadline=time.monotonic()+60
    while time.monotonic()<deadline:
        final=invoke({'action':'status'})
        if not final['details'].get('active'): break
        time.sleep(.25)
    report['finalStatus']=final
    assert final['details'].get('active') is False,'Completion failed to settle media owner'
    history=cli(['gateway','call','chat.history','--params',json.dumps({'sessionKey':'agent:main:main','limit':20}),'--json'])
    report['history']=history
    history_text=json.dumps(history)
    assert 'Video generated successfully by xai/grok-imagine-video.' in history_text,'Real completion reply is absent from conversation history'
    assert 'fallback-proof' in history_text or any(p.name in history_text for p in files),'Delivered conversation has no saved media attachment'
    assert during['details']['progressSummary']=='Generated media; delivering completion',during
    assert during['details']['provider']=='xai', 'Actual fallback status still names initial provider'
    assert during['details']['model']=='grok-imagine-video',during
    assert during['details']['sourceId']=='video_generate:fal',during
    print('PASS: real detached media fallback, save, completion delivery and status agree.',flush=True)
except Exception as error:
    report['error']=str(error)
    print('Gateway diagnostic tail:',(root/'gateway-process.log').read_text()[-8000:],flush=True)
    raise
finally:
    release_video.set();release_completion.set()
    report['requests']=ledger
    report['completionRequests']=completion_requests
    (root/'result.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report,indent=2),flush=True)
    if gateway.poll() is None:
        os.killpg(gateway.pid,signal.SIGTERM)
        try: gateway.wait(timeout=20)
        except subprocess.TimeoutExpired: os.killpg(gateway.pid,signal.SIGKILL);gateway.wait(timeout=10)
    log.close()
    for p in [*root.glob('*.log'),*root.glob('*.json')]:p.chmod(0o644)
    server.shutdown()
