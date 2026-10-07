from consumer_setup import *
import re,urllib.parse
if __name__=='__main__':
    sdk=TMP/'flutter-sdk'
    if not sdk.exists():
        assert run('flutter-private-toolchain-copy',['cp','-a','--reflink=auto','/opt/handrail/.handrail/flutter-sdk',str(sdk)],TMP)==0
    ENV['PATH']=str(sdk/'bin')+os.pathsep+ENV['PATH']
    # SDK copy is private; no shared toolchain/cache is made writable.
    flutter=str(sdk/'bin/flutter')
    assert run('flutter-version',[flutter,'--version'],TMP)==0
    consumer=TMP/'flutter';consumer.mkdir(exist_ok=True)
    (consumer/'pubspec.yaml').write_text('''name: published_chat_consumer
publish_to: none
version: 1.0.0
environment:
  sdk: '>=3.3.0 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  handrail_chat:
    git:
      url: https://github.com/c0x65o/handrail-sdk-chat-flutter.git
      ref: 51cf4d55ea147fd71267787b774585278ed1f55a
  web: 0.5.1
dev_dependencies:
  flutter_test:
    sdk: flutter
  test: ^1.24.9
  flutter_lints: ^4.0.0
''')
    assert run('flutter-pub-get',[flutter,'pub','get','--no-example'],consumer)==0
    for name in ['pubspec.yaml','pubspec.lock']:shutil.copy2(consumer/name,OUT/('flutter-'+name))
    config=json.loads((consumer/'.dart_tool/package_config.json').read_text())
    installed=next(p for p in config['packages'] if p['name']=='handrail_chat')
    path=pathlib.Path(urllib.parse.unquote(urllib.parse.urlparse(installed['rootUri']).path))
    (TMP/'flutter-installed-path.txt').write_text(str(path))
    assert subprocess.check_output(['git','-C',str(path),'rev-parse','HEAD'],text=True).strip()=='51cf4d55ea147fd71267787b774585278ed1f55a'
    shutil.copy2(consumer/'.dart_tool/package_config.json',OUT/'flutter-package-config.json')
    assert run('flutter-package-graph',[flutter,'pub','deps','--json'],consumer)==0
    tests=['command_retry_after_test.dart','command_dispatcher_test.dart','durable_resource_event_reducer_test.dart','send_message_client_test.dart','offline_send_message_queue_test.dart','offline_send_message_queue_pump_test.dart','read_cursor_runtime_test.dart','reply_unread_refresh_client_test.dart','realtime_session_transport_test.dart']
    (consumer/'test').mkdir(exist_ok=True)
    for name in tests:
        text=(path/'test'/name).read_text()
        if name=='command_retry_after_test.dart':text=text.replace("../examples/flutter-erp/lib/erp_chat_host.dart",(path/'examples/flutter-erp/lib/erp_chat_host.dart').as_uri())
        if name=='send_message_client_test.dart':
            text=re.sub(r"import 'package:handrail_chat/src/[^']+';\n",'',text)
            text="import 'package:handrail_chat/core.dart';\n"+text
        (consumer/'test'/name).write_text(text)
    shutil.copytree(path/'test/fixtures',consumer/'test/fixtures',dirs_exist_ok=True)
    assert run('flutter-installed-regressions-complete-fixtures',[flutter,'test','--no-pub','--concurrency=2','--reporter=expanded',*['test/'+p for p in tests]],consumer)==0
    assert run('flutter-consumer-analyze',[flutter,'analyze','--no-pub','test'],consumer)==0
