from consumer_setup import *
flutter=TMP/'flutter';js=TMP/'js'
installed=pathlib.Path((TMP/'flutter-installed-path.txt').read_text())
# This example adapter is imported directly from the immutable Git package checkout.
# The SDK remains resolved exclusively via the consumer's Git dependency and lock.
(flutter/'browser_consumer.dart').write_text((OUT/'browser_consumer.dart').read_text().replace('SHIPPED_BROWSER_ADAPTER',(installed/'example/lib/backend_lab/browser_transport.dart').as_uri()))
assert run('flutter-browser-compile',[str(TMP/'flutter-sdk/bin/dart'),'compile','js','--packages=.dart_tool/package_config.json','browser_consumer.dart','-o',str(js/'bundle-flutter.js')],flutter)==0
for path in ['browser_consumer.mjs','browser_runtime.mjs']:shutil.copy2(OUT/path,js/path)
assert run('js-browser-bundle',['node_modules/.bin/esbuild','browser_consumer.mjs','--bundle','--platform=browser','--format=iife','--outfile=bundle-js.js'],js)==0
short_tmp=pathlib.Path('/tmp/handrail-codex-heavy-command-locks/d1e102be-browser');short_tmp.mkdir(exist_ok=True)
ENV['TMPDIR']=str(short_tmp)
code=run('browser-runtime-unintercepted',['node','browser_runtime.mjs'],js)
shutil.copy2(js/'browser-results.json',OUT/'browser-results.json')
assert code==0
