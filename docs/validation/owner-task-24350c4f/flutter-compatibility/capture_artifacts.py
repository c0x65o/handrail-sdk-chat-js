#!/usr/bin/env python3
"""Capture/apply/compare source patches without changing a repository index.

Usage: python3 capture_artifacts.py WORKSPACE NEW_SCRATCH_DIRECTORY
Run after validation and report edits; excludes validation evidence from patches.
"""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys

root, scratch = map(lambda p: Path(p).resolve(), sys.argv[1:])
out = Path(__file__).resolve().parent
history = out.parent
scratch.mkdir()
(out / 'patches').mkdir(exist_ok=True)
old = json.loads((history / 'patch-identities.json').read_text())
records = []
sha = lambda b: hashlib.sha256(b).hexdigest()

def git(repo, *args):
    return subprocess.check_output(['git', '-C', str(repo), *args])

for prior in old['repositories']:
    name = prior['repository']
    repo = root / name
    head = git(repo, 'rev-parse', 'HEAD').decode().strip()
    assert head == prior['base_head'], (name, 'HEAD drift')
    changed = set(git(repo, 'diff', '--name-only', 'HEAD').decode().splitlines())
    untracked = set(git(repo, 'ls-files', '--others', '--exclude-standard').decode().splitlines())
    changed = sorted(p for p in changed | untracked if not p.startswith('docs/validation/'))
    if name == 'handrail-sdk-chat-flutter':
        patch = git(repo, 'diff', '--binary', 'HEAD', '--', '.', ':(exclude)docs/validation/**')
        for path in sorted(set(changed) & untracked):
            r = subprocess.run(['git', 'diff', '--no-index', '--binary', '--', '/dev/null', path],
                               cwd=repo, stdout=subprocess.PIPE)
            assert r.returncode == 1, path
            patch += r.stdout
    else:
        # Preserve the already reviewed identity if its source still matches.
        patch = (history / prior['patch']).read_bytes()
    patchfile = out / 'patches' / (name + '.patch')
    patchfile.write_bytes(patch)
    dest = scratch / name
    dest.mkdir()
    archive = subprocess.Popen(['git', '-C', str(repo), 'archive', head], stdout=subprocess.PIPE)
    subprocess.run(['tar', '-x', '-C', str(dest)], stdin=archive.stdout, check=True)
    assert archive.wait() == 0
    if patch:
        args = ['git', 'apply', '--unsafe-paths', '--directory=' + str(dest)]
        subprocess.run(args + ['--check', str(patchfile)], cwd=root, check=True)
        subprocess.run(args + [str(patchfile)], cwd=root, check=True)
    all_paths = set(git(repo, 'ls-files').decode().splitlines()) | set(changed)
    hashes = {}
    for path in sorted(all_paths):
        if path.startswith('docs/validation/'):
            continue
        actual, reconstructed = repo / path, dest / path
        assert actual.exists() == reconstructed.exists(), (name, path, 'existence drift')
        if actual.is_file():
            assert actual.read_bytes() == reconstructed.read_bytes(), (name, path, 'source drift')
            hashes[path] = sha(actual.read_bytes())
    (out / (name + '-source-sha256.json')).write_text(json.dumps(hashes, indent=2)+'\n')
    records.append(dict(repository=name, base_head=head, patch=str(patchfile.relative_to(out)),
        sha256=sha(patch), files=changed, apply_check='passed against git archive HEAD',
        source_correspondence='all non-evidence tracked/new source files match',
        verified_source_file_count=len(hashes)))
identity = sha(json.dumps(records, sort_keys=True).encode())
(out / 'patch-identities.json').write_text(json.dumps(dict(artifact_id=identity,
    scope='Source/tests/docs/locks, including preserved prior fixes; validation evidence separately hashed. Uncommitted, unpublished; subsequent independent QA required.',
    repositories=records), indent=2)+'\n')
historical = json.loads((history / 'evidence-sha256.json').read_text())
assert all(sha((root / p).read_bytes()) == h for p,h in historical.items())
print(json.dumps(dict(artifact_id=identity, repositories=records), indent=2))
# Include original historical manifest and all retained original/new evidence.
evidence = {}
for base in [history, root / 'handrail-sdk-chat-flutter/docs/validation/owner-task-24350c4f']:
    for path in sorted(base.rglob('*')):
        if path.is_file() and path != out / 'evidence-sha256.json' and '__pycache__' not in path.parts:
            evidence[str(path.relative_to(root))] = sha(path.read_bytes())
(out / 'evidence-sha256.json').write_text(json.dumps(evidence, indent=2)+'\n')
