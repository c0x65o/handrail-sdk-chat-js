import hashlib,json,pathlib,subprocess,urllib.request
ROOT=pathlib.Path('/opt/handrail/repos/handrail/handrail-chat')
OUT=pathlib.Path(__file__).resolve().parent
pins={'js':('handrail-sdk-chat-js','5cc37c0aad6bf4f74c4e849f62ae51badb124dca','1.0.53','1.0.52'), 'flutter':('handrail-sdk-chat-flutter','51cf4d55ea147fd71267787b774585278ed1f55a','0.1.31','0.1.30')}
manifest=json.loads((ROOT/'handrail-sdk-chat-js/docs/validation/command-retry-after-20261006/provenance.json').read_text())
hash=lambda data:hashlib.sha256(data).hexdigest()
result={}
for sdk,(repo,sha,new,old) in pins.items():
    remote=subprocess.check_output(['git','-c','credential.helper=','ls-remote',f'https://github.com/c0x65o/{repo}.git','HEAD','refs/heads/main'],text=True)
    assert sha in remote
    files={}
    for path,expected in manifest['source_and_test_sha256'][sdk].items():
        data=urllib.request.urlopen(f'https://raw.githubusercontent.com/c0x65o/{repo}/{sha}/{path}').read()
        actual=hash(data)
        normalized=data
        if path=='package.json': normalized=data.replace(f'"version": "{new}"'.encode(),f'"version": "{old}"'.encode(),1)
        if path=='package-lock.json': normalized=data.replace(f'"version": "{new}"'.encode(),f'"version": "{old}"'.encode(),2)
        if path=='pubspec.yaml': normalized=data.replace(f'version: {new}'.encode(),f'version: {old}'.encode(),1)
        assert hash(normalized)==expected,(path,actual,expected)
        assert data==(ROOT/repo/path).read_bytes(),path
        files[path]={'published_sha256':actual,'qualified_sha256':expected,'matches_qualified':actual==expected,'matches_after_version_only_normalization':hash(normalized)==expected}
    generated='src/client/generated/package-version.ts' if sdk=='js' else 'lib/src/package_metadata.dart'
    data=urllib.request.urlopen(f'https://raw.githubusercontent.com/c0x65o/{repo}/{sha}/{generated}').read()
    assert new.encode() in data and data==(ROOT/repo/generated).read_bytes()
    result[sdk]={'sha':sha,'version':new,'public_https_ls_remote':remote,'files':files,'generated_version':{'path':generated,'sha256':hash(data),'content':data.decode()},'baseline_diff_paths':subprocess.check_output(['git','-C',str(ROOT/repo),'diff','--name-only',manifest['baselines'][sdk]['sha'],sha],text=True).splitlines()}
(OUT/'source-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print('PASS: public immutable files match qualified hashes, allowing only exact package version substitutions; generated mirrors match.')
