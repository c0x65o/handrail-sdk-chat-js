// Current-source PostgreSQL 16 qualification. No application DATABASE_URL fallback.
// Usage: PG_BINDIR=/path/to/postgresql/16/bin node scripts/qualify-reply-threads.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
const root = resolve(import.meta.dirname, '..');
const evidence = resolve(root, 'docs/validation/owner-task-24350c4f');
const bin = process.env.PG_BINDIR;
assert.ok(bin, 'PG_BINDIR must identify PostgreSQL 16 server binaries');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('PG') && !['DATABASE_URL', 'TEST_DATABASE_URL'].includes(key)));
const run = (cmd, args, log) => {
  const result = spawnSync(cmd, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (log) return writeFile(join(evidence, log), `${result.stdout ?? ''}${result.stderr ?? ''}`).then(() => result);
  assert.equal(result.status, 0, `${cmd}: ${result.stderr ?? result.error}`);
  return result;
};
await mkdir(evidence, { recursive: true });
const compiled = await run('npm', ['run', 'build'], 'postgres-build.log');
assert.equal(compiled.status, 0, 'Current source build failed; see postgres-build.log');
const version = run(join(bin, 'postgres'), ['--version']).stdout.trim();
assert.match(version, /PostgreSQL\) 16\./);
await writeFile(join(evidence, 'postgres-version.txt'), version + '\n');
// Keep the private socket path below PostgreSQL's Unix socket length limit.
const directory = await mkdtemp('/tmp/handrail-codex-heavy-command-locks/chat-pg16-');
const generated = [];
let started = false;
let failed = false;
try {
  run(join(bin, 'initdb'), ['-D', join(directory, 'data'), '-U', 'handrail_test', '--auth-local=trust', '--auth-host=reject', '--encoding=UTF8', '--no-locale']);
  run(join(bin, 'pg_ctl'), ['-D', join(directory, 'data'), '-l', join(directory, 'server.log'), '-o', `-c listen_addresses='' -c unix_socket_directories='${directory}' -c unix_socket_permissions=0700 -c max_connections=40 -c shared_buffers=32MB -c timezone=UTC`, '-w', 'start']);
  started = true;
  env.TEST_DATABASE_URL = `postgresql://handrail_test@/postgres?host=${encodeURIComponent(directory)}`;
  const names = process.argv.slice(2);
  assert.ok(names.length, 'Pass test basenames (without .test.mjs)');
  for (const name of names) {
    assert.match(name, /^[a-z0-9-]+$/);
    const output = join(root, 'test', `.qualification-${name}.mjs`);
    generated.push(output);
    await build({ entryPoints: [join(root, 'test', `${name}.test.mjs`)], outfile: output,
      bundle: true, platform: 'node', format: 'esm', packages: 'external',
      plugins: [{ name: 'source-manifest-location', setup(builder) {
        builder.onLoad({ filter: /src\/server\/create-(chat-server|thread-command|conversation-command)\.ts$/ }, async ({ path }) => ({
          contents: (await readFile(path, 'utf8')).replace('createRequire(import.meta.url)("../../package.json")',
            `createRequire(import.meta.url)(${JSON.stringify(join(root, 'package.json'))})`), loader: 'ts',
        }));
      } }],
    });
    const result = await run(process.execPath, ['--test', '--test-concurrency=1', output], `${name}.log`);
    console.log(`${name}: ${result.status === 0 ? 'PASS' : 'FAIL'} (exit ${result.status})`);
    failed ||= result.status !== 0;
  }
  const remaining = run(join(bin, 'psql'), [env.TEST_DATABASE_URL, '-Atc', "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'"]).stdout.trim();
  await writeFile(join(evidence, 'postgres-teardown.txt'), `Remaining test schemas: ${remaining || 'none'}\n`);
  assert.equal(remaining, '', 'A test leaked an isolated schema');
} finally {
  if (started) run(join(bin, 'pg_ctl'), ['-D', join(directory, 'data'), '-m', 'fast', '-w', 'stop']);
  try { await writeFile(join(evidence, 'postgres-server.log'), await readFile(join(directory, 'server.log'))); } catch {}
  await rm(directory, { recursive: true, force: true });
  for (const file of generated) await rm(file, { force: true });
}
process.exitCode = failed ? 1 : 0;
