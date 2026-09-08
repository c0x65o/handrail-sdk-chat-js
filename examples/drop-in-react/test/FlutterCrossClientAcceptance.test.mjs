import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolatedEnvironment, requireComplete } from '../scripts/accept-flutter-cross-client-recovery.mjs';

const passed = () => ({ errors: [], stats: { expected: 1, unexpected: 0, flaky: 0, skipped: 0 },
  suites: [{ suites: [{ specs: [{ tests: [{ expectedStatus: 'passed', results: [{ status: 'passed' }] }] }] }] }] });

test('acceptance requires exactly one successful execution and rejects skips, retries and missing reports', () => {
  assert.doesNotThrow(() => requireComplete(passed()));
  for (const status of ['skipped', 'failed', 'timedOut', 'interrupted', undefined]) {
    const report = passed();
    report.suites[0].suites[0].specs[0].tests[0].results[0].status = status;
    assert.throws(() => requireComplete(report));
  }
  for (const mutate of [
    report => { report.errors.push({ message: 'setup failed' }); },
    report => { report.suites = []; },
    report => { report.suites.push(report.suites[0]); },
    report => { report.suites[0].suites[0].specs[0].tests[0].expectedStatus = 'skipped'; },
    report => { report.suites[0].suites[0].specs[0].tests[0].results = []; },
    report => { report.suites[0].suites[0].specs[0].tests[0].results.unshift({ status: 'failed' }); },
    report => { report.stats.skipped = 1; },
  ]) {
    const report = passed();
    mutate(report);
    assert.throws(() => requireComplete(report));
  }
  assert.throws(() => requireComplete({}));
});

test('runner discards shared origins, database credentials, assets and inherited acceptance settings', () => {
  const input = { PATH: '/bin', FLUTTER_BIN: '/tools/flutter', DATABASE_URL: 'shared',
    TEST_DATABASE_URL: 'shared', CHAT_LAB_DATABASE_URL: 'shared', PGHOST: 'shared', PGPORT: '5432',
    FLUTTER_CHAT_LAB_ORIGIN: 'https://shared', CHAT_LAB_FLUTTER_WEB_ROOT: '/stale',
    CHAT_LAB_SEED_PROFILE: 'other', CHAT_LAB_RECOVERY_DATABASE_URL: 'shared',
    CHAT_LAB_RECOVERY_ACCEPTANCE_DIR: '/old', NODE_OPTIONS: '--import=other', PLAYWRIGHT_JSON_OUTPUT_FILE: '/old' };
  assert.deepEqual(isolatedEnvironment(input), { PATH: '/bin', FLUTTER_BIN: '/tools/flutter' });
  assert.equal(input.DATABASE_URL, 'shared');
});

test('missing prerequisite writes incomplete evidence and exits nonzero before any runtime starts', () => {
  const example = fileURLToPath(new URL('../', import.meta.url));
  const scratch = mkdtempSync(path.resolve(example, '../../build/cross-client-harness-test-'));
  const output = path.join(scratch, 'missing-postgres');
  const result = spawnSync(process.execPath, ['scripts/accept-flutter-cross-client-recovery.mjs', output], {
    cwd: example, encoding: 'utf8', env: { ...process.env, PG_BINDIR: path.join(scratch, 'absent') },
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const evidence = JSON.parse(readFileSync(path.join(output, 'acceptance.json'), 'utf8'));
  assert.equal(evidence.result, 'incomplete');
  assert.equal(evidence.accepted, false);
  assert.deepEqual(evidence.phases, {});
  assert.match(evidence.error, /PostgreSQL|non-root/);
});
