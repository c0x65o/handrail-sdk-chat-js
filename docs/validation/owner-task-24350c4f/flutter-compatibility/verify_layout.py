#!/usr/bin/env python3
"""Verify final bounded thread-layout repair using an already resolved sandbox."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sdk, label, scratch, source = map(Path, sys.argv[1:])
out = Path(__file__).resolve().parent / str(label)
package = scratch / 'package'
env = dict(os.environ, FLUTTER_ROOT=str(sdk), PUB_CACHE=str(scratch / 'pub-cache'),
    CI='true', FLUTTER_SUPPRESS_ANALYTICS='true', DART_SUPPRESS_ANALYTICS='true')
env.pop('FLUTTER_ALREADY_LOCKED', None)
env['PATH'] = str(sdk / 'bin') + os.pathsep + env['PATH']
paths = ['lib/src/handrail_thread_view.dart', 'test/handrail_thread_lifecycle_cases.dart']
for name in paths:
    shutil.copy2(source / name, package / name)
(out / 'layout-input-sha256.json').write_text(json.dumps({p:
    hashlib.sha256((package / p).read_bytes()).hexdigest() for p in paths}, indent=2)+'\n')
flutter = str(sdk / 'bin/flutter')
prefix = [flutter, 'test', '--no-pub', '--concurrency=2', '--reporter=expanded']
checks = [
    ('layout-analysis', [str(sdk / 'bin/cache/dart-sdk/bin/dart'), 'analyze',
        'lib/src/handrail_thread_view.dart', 'test/handrail_thread_view_test.dart']),
    ('layout-thread-regressions', prefix + ['test/handrail_thread_view_test.dart']),
    ('layout-workspace-regressions', prefix + ['test/handrail_chat_workspace_test.dart',
        '--name', 'reply routing|named thread|thread discovery']),
    ('layout-consumer-widget', prefix + ['test/public_import_test.dart']),
]
results = []
for name, command in checks:
    cwd = scratch / 'consumer' if name == 'layout-consumer-widget' else package
    with (out / (name + '.log')).open('w') as log:
        log.write('cwd: ' + str(cwd) + '\ncommand: ' + json.dumps(command) + '\n')
        log.flush()
        result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    results.append(dict(name=name, command=command, cwd=str(cwd), exit_code=result.returncode))
    (out / 'layout-results.json').write_text(json.dumps(results, indent=2)+'\n')
    print(name, result.returncode, flush=True)
sys.exit(int(any(r['exit_code'] for r in results)))
