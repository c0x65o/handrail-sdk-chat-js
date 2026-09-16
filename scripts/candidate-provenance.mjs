import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';

export const candidateRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(path, entry.name)) : [join(path, entry.name)]);
}
function fingerprint(paths) {
  const entries = paths.sort().map(path => [relative(candidateRoot, path), hash(readFileSync(path))]);
  return { sha256: hash(JSON.stringify(entries)), files: entries };
}
export function inspectCandidate() {
  const sourcePaths = ['src', 'scripts', 'examples/drop-in-react/src', 'examples/drop-in-react/scripts'].flatMap(path => files(join(candidateRoot, path)));
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'examples/drop-in-react/package.json', 'examples/drop-in-react/package-lock.json', 'examples/drop-in-react/vite.config.ts', 'examples/drop-in-react/tsconfig.json']) sourcePaths.push(join(candidateRoot, path));
  const distPaths = files(join(candidateRoot, 'dist')).filter(path => !path.endsWith('/candidate.json'));
  return { scheme: 'handrail-unpublished-candidate-v1', source: fingerprint(sourcePaths), package: fingerprint(distPaths) };
}
export function verifyCandidate() {
  const saved = JSON.parse(readFileSync(join(candidateRoot, 'dist/candidate.json'), 'utf8'));
  const current = inspectCandidate();
  if (JSON.stringify(saved) !== JSON.stringify(current)) throw new Error('Chat Lab candidate changed or is not built. Run npm run build in the SDK checkout.');
  return Object.freeze(saved);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = inspectCandidate();
  writeFileSync(join(candidateRoot, 'dist/candidate.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Candidate source=${manifest.source.sha256} package=${manifest.package.sha256}`);
}
