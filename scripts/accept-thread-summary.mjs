#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Like accept-huddle-renewal.mjs, this runner owns copies, never shared dist.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const native = args[0] === '--native';
if (native) args.shift();
if (args.length !== 1) throw new Error('Usage: node scripts/accept-thread-summary.mjs [--native] NEW_EVIDENCE_DIRECTORY');
const output = resolve(args[0]);
mkdirSync(output, { mode: 0o700 });
const nativeBin = process.env.PG_BINDIR;
const testUrl = process.env.TEST_DATABASE_URL?.trim();
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /PASSWORD|SECRET|TOKEN|DATABASE_URL|VAULT_KEY/.test(key) && value?.length >= 4)
  .map(([, value]) => value);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(DATABASE_URL|PG[A-Z_]+|NODE_OPTIONS|NODE_PATH)$/.test(key)) {
    delete env[key];
    delete process.env[key];
  }
}
const redact = (value) => {
  let text = String(value);
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/g, 'postgresql://[REDACTED]');
};
const save = (name, text) => writeFileSync(join(output, name), redact(text));
const json = (name, value) => save(name, JSON.stringify(value, null, 2) + '\n');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function hashes(root, paths) {
  const result = {};
  function visit(relative) {
    const path = join(root, relative);
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(relative, name));
    } else result[relative] = sha(readFileSync(path));
  }
  for (const path of paths) visit(path);
  return result;
}
// Keep each catalog small enough for bounded goal-artifact content retrieval.
function catalog(name, entries) {
  const files = [];
  const items = Object.entries(entries);
  for (let i = 0; i < items.length; i += 200) {
    const file = `${name}-${files.length + 1}.json`;
    json(file, Object.fromEntries(items.slice(i, i + 200)));
    files.push(file);
  }
  return { files, file_count: items.length, sha256: sha(JSON.stringify(entries)) };
}
const inputs = ['src', 'test', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json'];
const sourcePath = 'src/server/thread-summary-query.ts';
const compiledPath = 'dist/server/thread-summary-query.js';
const testPath = 'test/postgres-thread-summary-query.test.mjs';
const expectedNames = [
  'empty thread returns only shared zero facts without a viewer cursor',
  'persisted shared facts include deleted replies and ignore viewer read state',
  'wrong tenant and missing thread reject without returning seeded facts',
  'viewer cursors and manual unread remain user- and tenant-isolated with timeline parity',
  'eligible viewer without a cursor gets all three persisted replies unread',
  'inactive nonfollowing viewer with a retained cursor gets zero unread',
  'active membership OR following preserves unread eligibility until neither remains',
];
const suiteName = 'cursor presence does not determine viewer eligibility';
const manifest = { schema_version: 1, started_at: new Date().toISOString(),
  invocation: [process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
  cwd: process.cwd(), repo, node: process.version, uid: process.getuid?.(),
  phases: {}, accepted: false, cleanup: {} };
let scratch, pgDirectory, pgBin, backend, probe;
let before, distBefore;
function run(name, command, args, cwd = repo) {
  console.log(`Running ${name}`);
  const started_at = new Date().toISOString();
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  const finished_at = new Date().toISOString();
  const text = redact(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  const phase = { command: [command, ...args], cwd, started_at, finished_at,
    exit_status: result.status, signal: result.signal, error: result.error?.message, log: `${name}.log` };
  save(phase.log, `${JSON.stringify(phase)}\n${text}`);
  manifest.phases[name] = phase;
  return { ...phase, text };
}
function success(result) {
  assert.equal(result.exit_status, 0, `See ${result.log}`);
  assert.equal(result.signal, null, `Signalled command: ${result.log}`);
  assert.equal(result.error, undefined, `Incomplete command: ${result.log}`);
}
function compile(name, root, expected) {
  assert.deepEqual(hashes(root, inputs), expected, 'Compile inputs differ from snapshot');
  assert.equal(existsSync(join(root, 'dist')), false, 'Refuse stale compilation');
  success(run(name, join(root, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json', '--incremental', 'false', '--noEmitOnError'], root));
  assert.deepEqual(hashes(root, inputs), expected, 'Compiler changed source/tests');
  const dist = hashes(root, ['dist']);
  assert.ok(dist[compiledPath], 'Fresh compiler did not emit thread summary');
  const map = JSON.parse(readFileSync(join(root, `${compiledPath}.map`), 'utf8'));
  assert.deepEqual(map.sources, ['../../src/server/thread-summary-query.ts']);
  Object.assign(manifest.phases[name], { source: catalog(`${name}-source`, expected), compiled: catalog(`${name}-dist`, dist) });
  return dist;
}
async function schemaCheck(name) {
  const sql = "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'chat_thread_facts_%' ORDER BY nspname";
  const started_at = new Date().toISOString();
  const result = await probe.pool.query(sql);
  json(`${name}-schemas.json`, { sql, started_at, finished_at: new Date().toISOString(), rows: result.rows });
  assert.deepEqual(result.rows, [], `Leaked test schemas after ${name}`);
}
async function suite(name, root, expectedSource, expectedDist, negative = false) {
  assert.deepEqual(hashes(root, inputs), expectedSource, 'Test source changed after compilation');
  assert.deepEqual(hashes(root, ['dist']), expectedDist, 'Compiled files changed before tests');
  const result = run(name, process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', testPath], root);
  const counts = {};
  for (const key of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...result.text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))];
    assert.equal(matches.length, 1, `Missing/ambiguous ${key} count in ${result.log}`);
    counts[key] = Number(matches[0][1]);
  }
  // Bound each diagnostic to its own TAP result (parent diagnostics are separate).
  const records = [...result.text.matchAll(/^( *)(not ok|ok) \d+ - (.+)\n([\s\S]*?)(?=^ *(?:# Subtest:|(?:not ok|ok) \d+ - |1\.\.)|^# tests |$(?![\s\S]))/gm)]
    .map(([, indent, status, name, diagnostic]) => ({ name, depth: indent.length, passed: status === 'ok', diagnostic }));
  const cases = records.filter(({ name }) => name !== suiteName);
  const suites = records.filter(({ name }) => name === suiteName);
  Object.assign(manifest.phases[name], { counts, cases, enclosing_suites: suites });
  assert.equal(result.signal, null);
  assert.equal(result.error, undefined);
  assert.equal(counts.skipped + counts.cancelled + counts.todo, 0, 'Skipped/incomplete tests are not acceptance');
  assert.ok(!/^\s*(?:not )?ok \d+ .*# (?:SKIP|TODO)\b/im.test(result.text));
  assert.deepEqual(cases.map(({ name }) => name), expectedNames, 'Current seven-test scope changed');
  assert.equal(counts.tests, 7);
  assert.equal(counts.suites, 1);
  assert.equal(suites.length, 1);
  if (!negative) {
    success(result);
    assert.equal(counts.pass, 7);
    assert.equal(counts.fail, 0);
    assert.ok(records.every(({ passed }) => passed));
  } else {
    assert.equal(result.exit_status, 1);
    // Restoring the same prior enrichment also breaks the empty-thread wrapper
    // and the final loss-of-eligibility step. All other tests must still pass.
    const failures = cases.filter(({ passed }) => !passed);
    assert.deepEqual(failures.map(({ name }) => name), [expectedNames[0], expectedNames[4], expectedNames[5], expectedNames[6]]);
    for (const entry of failures) {
      assert.match(entry.diagnostic, /failureType: 'testCodeFailure'/);
      assert.match(entry.diagnostic, /selectRootThreadSummary|assertViewerParity/);
      if ([expectedNames[0], expectedNames[4]].includes(entry.name)) {
        assert.match(entry.diagnostic, /error: 'Thread summary could not be loaded'/);
        assert.match(entry.diagnostic, /code: 'ERR_TEST_FAILURE'/);
      } else {
        assert.match(entry.diagnostic, /wrapper unread and facts/);
        assert.match(entry.diagnostic, /code: 'ERR_ASSERTION'/);
        assert.match(entry.diagnostic, /expected:\n[\s\S]*?unreadCount: 0\n/);
        assert.match(entry.diagnostic, /actual:\n[\s\S]*?unreadCount: 2\n/);
        assert.match(entry.diagnostic, /operator: 'deepStrictEqual'/);
      }
    }
    assert.equal(counts.pass, 3);
    assert.equal(counts.fail, 4);
    assert.equal(suites[0].passed, false);
    assert.match(suites[0].diagnostic, /failureType: 'subtestsFailed'/);
    assert.match(suites[0].diagnostic, /2 subtests failed/);
  }
  assert.deepEqual(hashes(root, inputs), expectedSource, 'Tests changed snapshot inputs');
  assert.deepEqual(hashes(root, ['dist']), expectedDist, 'Tests changed compiled files');
  await schemaCheck(name);
}
try {
  const head = run('git-head', 'git', ['rev-parse', 'HEAD']); success(head);
  manifest.head = head.text.trim();
  success(run('git-status', 'git', ['status', '--porcelain=v1']));
  success(run('node-version', process.execPath, ['--version']));
  success(run('typescript-version', join(repo, 'node_modules/.bin/tsc'), ['--version']));
  before = hashes(repo, inputs);
  distBefore = hashes(repo, ['dist']);
  manifest.snapshot = catalog('shared-source', before);
  manifest.shared_dist_before = catalog('shared-dist', distBefore);
  scratch = mkdtempSync(join(tmpdir(), 'thread-acceptance-'));
  manifest.scratch = scratch;
  // Copy once, verify against shared bytes, then derive both isolated workspaces.
  const positive = join(scratch, 'positive');
  const negative = join(scratch, 'negative');
  mkdirSync(positive);
  for (const input of inputs) cpSync(join(repo, input), join(positive, input), { recursive: true, dereference: true });
  assert.deepEqual(hashes(positive, inputs), before, 'Snapshot must include uncommitted prerequisite bytes');
  cpSync(positive, negative, { recursive: true });
  for (const root of [positive, negative]) symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  const source = readFileSync(join(negative, sourcePath), 'utf8');
  const sql = /`SELECT \(CASE[\s\S]*?cursor\.last_read_sequence, cursor\.manual_unread_from_sequence`/g;
  const matches = [...source.matchAll(sql)];
  assert.equal(matches.length, 1, 'Viewer enrichment changed; refusing ambiguous negative control');
  // Prior cursor-dependent SQL from create-thread-command, before extraction.
  // Retain current facts extraction, wrapper, tests, and timeline selector.
  const oldSql = '`SELECT count(reply.id) FILTER (\n' +
    '              WHERE reply.sequence > CASE\n' +
    '                WHEN cursor.manual_unread_from_sequence IS NULL\n' +
    '                  THEN cursor.last_read_sequence\n' +
    '                ELSE LEAST(\n' +
    '                  cursor.last_read_sequence,\n' +
    '                  cursor.manual_unread_from_sequence - 1\n' +
    '                )\n' +
    '              END\n' +
    '            )::integer AS unread_count\n' +
    '       FROM ${prefix}.chat_conversations AS thread\n' +
    '       INNER JOIN ${prefix}.chat_read_cursors AS cursor\n' +
    '         ON cursor.tenant_id = thread.tenant_id\n' +
    '        AND cursor.conversation_id = thread.id\n' +
    '        AND cursor.user_id = $2\n' +
    '       LEFT JOIN ${prefix}.chat_messages AS reply\n' +
    '         ON reply.tenant_id = thread.tenant_id\n' +
    '        AND reply.conversation_id = thread.id\n' +
    '       WHERE thread.tenant_id = $1 AND thread.id = $3\n' +
    '       GROUP BY cursor.last_read_sequence, cursor.manual_unread_from_sequence`';
  const negativeSource = source.replace(sql, () => oldSql);
  writeFileSync(join(negative, sourcePath), negativeSource);
  json('negative-control-change.json', { path: sourcePath, removed: matches[0][0], inserted: oldSql,
    before_sha256: sha(source), after_sha256: sha(negativeSource),
    provenance: 'Cursor-dependent viewer enrichment from create-thread-command.ts before shared-facts extraction; only the viewer SELECT is restored.' });
  save('corrected-source.txt', source);
  save('negative-source.txt', negativeSource);
  save('current-test.txt', readFileSync(join(positive, testPath), 'utf8'));
  save('acceptance-runner.txt', readFileSync(fileURLToPath(import.meta.url), 'utf8'));
  const negativeHashes = hashes(negative, inputs);
  assert.deepEqual(Object.keys(before).filter((key) => before[key] !== negativeHashes[key]), [sourcePath]);
  const positiveDist = compile('positive-build', positive, before);
  const negativeDist = compile('negative-build', negative, negativeHashes);
  assert.notEqual(positiveDist[compiledPath], negativeDist[compiledPath], 'Negative SQL was not compiled');
  save('corrected-compiled.txt', readFileSync(join(positive, compiledPath), 'utf8'));
  save('negative-compiled.txt', readFileSync(join(negative, compiledPath), 'utf8'));
  if (native) {
    assert.ok(!testUrl, '--native requires TEST_DATABASE_URL unset');
    assert.ok(process.getuid && process.getuid() !== 0, 'Native PostgreSQL requires a non-root identity');
    if (nativeBin) pgBin = nativeBin;
    else { const config = run('pg-config', 'pg_config', ['--bindir']); success(config); pgBin = config.text.trim(); }
    success(run('postgres-version', join(pgBin, 'postgres'), ['--version']));
    pgDirectory = mkdtempSync(join(repo, '.thread-pg-'));
    manifest.pg_directory = pgDirectory;
    assert.ok(Buffer.byteLength(join(pgDirectory, '.s.PGSQL.5432')) < 104, 'Private socket path too long');
    assert.ok(!/[\s'\\]/.test(pgDirectory), 'Unsupported private socket path');
    success(run('postgres-init', join(pgBin, 'initdb'), ['-D', join(pgDirectory, 'data'), '-U', 'handrail_test', '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--no-locale']));
    success(run('postgres-start', join(pgBin, 'pg_ctl'), ['-D', join(pgDirectory, 'data'), '-l', join(pgDirectory, 'server.log'), '-o', `-p 5432 -c listen_addresses='' -c unix_socket_directories='${pgDirectory}' -c unix_socket_permissions=0700`, '-w', 'start']));
    env.TEST_DATABASE_URL = `postgresql://handrail_test@localhost:5432/postgres?host=${encodeURIComponent(pgDirectory)}`;
  }
  const { createPostgresTestBackend } = await import(pathToFileURL(join(positive, 'dist/testing/index.js')));
  backend = await createPostgresTestBackend({ ...(env.TEST_DATABASE_URL ? { testDatabaseUrl: env.TEST_DATABASE_URL } : {}) });
  secrets.push(backend.connectionString);
  env.TEST_DATABASE_URL = backend.connectionString;
  probe = await backend.createHarness({ schemaPrefix: 'thread_acceptance' });
  const version = await probe.pool.query('SELECT version() AS version');
  manifest.postgres = { kind: backend.kind, setup: native ? 'disposable native cluster; private socket; TCP disabled; non-root' : testUrl ? 'explicit dedicated TEST_DATABASE_URL' : 'disposable postgres:16-alpine container', version: version.rows[0].version, probe_schema: probe.schema };
  await schemaCheck('before');
  await suite('positive-test', positive, before, positiveDist);
  await suite('negative-control', negative, negativeHashes, negativeDist, true);
  // End with the unchanged corrected source and its verified fresh compilation.
  await suite('corrected-final-test', positive, before, positiveDist);
  manifest.accepted = true;
} catch (error) {
  manifest.error = redact(error.stack ?? error);
  process.exitCode = 1;
} finally {
  // Attempt every cleanup independently, even if a preceding cleanup fails.
  const cleanup = async (name, action) => {
    try { await action(); manifest.cleanup[name] = { passed: true }; }
    catch (error) { manifest.cleanup[name] = { passed: false, error: redact(error.stack ?? error) }; manifest.accepted = false; process.exitCode = 1; }
  };
  await cleanup('test_schemas', async () => { if (probe) await schemaCheck('cleanup'); });
  await cleanup('probe', async () => { if (probe) { await probe.teardown(); assert.equal(await backend.schemaExists(probe.schema), false); } });
  await cleanup('backend', async () => { await backend?.teardown(); });
  await cleanup('native_stop', async () => {
    if (pgDirectory && existsSync(join(pgDirectory, 'data/postmaster.pid'))) success(run('postgres-stop', join(pgBin, 'pg_ctl'), ['-D', join(pgDirectory, 'data'), '-m', 'immediate', '-w', 'stop']));
    if (pgDirectory) assert.equal(existsSync(join(pgDirectory, 'data/postmaster.pid')), false);
  });
  await cleanup('native_directory', async () => {
    if (!pgDirectory) return;
    if (existsSync(join(pgDirectory, 'server.log'))) save('postgres-server.log', readFileSync(join(pgDirectory, 'server.log'), 'utf8'));
    assert.ok(manifest.cleanup.native_stop.passed, 'Preserving cluster because stop failed');
    rmSync(pgDirectory, { recursive: true, force: true });
    assert.equal(existsSync(pgDirectory), false);
  });
  await cleanup('snapshots', async () => { if (scratch) { rmSync(scratch, { recursive: true, force: true }); assert.equal(existsSync(scratch), false); } });
  await cleanup('shared_inputs', async () => { if (before) assert.deepEqual(hashes(repo, inputs), before, 'Shared source/tests changed during acceptance'); });
  await cleanup('shared_dist', async () => { if (distBefore) assert.deepEqual(hashes(repo, ['dist']), distBefore, 'Shared dist changed during acceptance'); });
  manifest.finished_at = new Date().toISOString();
  manifest.exit_status = process.exitCode ?? 0;
  json('manifest.json', manifest);
  const evidence = readdirSync(output).sort().map((filename) => ({
    kind: filename.endsWith('.log') ? 'log' : 'file', filename,
    mime_type: filename.endsWith('.json') ? 'application/json' : 'text/plain',
    path: join(output, filename), content_sha256: sha(readFileSync(join(output, filename))),
    size_bytes: statSync(join(output, filename)).size, redaction_status: 'redacted', visibility: 'staff_only',
  }));
  json('evidence-metadata.json', { environment: 'dev', evidence });
  console.log(`Acceptance ${manifest.accepted ? 'PASSED' : 'FAILED'}; evidence: ${output}`);
  if (manifest.error) console.error(manifest.error);
}
