import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { generateThreadList, generateTypeScript, generateDart, readThreadListDescriptor } from '../scripts/generate-thread-list.mjs';

test('canonical descriptor produces reproducible TS and Dart; both outputs detect drift', async t => {
  const d = await readThreadListDescriptor();
  const root = await mkdtemp(join(tmpdir(), 'handrail-thread-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'contracts/http'), { recursive: true });
  await writeFile(join(root, 'contracts/http/thread-list.json'), JSON.stringify(d));
  const outputs = { 'src/contracts/thread-list.ts': generateTypeScript(d), 'contracts/generated/dart/thread_list.dart': generateDart(d) };
  assert.deepEqual(await generateThreadList({ check: true }), []);
  await generateThreadList({ root });
  for (const [path, expected] of Object.entries(outputs)) {
    assert.equal(await readFile(join(root, path), 'utf8'), expected);
    await writeFile(join(root, path), '// drift\n', { flag: 'a' });
    assert.deepEqual(await generateThreadList({ root, check: true }), [path]);
    await generateThreadList({ root });
    assert.deepEqual(await generateThreadList({ root, check: true }), []);
  }
  assert.equal(generateTypeScript(d), outputs['src/contracts/thread-list.ts']);
  assert.equal(generateDart(d), outputs['contracts/generated/dart/thread_list.dart']);
});
test('unsupported semantic changes fail closed in both generators', async () => {
  const d = await readThreadListDescriptor();
  for (const change of [v => v.request.defaultView = 'all', v => v.cursor.prefix = 'v2', v => v.inactivity.boundary = '>', v => v.eligibility.all = 'bypass archive', v => v.response.itemFields.pop()]) {
    const copy = structuredClone(d); change(copy);
    assert.throws(() => generateTypeScript(copy)); assert.throws(() => generateDart(copy));
  }
});
test('descriptor preserves access, host policy, activity source and compatibility obligations', async () => {
  const d = await readThreadListDescriptor();
  assert.equal(d.endpoint.method, 'GET');
  assert.match(d.eligibility.independence, /no follow or invitation/);
  assert.match(d.inactivity.resolution, /only after trusted tenant and parent authorization/);
  assert.match(d.inactivity.resolution, /resolver errors disable hiding/);
  assert.match(d.inactivity.activity, /never conversation.updated_at/);
  assert.equal(d.inactivity.doesNotRefresh.length, 9);
  assert.match(d.inactivity.behavior, /user reply-style preference never enables/);
  assert.match(d.eligibility.capability, /shared persistence, hydration and enforcement/);
});
