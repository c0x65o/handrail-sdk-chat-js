from consumer_setup import *
consumer=TMP/'flutter';installed=pathlib.Path((TMP/'flutter-installed-path.txt').read_text())
(installed/'.dart_tool').mkdir(exist_ok=True)
shutil.copy2(consumer/'.dart_tool/package_config.json',installed/'.dart_tool/package_config.json')
config=json.loads((consumer/'.dart_tool/package_config.json').read_text())
from urllib.parse import urlparse,unquote
test_root=pathlib.Path(unquote(urlparse(next(p for p in config['packages'] if p['name']=='test')['rootUri']).path))
assert run('flutter-installed-public-core-guard-direct',[str(TMP/'flutter-sdk/bin/dart'),'--packages='+str(consumer/'.dart_tool/package_config.json'),str(test_root/'bin/test.dart'),'--concurrency=2','--reporter=expanded','test/core_import_boundary_test.dart'],installed)==0
