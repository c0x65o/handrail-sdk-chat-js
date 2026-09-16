import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inspectCandidate, verifyCandidate } from '../scripts/candidate-provenance.mjs';

test('candidate receipts match source/package bytes and Node loads checkout server/testing exports', () => {
  assert.deepEqual(verifyCandidate(), inspectCandidate());
  const resolved = JSON.parse(execFileSync(process.execPath, ['--import', './examples/drop-in-react/scripts/candidate-binding.mjs', '--input-type=module', '-e', `console.log(JSON.stringify([import.meta.resolve('@handrail/chat/server'),import.meta.resolve('@handrail/chat/testing')]))`], { encoding: 'utf8' }));
  assert.equal(resolved[0], new URL('../dist/server/index.js', import.meta.url).href);
  assert.equal(resolved[1], new URL('../dist/testing/index.js', import.meta.url).href);
  const manifest = JSON.parse(readFileSync(new URL('../examples/drop-in-react/package.json', import.meta.url)));
  const lock = JSON.parse(readFileSync(new URL('../examples/drop-in-react/package-lock.json', import.meta.url)));
  assert.equal(manifest.dependencies['@handrail/chat'], lock.packages[''].dependencies['@handrail/chat']);
  assert.match(manifest.dependencies['@handrail/chat'], /^git\+https:.*#[a-f0-9]{40}$/);
});
