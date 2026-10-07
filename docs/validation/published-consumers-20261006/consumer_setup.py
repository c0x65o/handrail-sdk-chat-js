import json,os,pathlib,shutil,subprocess,time
ROOT=pathlib.Path('/opt/handrail/repos/handrail/handrail-chat')
OUT=pathlib.Path(__file__).resolve().parent
TMP=pathlib.Path('/opt/handrail/.handrail/codex-runs/d1e102be-9b54-4288-84d1-671b0379486a/tmp/published-consumers')
TMP.mkdir(parents=True,exist_ok=True)
ENV=os.environ.copy()
ENV.update(TMPDIR=str(TMP),npm_config_cache=str(TMP/'npm-cache'),PUB_CACHE=str(TMP/'pub-cache'),CI='true',FLUTTER_SUPPRESS_ANALYTICS='true',GIT_TERMINAL_PROMPT='0',GIT_CONFIG_GLOBAL='/dev/null',GIT_CONFIG_NOSYSTEM='1')
def run(name,args,cwd,timeout=300):
    start=time.monotonic()
    with (OUT/(name+'.txt')).open('w') as f:
        f.write(json.dumps({'command':args,'cwd':str(cwd)})+'\n'); f.flush()
        try:r=subprocess.run(args,cwd=cwd,env=ENV,stdout=f,stderr=subprocess.STDOUT,timeout=timeout);code=r.returncode
        except subprocess.TimeoutExpired:code=124
    with (OUT/'checks.jsonl').open('a') as f:f.write(json.dumps({'name':name,'command':args,'exit_code':code,'seconds':round(time.monotonic()-start,2)})+'\n')
    print(name,code,flush=True)
    return code
if __name__=='__main__':
    js=TMP/'js'; js.mkdir(exist_ok=True)
    package={'name':'published-chat-consumer','private':True,'type':'module','dependencies':{'@handrail/chat':'git+https://github.com/c0x65o/handrail-sdk-chat-js.git#5cc37c0aad6bf4f74c4e849f62ae51badb124dca','react':'19.2.7'},'devDependencies':{'typescript':'7.0.2','esbuild':'0.28.2','@types/react':'19.2.18','@types/node':'26.3.0','playwright':'1.61.1'}}
    # Use the existing tested host React version, pinned exactly.
    package['dependencies']['react']=json.loads((ROOT/'handrail-sdk-chat-js/node_modules/react/package.json').read_text())['version']
    (js/'package.json').write_text(json.dumps(package,indent=2)+'\n')
    assert run('js-preinstall-version-guard',['node','scripts/generate-package-version.mjs','--check'],ROOT/'handrail-sdk-chat-js')==0
    assert run('js-lock',['npm','install','--package-lock-only','--include=dev','--no-audit','--no-fund'],js)==0
    lock=json.loads((js/'package-lock.json').read_text());sdk=lock['packages']['node_modules/@handrail/chat'];dep=package['dependencies']['@handrail/chat']
    assert sdk['resolved'] in [dep,dep.replace('git+https://github.com/','git+ssh://git@github.com/')]
    sdk['resolved']=dep
    (js/'package-lock.json').write_text(json.dumps(lock,indent=2)+'\n')
    assert run('js-ci',['npm','ci','--include=dev','--no-audit','--no-fund','--foreground-scripts'],js)==0
    for path in ['package.json','package-lock.json']:shutil.copy2(js/path,OUT/('js-'+path))
    run('js-package-graph',['npm','ls','--all','--json'],js)
    ENV['HANDRAIL_CHAT_JS_REVISION']='5cc37c0aad6bf4f74c4e849f62ae51badb124dca'
    assert run('js-git-consumer',['npm','run','test:git-consumer'],ROOT/'handrail-sdk-chat-js')==0
