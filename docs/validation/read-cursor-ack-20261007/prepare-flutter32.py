"""Prepare immutable source fixtures, reusing the installed Dart toolchain.
No SDK installation, checkout, cache patch, or dependency override is performed.
Run from the JS repository root. The sibling is this project's Git object store.
"""
import subprocess, json, io, tarfile, hashlib, urllib.request
from pathlib import Path
sha = '2d095ba5a0f86e4aa0b12ba8432500e3edfb576f'
root = Path('build/read-cursor-ack/flutter32').resolve()
root.joinpath('.dart_tool').mkdir(parents=True, exist_ok=True)
files = ['lib', 'pubspec.yaml', 'test/read_cursor_runtime_test.dart',
         'test/read_visibility_coordinator_test.dart', 'test/generated_read_cursor_mutation_test.dart',
         'test/durable_resource_event_reducer_test.dart', 'test/fixtures/draft_mutation_fixtures.dart']
blob = subprocess.check_output(['git', '-C', '../handrail-sdk-chat-flutter', 'archive', sha, *files])
with tarfile.open(fileobj=io.BytesIO(blob)) as archive:
    for member in archive.getmembers():
        assert not member.issym() and not member.islnk()
        assert (root / member.name).resolve().is_relative_to(root)
    archive.extractall(root)
verified = []
for name in ['pubspec.yaml', 'lib/src/generated/read_cursor_mutation.dart',
             'lib/src/core/read_cursor_runtime.dart', 'lib/src/core/read_visibility_coordinator.dart',
             'lib/src/handrail_chat_client.dart']:
    url = f'https://raw.githubusercontent.com/c0x65o/handrail-sdk-chat-flutter/{sha}/{name}'
    public = urllib.request.urlopen(url, timeout=30).read()
    assert public == (root / name).read_bytes(), name
    verified.append({'path': name, 'url': url, 'sha256': hashlib.sha256(public).hexdigest()})
Path('docs/validation/read-cursor-ack-20261007/flutter32-source.json').write_text(json.dumps({
    'commit': sha, 'publicVerified': verified,
    'fixtureFiles': {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
                     for p in sorted(root.rglob('*.dart'))},
}, indent=2) + '\n')
# Resolve only this proof harness's third-party dependencies from existing bytes.
# A private cache root owns pub bookkeeping; hosted artifacts remain read-only.
harness = Path('build/read-cursor-ack/dart-harness').resolve()
harness.mkdir(parents=True, exist_ok=True)
harness.joinpath('pubspec.yaml').write_text("""name: read_cursor_ack_source_proof
publish_to: none
environment:
  sdk: '>=3.7.0 <4.0.0'
dependencies:
  test: ^1.31.0
  http_parser: ^4.1.2
  unorm_dart: ^0.3.2
""")
cache = Path('build/read-cursor-ack/pub-cache').resolve()
cache.mkdir(parents=True, exist_ok=True)
if not (cache / 'hosted').exists():
    (cache / 'hosted').symlink_to('/opt/handrail/.handrail/flutter-sdk/bin/cache/pub-cache/hosted')
import os
subprocess.run(['/opt/handrail/.handrail/flutter-sdk/bin/cache/dart-sdk/bin/dart',
                'pub', 'get', '--offline', '--directory', str(harness)],
               env={**os.environ, 'PUB_CACHE': str(cache)}, check=True)
config = json.loads((harness / '.dart_tool/package_config.json').read_text())
config['packages'] = [entry for entry in config['packages'] if entry['name'] != 'read_cursor_ack_source_proof']
config['packages'].append({'name': 'handrail_chat', 'rootUri': root.as_uri(),
                           'packageUri': 'lib/', 'languageVersion': '3.3'})
(root / '.dart_tool/package_config.json').write_text(json.dumps(config, indent=2) + '\n')
Path('docs/validation/read-cursor-ack-20261007/dart-harness.lock').write_bytes((harness / 'pubspec.lock').read_bytes())
print('Published source authenticated; source fixture uses existing toolchain and locked third-party dependencies')
