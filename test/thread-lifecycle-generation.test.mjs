import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { generateTypeScript, generateDart, readThreadLifecycleDescriptor } from '../scripts/generate-thread-lifecycle.mjs';
const root = resolve(import.meta.dirname, '..');
const generator = resolve(root, 'scripts/generate-thread-lifecycle.mjs');
const descriptorPath = 'contracts/http/thread-lifecycle.json';
const outputs = ['src/contracts/thread-lifecycle.ts', 'contracts/generated/dart/thread_lifecycle.dart'];
test('descriptor reserves a disabled capability and references the canonical lifecycle model', async () => {
  const d = await readThreadLifecycleDescriptor(root);
  assert.equal(d.feature.advertiseRuntime, false);
  assert.equal(d.feature.missing, false);
  assert.equal(d.endpoint.path, '/conversations/:threadId/lifecycle');
  assert.equal(d.model.source, 'contracts/models/conversation.json#threadLifecycle');
  assert.deepEqual(d.intents, ['close', 'reopen', 'lock', 'unlock']);
  assert.deepEqual(d.reconciliationStatuses.map(s => s.name), ['applied','replayed','already_requested_state','lifecycle_conflict']);
});
test('generation is deterministic and exact; unsupported descriptor semantics fail closed', async () => {
  const d = await readThreadLifecycleDescriptor(root);
  for (const [index, render] of [generateTypeScript, generateDart].entries()) {
    const generated = render(d);
    assert.equal(render(structuredClone(d)), generated);
    assert.equal(await readFile(resolve(root, outputs[index]), 'utf8'), generated);
    assert.throws(() => render({...d, maxSafeRevision: 100}));
    const changed = structuredClone(d); changed.transitions.locked.reopen = 'open';
    assert.throws(() => render(changed));
  }
});
test('isolated generation and check detect missing files and drift in either output', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'handrail-thread-lifecycle-'));
  t.after(() => rm(temp, {recursive:true, force:true}));
  const path = resolve(temp, descriptorPath);
  await mkdir(dirname(path), {recursive:true});
  await writeFile(path, await readFile(resolve(root, descriptorPath)));
  const run = (...args) => spawnSync(process.execPath, [generator, '--root', temp, ...args], {encoding:'utf8'});
  assert.equal(run('--check').status, 1);
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  for (const output of outputs) {
    await writeFile(resolve(temp, output), '// drift\n', {flag:'a'});
    const drift = run('--check');
    assert.equal(drift.status, 1);
    assert.ok(drift.stderr.includes(output));
    assert.equal(run().status, 0);
  }
  assert.equal(run('--check').status, 0);
  assert.notEqual(run('--unsupported').status, 0);
});
