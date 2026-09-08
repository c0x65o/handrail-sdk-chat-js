#!/usr/bin/env node
// Isolation/evidence pattern follows accept-huddle-renewal.mjs; product files stay untouched.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = 'src/server/archive-conversation-command.ts';
const testFile = 'test/postgres-archive-conversation-command.test.mjs';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fixedBindings = `             SET archived_at = NULL, archived_by_user_id = NULL,
                 lifecycle_revision = $2, updated_at = $1
           WHERE tenant_id = $3 AND id = $4 AND lifecycle_revision = $5`,
  brokenBindings = `             SET archived_at = NULL, archived_by_user_id = NULL,
                 lifecycle_revision = $3, updated_at = $1
           WHERE tenant_id = $4 AND id = $5 AND lifecycle_revision = $6`;

export function reconstructBindingDefect(source) {
  const start = source.indexOf('        : await connection.query(\n            `UPDATE');
  const end = source.indexOf('    if (updated.rowCount !== 1)', start);
  assert.ok(start > 0 && end > start, 'Restore query shape changed');
  const fixed = source.slice(start, end);
  assert.equal(fixed.split(fixedBindings).length, 2, 'Restore bindings changed');
  const values = '              occurredAt,\n              nextLifecycleRevision,';
  assert.equal(fixed.split(values).length, 2, 'Restore values changed');
  const broken = fixed.replace(fixedBindings, brokenBindings)
    .replace(values, '              occurredAt,\n              options.actor.userId,\n              nextLifecycleRevision,');
  // Deliberately leave both GREATEST timestamp precision clamps and the row-count guard intact.
  for (const column of ['completed_at', 'updated_at']) {
    assert.ok(source.includes(`${column} = GREATEST($2::timestamptz, created_at)`), 'Timestamp clamp missing');
  }
  return { source: source.slice(0, start) + broken + source.slice(end), fixed, broken };
}

export function parseSuite(text) {
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = text.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    assert.ok(match, `Missing ${key} count`);
    counts[key] = Number(match[1]);
  }
  const cases = [...text.matchAll(/^    (not ok|ok) \d+ - (.+)\n([\s\S]*?)(?=^    # Subtest:|^    1\.\.)/gm)]
    .map(([, status, name, diagnostic]) => ({ name, passed: status === 'ok', diagnostic }));
  return { counts, cases };
}
export function requireComplete({ counts, cases }, text) {
  assert.equal(counts.skipped + counts.cancelled + counts.todo, 0, 'Skipped/incomplete assertions are unsuccessful acceptance');
  assert.ok(!/^\s*(?:not )?ok \d+ .*# (?:SKIP|TODO)\b/im.test(text), 'Skipped assertion');
  assert.equal(cases.length, 7, 'Focused test scope changed; review expectations');
  assert.equal(counts.tests, 8);
}
function hashes(root, paths) {
  const result = {};
  function visit(relative) {
    const path = join(root, relative);
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    assert.ok(!stat.isSymbolicLink(), `Refusing source symlink: ${relative}`);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(relative, name));
    else result[relative] = sha(readFileSync(path));
  }
  for (const path of paths) visit(path);
  return result;
}

async function main() {
  assert.ok(process.argv.length <= 3, 'Usage: node scripts/accept-restore.mjs [NEW_EVIDENCE_DIRECTORY]');
  const output = process.argv[2] ? resolve(process.argv[2]) : mkdtempSync(join(tmpdir(), 'restore-evidence-'));
  if (process.argv[2]) mkdirSync(output, { mode: 0o700 });
  // Capture redaction values BEFORE removing all operator/test database configuration.
  const secrets = Object.entries(process.env)
    .filter(([key, value]) => /PASSWORD|SECRET|TOKEN|DATABASE_URL|VAULT_KEY/.test(key) && value?.length >= 4)
    .map(([, value]) => value);
  const redact = (value) => {
    let text = String(value);
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
    return text.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/g, 'postgresql://[REDACTED]');
  };
  const json = (name, value) => writeFileSync(join(output, name), redact(JSON.stringify(value, null, 2)) + '\n');
  const pgBinOverride = process.env.PG_BINDIR;
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:.*DATABASE_URL|PG[A-Z_]+|NODE_OPTIONS|NODE_PATH)$/.test(key)) {
      delete env[key];
      delete process.env[key];
    }
  }
  const manifest = { started_at: new Date().toISOString(), node: process.version, uid: process.getuid?.(),
    owner_task_id: 'bbb16b0c-f648-4aca-922c-c81ecf144a4e', phases: {}, cleanup: {}, accepted: false };
  let scratch, pgDirectory, pgBin, backend, probe, before, distBefore, inputs;
  function run(name, command, args, cwd = repo) {
    console.log(`Running ${name}`);
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
    const text = redact(`${result.stdout ?? ''}${result.stderr ?? ''}\nexit_status=${result.status} signal=${result.signal ?? 'none'}\n${result.error ?? ''}\n`);
    writeFileSync(join(output, `${name}.log`), text);
    const phase = { command: [command, ...args], exit_status: result.status, signal: result.signal, log: `${name}.log` };
    manifest.phases[name] = phase;
    return { ...phase, text };
  }
  const success = (result) => assert.equal(result.exit_status, 0, `See ${result.log}`);
  const suite = (name, root) => {
    const result = run(name, process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', testFile], root);
    const parsed = parseSuite(result.text);
    Object.assign(manifest.phases[name], parsed);
    requireComplete(parsed, result.text);
    return { ...result, ...parsed };
  };
  const remainingSchemas = async () => (await probe.pool.query(
    "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema', $1) AND nspname NOT LIKE 'pg_%' ORDER BY nspname", [probe.schema],
  )).rows.map(({ nspname }) => nspname);
  try {
    assert.ok(Number.isInteger(manifest.uid) && manifest.uid !== 0, 'Requires non-root UID; use scripts/restore-acceptance.Dockerfile');
    const git = (...args) => {
      const result = spawnSync('git', ['-c', `safe.directory=${repo}`, ...args], { cwd: repo, env, encoding: 'utf8' });
      assert.equal(result.status, 0, 'Git metadata must be readable');
      return result.stdout;
    };
    // Git enumerates working-tree bytes, including uncommitted/untracked sibling work.
    // Exclude secrets and generated caches even if accidentally tracked.
    inputs = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0'))]
      .filter((path) => path && !/(^|\/)(?:\.env(?:\..*)?|[^/]*\.env(?:\..*)?|node_modules|dist|build|\.dart_tool)(\/|$)/.test(path)
        && existsSync(join(repo, path))).sort();
    before = hashes(repo, inputs);
    distBefore = hashes(repo, ['dist']);
    Object.assign(manifest, { head: git('rev-parse', 'HEAD').trim(), git_status: git('status', '--porcelain=v1').trim(), source_sha256: before });
    pgBin = pgBinOverride || spawnSync('pg_config', ['--bindir'], { env, encoding: 'utf8' }).stdout?.trim();
    assert.ok(pgBin && ['initdb', 'pg_ctl'].every((binary) => existsSync(join(pgBin, binary))), 'Missing PostgreSQL server binaries; set PG_BINDIR');
    scratch = mkdtempSync(join(tmpdir(), 'restore-acceptance-'));
    env.npm_config_cache = join(scratch, 'npm-cache');
    for (const name of ['positive', 'negative']) {
      const root = join(scratch, name);
      mkdirSync(root);
      for (const input of inputs) {
        mkdirSync(dirname(join(root, input)), { recursive: true });
        cpSync(join(repo, input), join(root, input));
      }
      assert.deepEqual(hashes(root, inputs), before, 'Snapshot differs from current source');
    }
    const positive = join(scratch, 'positive'), negative = join(scratch, 'negative');
    const defect = reconstructBindingDefect(readFileSync(join(negative, target), 'utf8'));
    writeFileSync(join(negative, target), defect.source);
    json('negative-control.json', { file: target, fixed: defect.fixed, broken: defect.broken,
      description: 'Original unused $2 restore binding only; timestamp precision clamps retained' });
    manifest.negative_source_sha256 = hashes(negative, inputs);
    assert.deepEqual(inputs.filter((path) => before[path] !== manifest.negative_source_sha256[path]), [target]);
    // Install only into our snapshot. No npm hooks, shared node_modules, or shared dist writes.
    success(run('dependencies', 'npm', ['ci', '--include=dev', '--include=optional', '--ignore-scripts', '--no-audit', '--no-fund'], positive));
    symlinkSync(join(positive, 'node_modules'), join(negative, 'node_modules'), 'dir');
    for (const [name, root] of [['positive', positive], ['negative', negative]]) {
      success(run(`${name}-build`, process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json'], root));
      Object.assign(manifest.phases[`${name}-build`], { tested_source_sha256: hashes(root, inputs), dist_sha256: hashes(root, ['dist']) });
      assert.deepEqual(hashes(root, inputs), name === 'positive' ? before : manifest.negative_source_sha256);
    }
    // Short private socket directory; no TCP listener or shared database is used.
    // Queued workers can have a long TMPDIR but permit a short owned directory
    // in the checkout. Containers use /tmp and need only a read-only checkout.
    const socketRoot = Buffer.byteLength(join(tmpdir(), 'restore-pg-XXXXXX/.s.PGSQL.5432')) < 104 ? tmpdir() : repo;
    pgDirectory = mkdtempSync(join(socketRoot, '.rp-'));
    assert.ok(Buffer.byteLength(join(pgDirectory, '.s.PGSQL.5432')) < 104, 'TMPDIR too long for PostgreSQL socket');
    success(run('postgres-init', join(pgBin, 'initdb'), ['-D', join(pgDirectory, 'data'), '-U', 'handrail_test', '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--no-locale']));
    assert.ok(!/[\s'\\]/.test(pgDirectory), 'TMPDIR must not contain spaces, quotes, or backslashes');
    success(run('postgres-start', join(pgBin, 'pg_ctl'), ['-D', join(pgDirectory, 'data'), '-l', join(pgDirectory, 'server.log'), '-o', `-p 5432 -c listen_addresses='' -c unix_socket_directories='${pgDirectory}' -c unix_socket_permissions=0700 -c log_error_verbosity=verbose`, '-w', 'start']));
    env.TEST_DATABASE_URL = `postgresql://handrail_test@localhost:5432/postgres?host=${encodeURIComponent(pgDirectory)}`;
    secrets.push(env.TEST_DATABASE_URL);
    const { createPostgresTestBackend } = await import(pathToFileURL(join(positive, 'dist/testing/index.js')));
    backend = await createPostgresTestBackend({ testDatabaseUrl: env.TEST_DATABASE_URL });
    probe = await backend.createHarness({ schemaPrefix: 'restore_acceptance' });
    json('postgres.json', { version: (await probe.pool.query('SELECT version() AS version')).rows[0].version,
      kind: backend.kind, setup: 'owned native cluster; non-root; private Unix socket; TCP disabled', probe_schema: probe.schema });
    assert.deepEqual(await remainingSchemas(), []);
    const pass = suite('positive-test', positive);
    success(pass);
    assert.equal(pass.counts.pass, 8);
    assert.equal(pass.counts.fail, 0);
    assert.ok(pass.cases.every(({ passed }) => passed));
    manifest.cleanup.after_positive_schemas = await remainingSchemas();
    assert.deepEqual(manifest.cleanup.after_positive_schemas, []);
    const fail = suite('negative-control', negative);
    assert.equal(fail.exit_status, 1);
    assert.deepEqual(fail.cases.map(({ name }) => name), pass.cases.map(({ name }) => name));
    assert.deepEqual(fail.cases.filter(({ passed }) => !passed).map(({ name }) => name), [
      'archives and restores exactly once while retaining conversation data',
      'persists convergent and stale-revision outcomes without effects',
      'emits protocol-versioned outbox and sanitized audit content',
    ]);
    const diagnostic = fail.cases[0].diagnostic;
    assert.match(diagnostic, /could not determine data type of parameter \$2/);
    assert.match(diagnostic, /code: ['"]?42P18/);
    json('postgres-error.json', { sqlstate: diagnostic.match(/code: ['"]?(42P18)/)[1], diagnostic });
    assert.equal(fail.counts.pass, 4);
    assert.equal(fail.counts.fail, 4); // Three children plus their parent; latter failures follow the rolled-back restore.
    manifest.cleanup.after_negative_schemas = await remainingSchemas();
    assert.deepEqual(manifest.cleanup.after_negative_schemas, []);
    manifest.accepted = true;
  } catch (error) {
    manifest.error = redact(error.stack ?? String(error));
    process.exitCode = 1;
  } finally {
    // Attempt every independent cleanup even if another cleanup step fails.
    const cleanup = async (name, action) => {
      try { await action(); manifest.cleanup[name] = true; }
      catch (error) { manifest.cleanup[name] = redact(error.stack ?? String(error)); manifest.accepted = false; process.exitCode = 1; }
    };
    await cleanup('backend_removed', async () => {
      await backend?.teardown();
      if (probe) {
        // Verify probe teardown with a separate short-lived backend before stopping the cluster.
        const { createPostgresTestBackend } = await import(pathToFileURL(join(scratch, 'positive/dist/testing/index.js')));
        const verifier = await createPostgresTestBackend({ testDatabaseUrl: env.TEST_DATABASE_URL });
        try { assert.equal(await verifier.schemaExists(probe.schema), false); } finally { await verifier.teardown(); }
      }
    });
    await cleanup('postgres_stopped', () => {
      if (pgDirectory && existsSync(join(pgDirectory, 'data/postmaster.pid'))) success(run('postgres-stop', join(pgBin, 'pg_ctl'), ['-D', join(pgDirectory, 'data'), '-m', 'immediate', '-w', 'stop']));
    });
    await cleanup('postgres_log_retained', () => {
      if (pgDirectory && existsSync(join(pgDirectory, 'server.log'))) writeFileSync(join(output, 'postgres-server.log'), redact(readFileSync(join(pgDirectory, 'server.log'), 'utf8')));
    });
    await cleanup('owned_directories_removed', () => {
      if (pgDirectory) {
        assert.ok(!existsSync(join(pgDirectory, 'data/postmaster.pid')), 'Refusing to remove a running cluster');
        rmSync(pgDirectory, { recursive: true, force: true });
      }
      if (scratch) rmSync(scratch, { recursive: true, force: true });
      assert.ok(!scratch || !existsSync(scratch));
      assert.ok(!pgDirectory || !existsSync(pgDirectory));
    });
    await cleanup('shared_inputs_and_dist_unchanged', () => {
      if (before) assert.deepEqual(hashes(repo, inputs), before, 'Shared source changed during acceptance');
      if (distBefore) assert.deepEqual(hashes(repo, ['dist']), distBefore, 'Shared dist changed during acceptance');
    });
    manifest.finished_at = new Date().toISOString();
    json('source-identity.json', manifest);
    json('evidence-metadata.json', { environment: 'dev', evidence: readdirSync(output).sort().map((filename) => ({
      kind: filename.endsWith('.log') ? 'log' : 'file', filename, path: join(output, filename),
      mime_type: filename.endsWith('.json') ? 'application/json' : 'text/plain',
      content_sha256: sha(readFileSync(join(output, filename))), size_bytes: lstatSync(join(output, filename)).size,
      redaction_status: 'redacted', visibility: 'staff_only',
    })) });
    console.log(`Acceptance ${manifest.accepted ? 'PASSED' : 'FAILED'}; evidence: ${output}`);
    if (manifest.error) console.error(manifest.error);
  }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main();
