#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const native = args[0] === '--native';
if (native) args.shift();
if (args.length !== 1) throw new Error('Usage: node scripts/accept-huddle-renewal.mjs [--native] NEW_EVIDENCE_DIRECTORY');
const output = resolve(args[0]);
mkdirSync(output, { recursive: false, mode: 0o700 });
const scratch = mkdtempSync(join(tmpdir(), 'huddle-acceptance-'));
const nativeBin = process.env.PG_BINDIR;
const env = { ...process.env };
// Ordinary application/operator database credentials are never test inputs.
for (const key of Object.keys(env)) {
  if (/^(DATABASE_URL|PG[A-Z_]+)$/.test(key)) {
    delete env[key];
    delete process.env[key];
  }
}
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /PASSWORD|SECRET|TOKEN|DATABASE_URL|VAULT_KEY/.test(key) && value?.length >= 4)
  .map(([, value]) => value);
const redact = (text) => {
  for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
  return text.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/g, 'postgresql://[REDACTED]');
};
const json = (name, value) => writeFileSync(join(output, name), redact(JSON.stringify(value, null, 2)) + '\n');
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
const inputs = ['src', 'test', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json'];
const before = hashes(repo, inputs);
const distBefore = hashes(repo, ['dist']);
const git = (...args) => {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
const manifest = { started_at: new Date().toISOString(), node: process.version,
  head: git('rev-parse', 'HEAD'), git_status: git('status', '--porcelain=v1'),
  source_sha256: before, phases: {}, accepted: false };
let pgDirectory;
let pgBin;
let backend;
function run(name, command, args, cwd = repo) {
  console.log(`Running ${name}`);
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
  const text = redact(`$ ${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\nexit_status=${result.status} signal=${result.signal ?? 'none'}\n${result.error ?? ''}\n`);
  writeFileSync(join(output, `${name}.log`), text);
  const phase = { command: [command, ...args], exit_status: result.status, signal: result.signal, log: `${name}.log` };
  manifest.phases[name] = phase;
  return { ...phase, text };
}
function success(result) { assert.equal(result.exit_status, 0, `See ${result.log}`); }
function suite(name, root) {
  const result = run(name, process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', 'test/postgres-join-huddle-command.test.mjs'], root);
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const match = result.text.match(new RegExp(`^# ${key} (\\d+)$`, 'm'));
    assert.ok(match, `Missing ${key} count in ${result.log}`);
    counts[key] = Number(match[1]);
  }
  const cases = [...result.text.matchAll(/^    (not ok|ok) \d+ - (.+)\n([\s\S]*?)(?=^    # Subtest:|^    1\.\.)/gm)]
    .map(([, status, name, diagnostic]) => ({ name, passed: status === 'ok', diagnostic }));
  Object.assign(manifest.phases[name], { counts, cases });
  assert.equal(counts.skipped + counts.cancelled + counts.todo, 0, 'Skipped/incomplete tests are not acceptance');
  assert.equal(cases.length, 12, 'Focused regression scope changed; review the acceptance expectations');
  assert.equal(counts.tests, 13); // Twelve children plus the enclosing test.
  assert.ok(!/^\s*(?:not )?ok \d+ .*# (?:SKIP|TODO)\b/im.test(result.text));
  return { ...result, counts, cases };
}
try {
  for (const name of ['positive', 'negative']) {
    const root = join(scratch, name);
    mkdirSync(root);
    for (const input of inputs) cpSync(join(repo, input), join(root, input), { recursive: true });
    assert.deepEqual(hashes(root, inputs), before, 'Snapshot must include current uncommitted bytes');
    symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
  }
  const positive = join(scratch, 'positive');
  const negative = join(scratch, 'negative');
  const sourcePath = 'src/server/join-huddle-command.ts';
  const source = readFileSync(join(negative, sourcePath), 'utf8');
  const repair = /    } else if \(\n      previousState.status === "active" &&[\s\S]*?      \/\/ A fresh key for an already-joined actor renews credentials only\.[\s\S]*?        reconciliationStatus: "replayed",\n      };\n(?=    } else \{)/g;
  const matches = [...source.matchAll(repair)];
  assert.equal(matches.length, 1, 'Renewal repair shape changed; refusing an ambiguous negative control');
  writeFileSync(join(negative, sourcePath), source.replace(repair, ''));
  writeFileSync(join(output, 'negative-control-removal.txt'), matches[0][0]);
  manifest.negative_source_sha256 = hashes(negative, inputs);
  assert.deepEqual(Object.keys(before).filter((key) => before[key] !== manifest.negative_source_sha256[key]), [sourcePath]);
  // Each npm build owns its source generation and dist; neither uses shared dist.
  for (const [name, root] of [['positive', positive], ['negative', negative]]) {
    success(run(`${name}-build`, 'npm', ['run', 'build'], root));
    manifest.phases[`${name}-build`].tested_source_sha256 = hashes(root, inputs);
    manifest.phases[`${name}-build`].dist_sha256 = hashes(root, ['dist']);
  }
  if (native) {
    assert.ok(!process.env.TEST_DATABASE_URL?.trim(), '--native requires TEST_DATABASE_URL to be unset');
    pgBin = nativeBin || spawnSync('pg_config', ['--bindir'], { encoding: 'utf8' }).stdout?.trim();
    assert.ok(pgBin && existsSync(join(pgBin, 'initdb')), 'Missing native PostgreSQL server binaries');
    // Short private path: PostgreSQL Unix sockets have a platform path limit.
    pgDirectory = mkdtempSync(join(repo, '.huddle-pg-'));
    success(run('postgres-init', join(pgBin, 'initdb'), ['-D', join(pgDirectory, 'data'), '-U', 'handrail_test', '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--no-locale']));
    success(run('postgres-start', join(pgBin, 'pg_ctl'), ['-D', join(pgDirectory, 'data'), '-l', join(pgDirectory, 'server.log'), '-o', `-p 5432 -c listen_addresses='' -c unix_socket_directories='${pgDirectory}' -c unix_socket_permissions=0700`, '-w', 'start']));
    env.TEST_DATABASE_URL = `postgresql://handrail_test@localhost:5432/postgres?host=${pgDirectory}`;
  }
  const { createPostgresTestBackend } = await import(pathToFileURL(join(positive, 'dist/testing/index.js')));
  backend = await createPostgresTestBackend({ ...(env.TEST_DATABASE_URL ? { testDatabaseUrl: env.TEST_DATABASE_URL } : {}) });
  secrets.push(backend.connectionString);
  env.TEST_DATABASE_URL = backend.connectionString;
  const probe = await backend.createHarness({ schemaPrefix: 'huddle_acceptance' });
  try {
    const version = await probe.pool.query('SELECT version() AS version');
    json('postgres.json', { environment: 'dev', kind: backend.kind, setup: native ? 'disposable native cluster; private Unix socket; TCP disabled; local trust; host reject' : process.env.TEST_DATABASE_URL ? 'explicit TEST_DATABASE_URL; credentials and endpoint redacted' : 'disposable postgres:16-alpine container', version: version.rows[0].version, probe_schema: probe.schema, test_schema_prefix: 'chat_join_huddle', secrets_redacted: true });
  } finally { await probe.teardown(); }
  assert.equal(await backend.schemaExists(probe.schema), false);
  const pass = suite('positive-test', positive);
  success(pass);
  assert.equal(pass.counts.pass, 13);
  assert.equal(pass.counts.fail, 0);
  assert.ok(pass.cases.every((entry) => entry.passed));
  const fail = suite('negative-control', negative);
  assert.equal(fail.exit_status, 1);
  assert.deepEqual(fail.cases.map(({ name }) => name), pass.cases.map(({ name }) => name));
  const expected = ['renews with a fresh key without another durable join', 'retries a completed fresh renewal key after provider failure without another durable join'];
  assert.deepEqual(fail.cases.filter((entry) => !entry.passed).map(({ name }) => name), expected);
  for (const entry of fail.cases.filter((entry) => !entry.passed)) {
    assert.match(entry.diagnostic, /The actor is already joined to this huddle/);
  }
  assert.match(fail.cases.find(({ name }) => name === expected[0]).diagnostic, /participant_already_joined/);
  assert.equal(fail.counts.pass, 10);
  assert.equal(fail.counts.fail, 3); // Two expected failures plus their parent.
  manifest.accepted = true;
} catch (error) {
  manifest.error = redact(error.stack ?? String(error));
  process.exitCode = 1;
} finally {
  try {
    await backend?.teardown();
    if (pgDirectory && existsSync(join(pgDirectory, 'data/postmaster.pid'))) {
      success(run('postgres-stop', join(pgBin, 'pg_ctl'), ['-D', join(pgDirectory, 'data'), '-m', 'immediate', '-w', 'stop']));
    }
    if (pgDirectory && existsSync(join(pgDirectory, 'server.log'))) writeFileSync(join(output, 'postgres-server.log'), redact(readFileSync(join(pgDirectory, 'server.log'), 'utf8')));
    if (pgDirectory) rmSync(pgDirectory, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    assert.deepEqual(hashes(repo, inputs), before, 'Shared inputs changed during acceptance');
    assert.deepEqual(hashes(repo, ['dist']), distBefore, 'Shared build output changed during acceptance');
    manifest.shared_inputs_and_dist_unchanged = true;
    manifest.temporary_resources_removed = true;
  } catch (error) {
    manifest.accepted = false;
    manifest.cleanup_error = redact(error.stack ?? String(error));
    process.exitCode = 1;
  }
  manifest.finished_at = new Date().toISOString();
  json('source-identity.json', manifest);
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
