from consumer_setup import *
import hashlib
js=TMP/'js';installed=js/'node_modules/@handrail/chat'
source=ROOT/'handrail-sdk-chat-js'
candidate=json.loads((installed/'dist/candidate.json').read_text())
shutil.copy2(installed/'dist/candidate.json',OUT/'js-installed-candidate.json')
archive=json.loads((source/'docs/validation/command-retry-after-20261006/provenance.json').read_text())
hash=lambda b:hashlib.sha256(b).hexdigest()
normalized=[]
for name,expected in candidate['source']['files']:
    data=(source/name).read_bytes()
    assert hash(data)==expected,name
    if name in ['package.json','package-lock.json','src/client/generated/package-version.ts']:
        data=data.replace(b'1.0.53',b'1.0.52')
    normalized.append([name,hash(data)])
assert hash(json.dumps(normalized,separators=(',',':'),ensure_ascii=False).encode())==archive['js_normal_build_candidate']['source_sha256']
for name,expected in candidate['package']['files']:
    assert hash((installed/name).read_bytes())==expected,name
for name,expected in archive['js_built_artifact_sha256'].items():
    if name!='dist/candidate.json':assert hash((installed/name).read_bytes())==expected,name
print('PASS: entire installed candidate source fingerprint reconciles with archived qualified source via three version-only files; all installed artifact hashes verified',flush=True)
(js/'test').mkdir(exist_ok=True)
tests=['command-retry-after.test.mjs','client-command-dispatcher.test.mjs','client-durable-send-dispatch.test.mjs','client-durable-read-state.test.mjs']
for name in tests:
    text=(source/'test'/name).read_text().replace('../dist/client/index.js','@handrail/chat/client').replace('../dist/index.js','@handrail/chat')
    (js/'test'/name).write_text(text)
assert run('js-installed-regressions',['node','--test','--test-concurrency=1',*['test/'+n for n in tests]],js)==0
shutil.copy2(source/'test/fixtures/declarations.ts',js/'declarations.ts')
assert run('js-installed-types',['node','node_modules/typescript/bin/tsc','--ignoreConfig','--noEmit','--strict','--skipLibCheck','--target','ES2022','--module','NodeNext','--moduleResolution','NodeNext','declarations.ts'],js)==0
shutil.copy2(OUT/'js_checks.mjs',js/'js_checks.mjs')
assert run('js-installed-exports-browser',['node','js_checks.mjs'],js)==0
shutil.copy2(js/'exports-browser-graph.json',OUT/'js-exports-browser-graph.json')
