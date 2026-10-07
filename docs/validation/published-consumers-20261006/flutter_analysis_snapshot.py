from consumer_setup import *
import re,hashlib,gzip
consumer=TMP/'flutter';installed=pathlib.Path((TMP/'flutter-installed-path.txt').read_text());flutter=str(TMP/'flutter-sdk/bin/flutter')
# Supplemental source analysis only. SDK consumer dependency remains the installed
# immutable Git package. The analyzer will not honor nested configs in a pub cache.
analysis=TMP/'flutter-source-analysis';analysis.mkdir(exist_ok=True)
for directory in ['lib','test','examples','example']:
    shutil.copytree(installed/directory,analysis/directory,dirs_exist_ok=True,ignore=shutil.ignore_patterns('.dart_tool','build'))
shutil.copy2(installed/'analysis_options.yaml',analysis/'analysis_options.yaml')
shutil.copy2(installed/'pubspec.yaml',analysis/'pubspec.yaml')
(analysis/'.dart_tool').mkdir(exist_ok=True)
shutil.copy2(consumer/'.dart_tool/package_config.json',analysis/'.dart_tool/package_config.json')
assert run('flutter-qualified-source-analysis',[flutter,'analyze','--no-pub','lib/src/core/command_dispatcher.dart','lib/src/handrail_chat_client.dart','test/command_retry_after_test.dart','test/send_message_client_test.dart'],analysis)==0
code=run('flutter-full-source-analysis',[flutter,'analyze','--no-pub','lib','test'],analysis)
assert code==1,code
baseline=(ROOT/'handrail-sdk-chat-flutter/docs/validation/command-retry-after-20261006/analyze.txt').read_text()
current=(OUT/'flutter-full-source-analysis.txt').read_text()
issues=lambda s:sorted(re.findall(r'info • (.+)',s))
assert len(issues(current))==13 and issues(current)==issues(baseline),(issues(current),issues(baseline))
hash=lambda b:hashlib.sha256(b).hexdigest()
tracked=subprocess.check_output(['git','-C',str(installed),'ls-files','-z']).decode().split('\0')
source_hashes={}
for name in filter(None,tracked):
    data=(installed/name).read_bytes()
    assert data==subprocess.check_output(['git','-C',str(installed),'show','HEAD:'+name]),name
    source_hashes[name]=hash(data)
    if name.startswith(('lib/','test/')):assert data==(analysis/name).read_bytes()
(OUT/'flutter-installed-source-hashes.json').write_text(json.dumps(source_hashes,indent=2)+'\n')
assert not subprocess.check_output(['git','-C',str(installed),'status','--porcelain','--untracked-files=no']).strip()
for name in ['flutter-full-analyze-baseline.txt','flutter-qualified-files-analyze.txt']:
    p=OUT/name
    with gzip.open(str(p)+'.gz','wb') as f:f.write(p.read_bytes())
    p.write_text('Analyzer context failure (pub-cache nested config ignored), not a release finding. Full original log preserved in '+name+'.gz\n')
print('PASS: unchanged installed/source-analysis bytes; exact 13 baseline infos (failed gate retained)',flush=True)
