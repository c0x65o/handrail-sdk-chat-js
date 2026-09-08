#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const example = fileURLToPath(new URL('../', import.meta.url));
const repo = path.resolve(example, '../..');
export const findingId = '0791d064-3e24-4882-b47d-67d8b617f40c';

export function isolatedEnvironment(input) {
  return Object.fromEntries(Object.entries(input).filter(([key]) =>
    !/^(?:.*DATABASE_URL|PG[A-Z_]+|.*CHAT_LAB.*|NODE_OPTIONS|NODE_PATH|PLAYWRIGHT_JSON_.*)$/.test(key)));
}

export function requireComplete(report) {
  const specs = [];
  const visit = suite => {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  };
  visit(report);
  assert.equal(report.errors?.length ?? 0, 0, 'Runner errors mean incomplete acceptance');
  assert.equal(specs.length, 1, 'Exactly the existing recovery regression must execute');
  const tests = specs[0].tests;
  assert.equal(tests.length, 1, 'Exactly one browser execution is required');
  assert.equal(tests[0].expectedStatus, 'passed', 'Skipped/expected-failure execution is incomplete');
  assert.equal(tests[0].results.length, 1, 'Retries cannot hide a recovery failure');
  assert.equal(tests[0].results[0].status, 'passed', 'Missing, skipped or failed execution is incomplete');
  assert.equal(report.stats?.expected, 1);
  for (const key of ['unexpected', 'flaky', 'skipped']) assert.equal(report.stats[key], 0);
}

function digestTree(root, directories) {
  const hash = createHash('sha256');
  function visit(relative) {
    const absolute = path.join(root, relative);
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) visit(child);
      else hash.update(child).update('\0').update(readFileSync(path.join(root, child))).update('\0');
    }
  }
  for (const directory of directories) visit(directory);
  return hash.digest('hex');
}

export async function runAcceptance(options = {}) {
  const { name = 'flutter-cross-client-recovery', finding = findingId,
    config = 'playwright.cross-client-recovery.config.mjs', evidenceFile = 'recovery.json',
    screenshots = 2, verifyEvidence } = options;
  const output = process.argv[2] ? path.resolve(process.argv[2]) :
    path.join(repo, 'build', `${name}-acceptance-${Date.now()}`);
  mkdirSync(output, { recursive: false, mode: 0o700 });
  const manifest = { findingId: finding, command: [process.execPath, ...process.argv.slice(1)],
    startedAt: new Date().toISOString(), result: 'incomplete', accepted: false,
    flutterExecutable: process.env.FLUTTER_BIN || (process.env.FLUTTER_ROOT ? path.join(process.env.FLUTTER_ROOT, 'bin/flutter') : 'flutter'),
    phases: {}, cleanup: {} };
  const env = isolatedEnvironment(process.env);
  const secrets = Object.entries(process.env).filter(([key, value]) =>
    /PASSWORD|SECRET|TOKEN|DATABASE_URL/.test(key) && value.length >= 4).map(([, value]) => value);
  const redact = value => {
    let text = String(value);
    for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]');
    return text.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/g, 'postgresql://[REDACTED]');
  };
  const save = () => writeFileSync(path.join(output, 'acceptance.json'), redact(JSON.stringify(manifest, null, 2)) + '\n');
  let child;
  let interrupted;
  const interrupt = signal => { interrupted = signal; child?.kill('SIGTERM'); };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  async function run(name, command, args, cwd = repo) {
    assert.ok(!interrupted, `Interrupted by ${interrupted}`);
    console.log(`Running ${name}; evidence: ${output}`);
    let log = '';
    const result = await new Promise(resolve => {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', chunk => { log += chunk; });
      child.stderr.on('data', chunk => { log += chunk; });
      child.once('error', error => { log += error.message; });
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    child = undefined;
    writeFileSync(path.join(output, `${name}.log`), redact(log));
    manifest.phases[name] = { command: [command, ...args], ...result, log: `${name}.log` };
    save();
    assert.equal(result.code, 0, `Incomplete: ${name} failed; see ${name}.log`);
  }
  let pgDirectory, pgBin, probeBackend, probe;
  try {
    save();
    assert.ok(process.argv.length <= 3, `Usage: npm run accept:${name} -- [NEW_EVIDENCE_DIRECTORY]`);
    assert.ok(process.getuid?.() > 0, 'Native PostgreSQL acceptance requires a non-root user');
    pgBin = process.env.PG_BINDIR || spawnSync('pg_config', ['--bindir'], { env, encoding: 'utf8' }).stdout?.trim();
    assert.ok(pgBin && ['initdb', 'pg_ctl'].every(binary => existsSync(path.join(pgBin, binary))),
      'Missing native PostgreSQL server binaries; install PostgreSQL or set PG_BINDIR');
    // Compile current working-tree inputs through the existing build pipeline helpers.
    manifest.sdkRevision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, env, encoding: 'utf8' }).stdout.trim();
    manifest.configDigest = createHash('sha256').update(readFileSync(path.join(example, config))).digest('hex');
    manifest.sdkSourceDigest = digestTree(repo, ['src']);
    manifest.harnessDigest = digestTree(example, ['e2e', 'scripts']);
    await run('sdk-compile', process.execPath, ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.json']);
    await run('sdk-styles', process.execPath, ['scripts/copy-ui-styles.mjs']);
    assert.equal(digestTree(repo, ['src']), manifest.sdkSourceDigest, 'SDK inputs changed during compilation');
    manifest.sdkDistDigest = digestTree(repo, ['dist']);
    // Same native provisioning pattern as accept-restore.mjs: owned cluster,
    // private short Unix socket, no TCP, no inherited application/test DB URL.
    pgDirectory = mkdtempSync(path.join(repo, '.cr-'));
    assert.ok(Buffer.byteLength(path.join(pgDirectory, '.s.PGSQL.5432')) < 104 && !/[\s'\\]/.test(pgDirectory),
      'Repository path cannot host a private PostgreSQL socket');
    await run('postgres-init', path.join(pgBin, 'initdb'), ['-D', path.join(pgDirectory, 'data'), '-U', 'handrail_test',
      '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--no-locale']);
    await run('postgres-start', path.join(pgBin, 'pg_ctl'), ['-D', path.join(pgDirectory, 'data'), '-l', path.join(pgDirectory, 'server.log'),
      '-o', `-p 5432 -c listen_addresses='' -c unix_socket_directories='${pgDirectory}' -c unix_socket_permissions=0700`, '-w', 'start']);
    const databaseUrl = `postgresql://handrail_test@localhost:5432/postgres?host=${encodeURIComponent(pgDirectory)}`;
    secrets.push(databaseUrl);
    const { createPostgresTestBackend } = await import(pathToFileURL(path.join(repo, 'dist/testing/index.js')));
    probeBackend = await createPostgresTestBackend({ testDatabaseUrl: databaseUrl });
    probe = await probeBackend.createHarness({ schemaPrefix: 'cross_client_acceptance' });
    manifest.postgres = { setup: 'owned native cluster; private Unix socket; TCP disabled',
      version: (await probe.pool.query('SELECT version() AS version')).rows[0].version };
    env.CHAT_LAB_RECOVERY_DATABASE_URL = databaseUrl;
    env.CHAT_LAB_RECOVERY_ACCEPTANCE_DIR = output;
    env.PLAYWRIGHT_JSON_OUTPUT_FILE = path.join(output, 'playwright.json');
    await run('browser', process.execPath, ['node_modules/@playwright/test/cli.js', 'test',
      `--config=${config}`], example);
    const report = JSON.parse(readFileSync(env.PLAYWRIGHT_JSON_OUTPUT_FILE, 'utf8'));
    requireComplete(report);
    manifest.fixture = JSON.parse(readFileSync(path.join(output, 'fixture.json'), 'utf8'));
    assert.equal(manifest.fixture.closed, true, 'Fixture teardown did not complete');
    assert.equal(await probeBackend.schemaExists(manifest.fixture.schema), false, 'Fixture schema was not dropped');
    manifest.cleanup.schemaDropped = true;
    manifest.evidence = JSON.parse(readFileSync(path.join(output, evidenceFile), 'utf8'));
    if (verifyEvidence) verifyEvidence(manifest.evidence);
    else {
      assert.equal(manifest.evidence.provenance.sourceDigest, manifest.fixture.buildProvenance.sourceDigest);
      assert.equal(manifest.evidence.provenance.builtAt, manifest.fixture.buildProvenance.builtAt);
    }
    assert.equal(manifest.evidence.instance.instanceId, manifest.fixture.instanceId);
    for (const screenshot of manifest.evidence.screenshots) assert.ok(existsSync(screenshot), 'Missing screenshot');
    assert.equal(manifest.evidence.screenshots.length, screenshots);
    assert.equal(digestTree(repo, ['src']), manifest.sdkSourceDigest, 'SDK inputs changed during execution');
    assert.equal(digestTree(repo, ['dist']), manifest.sdkDistDigest, 'SDK build changed during execution');
    assert.equal(digestTree(example, ['e2e', 'scripts']), manifest.harnessDigest, 'Acceptance inputs changed during execution');
    assert.equal(createHash('sha256').update(readFileSync(path.join(example, config))).digest('hex'), manifest.configDigest);
    manifest.accepted = true;
  } catch (error) {
    manifest.error = redact(error.stack ?? error);
    console.error(redact(error.message));
  } finally {
    const cleanup = async (name, action) => {
      try { await action(); }
      catch (error) {
        manifest.accepted = false;
        manifest.cleanup[name] = redact(error.stack ?? error);
      }
    };
    // Keep partial identity/evidence on failures as well as successful runs.
    await cleanup('evidenceError', async () => {
      for (const [key, file] of [['fixture', 'fixture.json'], ['evidence', evidenceFile]]) {
        if (existsSync(path.join(output, file))) manifest[key] = JSON.parse(readFileSync(path.join(output, file), 'utf8'));
      }
    });
    await cleanup('schemaError', async () => {
      if (!probe) return;
      const remaining = (await probe.pool.query(
        "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public', 'information_schema', $1) AND nspname NOT LIKE 'pg_%'", [probe.schema],
      )).rows.map(row => row.nspname);
      manifest.cleanup.remainingSchemas = remaining;
      assert.deepEqual(remaining, [], 'Fixture left an owned schema behind');
    });
    await cleanup('probeError', async () => { await probe?.teardown(); });
    await cleanup('backendError', async () => { await probeBackend?.teardown(); });
    await cleanup('postgresError', async () => {
      if (pgDirectory && existsSync(path.join(pgDirectory, 'data/postmaster.pid'))) {
        // Cleanup must run even after a signal or failed browser setup.
        interrupted = undefined;
        await run('postgres-stop', path.join(pgBin, 'pg_ctl'), ['-D', path.join(pgDirectory, 'data'), '-m', 'immediate', '-w', 'stop']);
      }
      manifest.cleanup.postgresStopped = true;
    });
    await cleanup('filesError', async () => {
      // Retain a cluster whose stop failed, so it can be diagnosed and stopped.
      if (pgDirectory && manifest.cleanup.postgresStopped) rmSync(pgDirectory, { recursive: true, force: true });
      rmSync(path.join(output, 'flutter-web'), { recursive: true, force: true });
      manifest.cleanup.disposableFilesRemoved = true;
    });
    manifest.result = manifest.accepted ? 'passed' : 'incomplete';
    manifest.finishedAt = new Date().toISOString();
    save();
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    console.log(`Acceptance ${manifest.result}: ${path.join(output, 'acceptance.json')}`);
    process.exitCode = manifest.accepted ? 0 : 1;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await runAcceptance();
}
