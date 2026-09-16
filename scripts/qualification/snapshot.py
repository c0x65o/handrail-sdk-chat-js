"""Copy the reviewed working trees with the retained compatibility corrections without shared build output or dependencies.
Usage: python3 scripts/qualification/snapshot.py WORKSPACE FRESH_DESTINATION
The reviewed map excludes this preparation-only directory. Unexpected changes
fail before any candidate is copied. Tracked changes are deliberately preserved.
"""
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys

EXPECTED = {
    'handrail-sdk-chat-js': '385f648a42206b7b173aa653e8bb3e250010fd00e41f1c4ecec29fd7cea59e71',
    'handrail-sdk-chat-flutter': 'c3362b6317b16af78d1e2ae6e0c3ceff298aadcd2e20613d9a40d6af6058e713',
    'handrail-chat-preview-flutter': '293790039b4c43f0e2748d3c6bd971a2a371e0d2b248a60e6f87ceb2668401f4',
}
workspace, destination = (pathlib.Path(p).resolve() for p in sys.argv[1:])
if destination.exists():
    raise SystemExit('Destination must be fresh; never reuse shared node_modules')
identities = {}
for name, expected in EXPECTED.items():
    root = workspace / name
    paths = subprocess.check_output([
        'git', '-C', str(root), 'ls-files', '-co', '--exclude-standard', '-z',
    ]).decode().split('\0')
    files = {}
    for path in sorted(set(paths)):
        if not path or (name == 'handrail-sdk-chat-js' and path.startswith('scripts/qualification/')):
            continue
        source = root / path
        if source.is_file() and not source.is_symlink():
            files[path] = hashlib.sha256(source.read_bytes()).hexdigest()
    digest = hashlib.sha256(json.dumps(files, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    if digest != expected:
        raise SystemExit(f'Unexpected source drift: {name}: {digest} != {expected}')
    identities[name] = {'files': files, 'source_map_sha256': digest}
for name, identity in identities.items():
    for path, expected in identity['files'].items():
        target = destination / name / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(workspace / name / path, target)
        if hashlib.sha256(target.read_bytes()).hexdigest() != expected:
            raise SystemExit(f'Source changed during snapshot: {name}/{path}; discard this owned snapshot')
(destination / 'source-identities.json').write_text(json.dumps(identities, indent=2) + '\n')
print(destination)
