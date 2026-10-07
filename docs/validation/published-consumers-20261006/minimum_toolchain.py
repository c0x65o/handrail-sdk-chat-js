from consumer_setup import *
import urllib.request,hashlib
manifest_url='https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json'
manifest=json.load(urllib.request.urlopen(manifest_url))
release=next(r for r in manifest['releases'] if r['version']=='3.19.0' and r['channel']=='stable')
url=manifest['base_url']+'/'+release['archive']
archive=TMP/'flutter-3.19.0.tar.xz'
if not archive.exists():
    assert run('minimum-toolchain-download',['curl','--fail','--location','--max-time','270','--output',str(archive),url],TMP)==0
h=hashlib.sha256()
with archive.open('rb') as f:
    for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
assert h.hexdigest()==release['sha256']
(OUT/'minimum-toolchain-provenance.json').write_text(json.dumps({'manifest_url':manifest_url,'archive_url':url,'release':release,'actual_sha256':h.hexdigest()},indent=2)+'\n')
minimum=TMP/'minimum-toolchain';minimum.mkdir(exist_ok=True)
assert run('minimum-toolchain-extract',['tar','-xJf',str(archive),'-C',str(minimum)],TMP)==0
ENV['PUB_CACHE']=str(TMP/'pub-cache-minimum')
ENV['PATH']=str(minimum/'flutter/bin')+os.pathsep+ENV['PATH']
flutter=str(minimum/'flutter/bin/flutter')
assert run('minimum-flutter-version',[flutter,'--version'],TMP)==0
consumer=TMP/'flutter-minimum';consumer.mkdir(exist_ok=True)
shutil.copy2(TMP/'flutter/pubspec.yaml',consumer/'pubspec.yaml')
assert run('minimum-flutter-pub-get',[flutter,'pub','get','--no-example'],consumer)==0
for name in ['pubspec.yaml','pubspec.lock']:shutil.copy2(consumer/name,OUT/('minimum-flutter-'+name))
shutil.copy2(consumer/'.dart_tool/package_config.json',OUT/'minimum-flutter-package-config.json')
assert run('minimum-flutter-graph',[flutter,'pub','deps','--json'],consumer)==0
from urllib.parse import urlparse,unquote
config=json.loads((consumer/'.dart_tool/package_config.json').read_text())
installed=pathlib.Path(unquote(urlparse(next(p for p in config['packages'] if p['name']=='handrail_chat')['rootUri']).path))
(TMP/'minimum-flutter-installed-path.txt').write_text(str(installed))
assert subprocess.check_output(['git','-C',str(installed),'rev-parse','HEAD'],text=True).strip()=='51cf4d55ea147fd71267787b774585278ed1f55a'
shutil.copytree(TMP/'flutter/test',consumer/'test',dirs_exist_ok=True)
p=consumer/'test/command_retry_after_test.dart';p.write_text(p.read_text().replace((TMP/'pub-cache').as_uri(),(TMP/'pub-cache-minimum').as_uri()))
assert run('minimum-flutter-regressions',[flutter,'test','--no-pub','--concurrency=2','--reporter=expanded','test'],consumer)==0
assert run('minimum-flutter-consumer-analyze',[flutter,'analyze','--no-pub','test'],consumer)==0
(installed/'.dart_tool').mkdir(exist_ok=True)
shutil.copy2(consumer/'.dart_tool/package_config.json',installed/'.dart_tool/package_config.json')
test_root=pathlib.Path(unquote(urlparse(next(p for p in config['packages'] if p['name']=='test')['rootUri']).path))
assert run('minimum-flutter-public-core-guard',[str(minimum/'flutter/bin/dart'),'--packages='+str(consumer/'.dart_tool/package_config.json'),str(test_root/'bin/test.dart'),'--concurrency=2','--reporter=expanded','test/core_import_boundary_test.dart'],installed)==0
analysis=TMP/'minimum-flutter-source-analysis';analysis.mkdir(exist_ok=True)
for directory in ['lib','test','examples','example']:
    shutil.copytree(installed/directory,analysis/directory,dirs_exist_ok=True,ignore=shutil.ignore_patterns('.dart_tool','build'))
for name in ['pubspec.yaml','analysis_options.yaml']:shutil.copy2(installed/name,analysis/name)
(analysis/'.dart_tool').mkdir(exist_ok=True)
shutil.copy2(consumer/'.dart_tool/package_config.json',analysis/'.dart_tool/package_config.json')
assert run('minimum-flutter-full-source-analyze',[flutter,'analyze','--no-pub','lib','test'],analysis)==1
import re
issues=lambda text: sorted(re.findall(r'info • (.+)',text))
assert issues((OUT/'minimum-flutter-full-source-analyze.txt').read_text())==issues((ROOT/'handrail-sdk-chat-flutter/docs/validation/command-retry-after-20261006/analyze.txt').read_text())
assert not subprocess.check_output(['git','-C',str(installed),'status','--porcelain','--untracked-files=no']).strip()
