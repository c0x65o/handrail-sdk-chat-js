#!/usr/bin/env python3
"""Rerun repaired test fixtures in an existing disposable check directory."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sdk, label, scratch, source = map(Path, sys.argv[1:])
out = Path(__file__).resolve().parent / str(label)
env = dict(os.environ, FLUTTER_ROOT=str(sdk), PUB_CACHE=str(scratch / 'pub-cache'),
    CI='true', FLUTTER_SUPPRESS_ANALYTICS='true', DART_SUPPRESS_ANALYTICS='true')
env.pop('FLUTTER_ALREADY_LOCKED', None)
env['PATH'] = str(sdk / 'bin') + os.pathsep + env['PATH']
package = scratch / 'package'
for name in ['handrail_reply_style_settings_test.dart', 'handrail_huddle_panel_test.dart']:
    shutil.copy2(source / 'test' / name, package / 'test' / name)
shutil.copy2(Path(__file__).parent / 'public_import_test.dart', scratch / 'consumer/test/public_import_test.dart')
flutter = str(sdk / 'bin/flutter')
prefix = [flutter, 'test', '--no-pub', '--concurrency=2', '--reporter=expanded']
checks = [
    ('settings', package, prefix + ['test/handrail_reply_style_settings_test.dart']),
    ('consumer-widget', scratch / 'consumer', prefix + ['test/public_import_test.dart']),
    ('fixture-analysis', package, [str(sdk / 'bin/cache/dart-sdk/bin/dart'), 'analyze',
        'test/handrail_reply_style_settings_test.dart', 'test/handrail_huddle_panel_test.dart']),
]
results = []
for name, cwd, command in checks:
    with (out / ('final-' + name + '.log')).open('w') as log:
        log.write('cwd: ' + str(cwd) + '\ncommand: ' + json.dumps(command) + '\n')
        log.flush()
        result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT)
    results.append(dict(name=name, command=command, cwd=str(cwd), exit_code=result.returncode))
    (out / 'final-results.json').write_text(json.dumps(results, indent=2)+'\n')
    print(name, result.returncode, flush=True)
sys.exit(int(any(r['exit_code'] for r in results)))
