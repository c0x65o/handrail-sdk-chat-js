#!/usr/bin/env python3
"""Disposable source/consumer checks. No repository installs or service changes.

Usage: python3 verify.py SDK_PATH LABEL SCRATCH_PATH FLUTTER_REPO_PATH
Run labels sequentially. Each scratch path must be new.
"""
import hashlib
import json
import os
from pathlib import Path
import resource
import shutil
import subprocess
import sys
import time

sdk, label, scratch, source = map(Path, sys.argv[1:])
label = str(label)
out = Path(__file__).resolve().parent / label
out.mkdir()
scratch.mkdir()
package = scratch / 'package'
package.mkdir()
for name in ['lib', 'test', 'contracts']:
    if (source / name).exists():
        shutil.copytree(source / name, package / name)
for name in ['pubspec.yaml', 'analysis_options.yaml']:
    shutil.copy2(source / name, package / name)
(out / 'input-sha256.json').write_text(json.dumps({
    str(p.relative_to(package)): hashlib.sha256(p.read_bytes()).hexdigest()
    for p in sorted(package.rglob('*')) if p.is_file()
}, indent=2)+'\n')
env = dict(os.environ, FLUTTER_ROOT=str(sdk), PUB_CACHE=str(scratch / 'pub-cache'),
           CI='true', FLUTTER_SUPPRESS_ANALYTICS='true', DART_SUPPRESS_ANALYTICS='true')
env.pop('FLUTTER_ALREADY_LOCKED', None)
env.pop('HANDRAIL_WIDGET_EVIDENCE_DIR', None)
env['PATH'] = str(sdk / 'bin') + os.pathsep + env['PATH']
flutter = str(sdk / 'bin/flutter')
dart = str(sdk / 'bin/cache/dart-sdk/bin/dart')
results = []

def run(name, command, cwd=package):
    start = time.time()
    with (out / (name + '.log')).open('w') as log:
        log.write('cwd: ' + str(cwd) + '\ncommand: ' + json.dumps(command) + '\n')
        log.flush()
        result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    row = dict(name=name, command=command, cwd=str(cwd), exit_code=result.returncode,
               elapsed_seconds=round(time.time()-start, 2),
               children_max_rss_kib=resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss)
    results.append(row)
    (out / 'results.json').write_text(json.dumps(dict(environment={k:env[k] for k in
        ['FLUTTER_ROOT','PUB_CACHE','CI','FLUTTER_SUPPRESS_ANALYTICS','DART_SUPPRESS_ANALYTICS']},
        checks=results), indent=2)+'\n')
    print(name, result.returncode, flush=True)
    return result.returncode

run('version', [flutter, '--version', '--machine'])
if run('package-resolution', [flutter, 'pub', 'get', '--no-example']):
    sys.exit(1)
shutil.copy2(package / 'pubspec.lock', out / 'package.pubspec.lock')
run('public-library-analysis', [dart, 'analyze', 'lib'])
run('scoped-analysis', [dart, 'analyze', 'lib/src/handrail_chat_workspace.dart',
    'lib/src/handrail_message_composer.dart', 'lib/src/handrail_chat_theme.dart',
    'lib/src/handrail_huddle_panel.dart', 'test/handrail_message_composer_test.dart',
    'test/handrail_reply_routing_cases.dart', 'test/handrail_thread_discovery_cases.dart',
    'test/handrail_reply_style_settings_test.dart', 'test/handrail_thread_lifecycle_cases.dart'])
run('regressions', [flutter, 'test', '--no-pub', '--concurrency=2', '--reporter=expanded',
    'test/durable_resource_event_reducer_test.dart',
    'test/handrail_message_composer_test.dart', 'test/handrail_chat_theme_test.dart',
    'test/handrail_reply_style_settings_test.dart',
    'test/reply_style_runtime_test.dart', 'test/reply_style_client_test.dart',
    'test/handrail_timeline_reply_reference_test.dart', 'test/handrail_thread_view_test.dart',
    'test/thread_list_controller_test.dart', 'test/thread_lifecycle_controller_test.dart'])
run('workspace-reply-navigation', [flutter, 'test', '--no-pub', '--concurrency=2',
    '--reporter=expanded', 'test/handrail_chat_workspace_test.dart', '--name',
    'reply routing|named thread|thread discovery'])
consumer = scratch / 'consumer'
(consumer / 'test').mkdir(parents=True)
(consumer / 'pubspec.yaml').write_text('''name: handrail_compatibility_consumer
publish_to: none
environment:
  sdk: ">=3.3.0 <4.0.0"
  flutter: ">=3.19.0"
dependencies:
  flutter:
    sdk: flutter
  handrail_chat:
    path: ../package
dev_dependencies:
  flutter_test:
    sdk: flutter
''')
# The local path is only a disposable uncommitted-artifact fixture, never an
# installation into a project consumer or a replacement for public Git pins.
shutil.copy2(Path(__file__).parent / 'public_import_test.dart', consumer / 'test/public_import_test.dart')
if run('consumer-resolution', [flutter, 'pub', 'get'], consumer) == 0:
    shutil.copy2(consumer / 'pubspec.lock', out / 'consumer.pubspec.lock')
    run('consumer-analysis', [dart, 'analyze', 'test'], consumer)
    run('consumer-widget', [flutter, 'test', '--no-pub', '--concurrency=2',
        '--reporter=expanded', 'test/public_import_test.dart'], consumer)
sys.exit(int(any(row['exit_code'] for row in results)))
