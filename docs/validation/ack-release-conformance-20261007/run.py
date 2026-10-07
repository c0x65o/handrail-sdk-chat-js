"""Bounded sequential check receipts; reuse existing SDK/cache, coordinate heavy slots."""
import os, pathlib, subprocess, json, time, sys, fcntl, signal
out=pathlib.Path(__file__).resolve().parent
js=out.parents[2]; workspace=js.parent; flutter=workspace/'handrail-sdk-chat-flutter'
name, repo, *cmd=sys.argv[1:]
assert not (out/(name+'.json')).exists(), 'Never overwrite a receipt'
base=flutter/'build/ack-release-review'
shim=workspace/'.huddle-tmp/ack-conformance-runner'
env=dict(os.environ, FLUTTER_ROOT=str(shim), DART_SDK=str(base/'current-flutter/bin/cache/dart-sdk'),
 PUB_CACHE=str(base/'pub-cache'),TMPDIR=str(base/'tmp'),FLUTTER_SUPPRESS_ANALYTICS='true',
 HANDRAIL_CHAT_FLUTTER_ROOT=str(flutter), PATH=str(shim/'bin')+os.pathsep+os.environ['PATH'])
slots=[(pathlib.Path(os.environ['HANDRAIL_CODEX_HEAVY_COMMAND_LOCK_DIR'])/f'slot-{i}.lock').open('a') for i in range(2)]
start=time.monotonic(); lock=None
while lock is None and time.monotonic()-start < 300:
 for slot in slots:
  try: fcntl.flock(slot,fcntl.LOCK_EX|fcntl.LOCK_NB);lock=slot;break
  except BlockingIOError: pass
 if lock is None: time.sleep(1)
assert lock is not None,'Heavy slot unavailable within 300s'
leaf=pathlib.Path(os.environ['HANDRAIL_CODEX_DELEGATED_CGROUP_PATH'])/'ack-conformance'
leaf.mkdir(exist_ok=True)
def heavy(): (leaf/'cgroup.procs').write_text('0')
assert (lambda s:s.f_bavail*s.f_frsize)(os.statvfs(workspace)) > 2*1024**3
start=time.monotonic()
with (out/(name+'.txt')).open('x') as log:
 child=subprocess.Popen(cmd,cwd=workspace/repo,env=env,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,preexec_fn=heavy)
 try: code=child.wait(timeout=300)
 except subprocess.TimeoutExpired:
  os.killpg(child.pid,signal.SIGTERM)
  try: child.wait(timeout=5)
  except subprocess.TimeoutExpired: os.killpg(child.pid,signal.SIGKILL);child.wait()
  code=124
result=dict(exit=code,seconds=round(time.monotonic()-start,2),command=cmd,repository=repo,timeout_seconds=300,
 current_toolchain=str(base/'current-flutter'), flutter_dispatcher=str(shim/'bin/flutter'),
 memory={p:(leaf/p).read_text().strip() for p in ['memory.peak','memory.events'] if (leaf/p).exists()})
(out/(name+'.json')).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result),flush=True)
sys.exit(code)
