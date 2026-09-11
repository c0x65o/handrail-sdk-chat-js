#!/usr/bin/env python3
"""Run after verify.py, with the same four arguments, sequentially."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

sdk, label, scratch, source = map(Path, sys.argv[1:])
out = Path(__file__).resolve().parent / str(label)
example = scratch / 'example'
shutil.copytree(source / 'example', example, ignore=shutil.ignore_patterns(
    '.dart_tool', 'build', 'pubspec.lock', 'pubspec_overrides.yaml'))
env = dict(os.environ, FLUTTER_ROOT=str(sdk), PUB_CACHE=str(scratch / 'pub-cache'),
    CI='true', FLUTTER_SUPPRESS_ANALYTICS='true', DART_SUPPRESS_ANALYTICS='true')
env.pop('FLUTTER_ALREADY_LOCKED', None)
env['PATH'] = str(sdk / 'bin') + os.pathsep + env['PATH']
results = []

def run(name, command):
    start = time.time()
    with (out / (name + '.log')).open('w') as log:
        log.write('cwd: ' + str(example) + '\ncommand: ' + json.dumps(command) + '\n')
        log.flush()
        r = subprocess.run(command, cwd=example, env=env, stdout=log, stderr=subprocess.STDOUT)
    results.append(dict(name=name, command=command, cwd=str(example),
        exit_code=r.returncode, elapsed_seconds=round(time.time()-start, 2)))
    (out / 'example-results.json').write_text(json.dumps(results, indent=2)+'\n')
    print(name, r.returncode, flush=True)
    return r.returncode

flutter = str(sdk / 'bin/flutter')
dart = str(sdk / 'bin/cache/dart-sdk/bin/dart')
# Resolve the actual HTTPS Git pin first and retain its matching lock.
if run('example-pinned-resolution', [flutter, 'pub', 'get']) == 0:
    shutil.copy2(example / 'pubspec.lock', out / 'example-pinned.pubspec.lock')
# Compile the repaired artifact in isolation; published pin deliberately unchanged.
(example / 'pubspec_overrides.yaml').write_text('''dependency_overrides:
  handrail_chat:
    path: ../package
''')
if run('example-artifact-resolution', [flutter, 'pub', 'get']) == 0:
    shutil.copy2(example / 'pubspec.lock', out / 'example-artifact.pubspec.lock')
    run('example-analysis', [dart, 'analyze', 'lib'])
    run('example-web-build', [flutter, 'build', 'web', '--release', '--no-pub'])
sys.exit(int(any(r['exit_code'] for r in results)))
