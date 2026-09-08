import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { reconstructBindingDefect, parseSuite, requireComplete } from './accept-restore.mjs';

test('negative control changes only restore bindings and preserves precision clamps', () => {
  const source = readFileSync(new URL('../src/server/archive-conversation-command.ts', import.meta.url), 'utf8');
  const negative = reconstructBindingDefect(source);
  assert.equal(negative.source.replace(negative.broken, negative.fixed), source);
  assert.match(negative.broken, /lifecycle_revision = \$3, updated_at = \$1/);
  assert.match(negative.broken, /options.actor.userId,/);
  assert.doesNotMatch(negative.broken, /\$2/);
  for (const column of ['completed_at', 'updated_at']) {
    assert.ok(negative.source.includes(`${column} = GREATEST($2::timestamptz, created_at)`));
  }
  assert.throws(() => reconstructBindingDefect(negative.source), /bindings changed/);
});

test('acceptance gate rejects missing, skipped, cancelled, todo, and changed test scope', () => {
  // TAP fixtures validate only the evidence gate; runtime proof still requires real PostgreSQL.
  const tap = [
    ...Array.from({ length: 7 }, (_, i) => `    # Subtest: case ${i}\n    ok ${i + 1} - case ${i}\n      duration_ms: 1`),
    '    1..7', '# tests 8', '# pass 8', '# fail 0', '# cancelled 0', '# skipped 0', '# todo 0',
  ].join('\n');
  requireComplete(parseSuite(tap), tap);
  assert.throws(() => parseSuite(''), /Missing tests count/);
  for (const key of ['skipped', 'cancelled', 'todo']) {
    const incomplete = tap.replace(`# ${key} 0`, `# ${key} 1`);
    assert.throws(() => requireComplete(parseSuite(incomplete), incomplete), /unsuccessful acceptance/);
  }
  const skipped = tap.replace('ok 1 - case 0', 'ok 1 - case 0 # SKIP');
  assert.throws(() => requireComplete(parseSuite(skipped), skipped), /Skipped assertion/);
  assert.throws(() => requireComplete({ counts: parseSuite(tap).counts, cases: [] }, tap), /scope changed/);
});
