"""Run from the SDK root after npm run build; source check, no SDK install."""
import hashlib
import json
import pathlib
import subprocess

root = pathlib.Path.cwd()
evidence = pathlib.Path(__file__).resolve().parent

def hashes(directory):
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted((root / directory).rglob('*')) if p.is_file()}

before = {'dist': hashes('dist'), 'src': hashes('src')}
with (evidence / 'rebuild.log').open('w') as log:
    result = subprocess.run(['npm', 'run', 'build'], stdout=log, stderr=subprocess.STDOUT)
after = {'dist': hashes('dist'), 'src': hashes('src')}
report = {'command': 'npm run build', 'exit_code': result.returncode,
          'before': before, 'after': after, 'identical': before == after}
(evidence / 'rebuild-identity.json').write_text(json.dumps(report, indent=2) + '\n')
assert result.returncode == 0
assert before == after, 'Normal rebuild introduced source or compiled drift'
print(f"Normal rebuild stable: {len(after['dist'])} emitted files and {len(after['src'])} source files")
