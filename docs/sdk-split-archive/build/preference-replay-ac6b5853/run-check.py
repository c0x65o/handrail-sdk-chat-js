import datetime,json,os,pathlib,subprocess,sys,time
out=pathlib.Path(__file__).resolve().parent
root=out.parent.parent
name=sys.argv[1]
cmd=['/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart','/opt/handrail/.handrail/flutter-sdk/bin/cache/flutter_tools.snapshot','--no-version-check',*sys.argv[2:]]
env=dict(os.environ,FLUTTER_ALREADY_LOCKED='true')
start=time.monotonic()
meta={'command':cmd,'environment_overrides':{'FLUTTER_ALREADY_LOCKED':'true'},'cwd':str(root/'flutter/handrail_chat'),'started_at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
with (out/(name+'.stdout.log')).open('w') as stdout,(out/(name+'.stderr.log')).open('w') as stderr:
 result=subprocess.run(cmd,cwd=meta['cwd'],env=env,stdout=stdout,stderr=stderr)
meta.update(exit_status=result.returncode,elapsed_seconds=time.monotonic()-start)
(out/(name+'.json')).write_text(json.dumps(meta,indent=2)+'\n')
print(json.dumps(meta))
print((out/(name+'.stdout.log')).read_text()[-3500:])
print((out/(name+'.stderr.log')).read_text()[-1500:])
sys.exit(result.returncode)
