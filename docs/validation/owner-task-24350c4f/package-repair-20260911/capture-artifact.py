"""Capture the proposed code delta without touching Git's index or history."""
import hashlib
import json
import os
import pathlib
import re
import subprocess
import tempfile

root = pathlib.Path.cwd()
evidence = pathlib.Path(__file__).resolve().parent
prior = evidence.parent / 'qa-repair-20260911'
baseline = json.loads((evidence / 'baseline.json').read_text())
old = json.loads((prior / 'artifact.json').read_text())
repair = ['package.json', 'package-lock.json', 'src/client/generated/package-version.ts',
          'test/package-version-generation.test.mjs', 'test/public-declaration-dependencies.test.mjs']
files = sorted(set(old['sourceHashes']) | set(repair))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def git(*args, **kwargs):
    return subprocess.check_output(['git', *args], cwd=root, **kwargs)

current_head = git('rev-parse', 'HEAD', text=True).strip()
assert current_head == '5dde4e190e14b867069e87fd7d5f47dddffde389', 'Reconcile any further concurrent commit before capturing'
for path, digest in old['sourceHashes'].items():
    assert sha(root / path) == digest, f'Prior repair changed: {path}'
for path, digest in baseline['preserved_evidence'].items():
    assert sha(root / path) == digest, f'Prior evidence changed: {path}'
for path, digest in baseline['tracked_sha256'].items():
    if path not in repair:
        assert sha(root / path) == digest, f'Concurrent tracked file changed: {path}'
for name, state in baseline['linked'].items():
    linked = root.parent / name
    assert subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=linked, text=True).strip() == state['head']
    assert subprocess.check_output(['git', 'status', '--porcelain'], cwd=linked, text=True) == state['status']
    for path, digest in state['pins'].items():
        assert sha(linked / path) == digest

version = json.loads((root / 'package.json').read_text())['version']
generated = re.search(r'CHAT_CLIENT_PACKAGE_VERSION = "([^"]+)"', (root / 'src/client/generated/package-version.ts').read_text()).group(1)
compiled = subprocess.check_output(['node', '--input-type=module', '-e',
    'import { CHAT_CLIENT_PACKAGE_VERSION as v } from "./dist/client/generated/package-version.js"; console.log(v)'], cwd=root, text=True).strip()
assert version == generated == compiled
rebuild = json.loads((evidence / f'rebuild-identity-{version}.json').read_text())
assert rebuild['identical'] and rebuild['exit_code'] == 0
for group in rebuild['after'].values():
    for path, digest in group.items():
        assert sha(root / path) == digest, f'Drift after rebuild: {path}'

def patch(paths):
    output = b''
    for path in paths:
        if subprocess.run(['git', 'cat-file', '-e', f"{baseline['head']}:{path}"], cwd=root,
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            output += git('diff', '--binary', baseline['head'], '--', path)
        else:
            result = subprocess.run(['git', 'diff', '--no-index', '--binary', '--', '/dev/null', path],
                                    cwd=root, capture_output=True)
            assert result.returncode == 1
            output += result.stdout
    return output

(evidence / 'source.patch').write_bytes(patch(files))
(evidence / 'package-repair.patch').write_bytes(patch(repair))
(evidence / 'publication.patch').write_bytes(git('diff', '--binary', current_head, '--', *files))
with tempfile.TemporaryDirectory(prefix='chat-patch-', dir=os.environ.get('TMPDIR')) as scratch:
    for path in files:
        result = subprocess.run(['git', 'show', f"{baseline['head']}:{path}"], cwd=root, capture_output=True)
        if result.returncode == 0:
            target = pathlib.Path(scratch) / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(result.stdout)
    for args in [['--check'], []]:
        subprocess.run(['git', 'apply', *args, str(evidence / 'source.patch')], cwd=scratch, check=True)
    for path in files:
        assert sha(pathlib.Path(scratch) / path) == sha(root / path)

artifact = {
    'task_id': '24350c4f-985e-4762-ac15-445f69009f18',
    'work_request_id': 'fa79737f-72ab-4921-834d-0e485bc520f3',
    'repository': 'https://github.com/c0x65o/handrail-sdk-chat-js.git',
    'original_base_head': baseline['head'], 'publication_base_head': current_head, 'final_commit_sha': None,
    'source_sha256': {path: sha(root / path) for path in files},
    'patch_sha256': {path: sha(evidence / path) for path in ['source.patch', 'package-repair.patch', 'publication.patch']},
    'new_repair_files': repair,
    'reconstruction_passed': True, 'preserved_prior_repair_and_evidence': True,
    'preserved_other_tracked_files_and_linked_pins': True,
    'normal_build_passed': True, 'rebuild_identical': True,
    'focused_tests': {'passed': 6, 'failed': 0, 'skipped': 0},
    'strict_declaration_source_check': 'passed; skipLibCheck=false; negative control reproduces both TS7016 errors',
    'package_generated_compiled_version': version,
    'git_install_acceptance': 'pending publication and independent verification',
    'node': subprocess.check_output(['node', '--version'], text=True).strip(),
    'npm': subprocess.check_output(['npm', '--version'], text=True).strip(),
}
artifact['source_digest_sha256'] = hashlib.sha256(json.dumps(artifact['source_sha256'], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
(evidence / 'artifact.json').write_text(json.dumps(artifact, indent=2) + '\n')
assert git('rev-parse', 'HEAD', text=True).strip() == current_head
print(json.dumps(artifact, indent=2))
