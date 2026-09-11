// Derived from scripts/verify-chat-lab-database.mjs; only new cleanup regressions.
// Focused lab checks only. No browser, managed resource or declared service startup.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isolatedEnvironment } from "../../../../examples/drop-in-react/scripts/accept-flutter-cross-client-recovery.mjs";

const root = path.resolve(import.meta.dirname, "../../../..");
const output = path.resolve(process.argv[2]);
mkdirSync(output, { mode: 0o700 }); // Refuse to overwrite saved evidence.
const bin = process.env.PG_BINDIR;
assert.ok(bin, "Set PG_BINDIR to the existing PostgreSQL 16 binaries");
assert.ok(process.getuid() > 0, "Use unprivileged PostgreSQL");
const env = isolatedEnvironment(process.env);
const result = { uid: process.getuid(), checks: {}, cleanup: {}, passed: false };
const run = (name, command, args) => {
  const child = spawnSync(command, args, { cwd: root, env, encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  // This environment contains only disposable connection settings. Omit URLs
  // even for these fixtures; never copy inherited env or connection credentials.
  const log = `${child.stdout ?? ""}${child.stderr ?? ""}`.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/g, "postgresql://[REDACTED]");
  writeFileSync(path.join(output, `${name}.log`), log);
  result.checks[name] = { code: child.status, signal: child.signal };
  assert.equal(child.status, 0, `${name} failed; see retained log`);
  return log;
};
let directory;
try {
  result.version = run("postgres-version", path.join(bin, "postgres"), ["--version"]).trim();
  assert.match(result.version, /PostgreSQL\) 16\./);
  directory = mkdtempSync("/tmp/handrail-codex-heavy-command-locks/lab-db-");
  run("postgres-init", path.join(bin, "initdb"), ["-D", path.join(directory, "data"), "-U", "handrail_test",
    "--auth-local=trust", "--auth-host=reject", "--encoding=UTF8", "--no-locale"]);
  run("postgres-start", path.join(bin, "pg_ctl"), ["-D", path.join(directory, "data"), "-l", path.join(directory, "server.log"),
    "-o", `-c listen_addresses='' -c unix_socket_directories='${directory}' -c unix_socket_permissions=0700 -c max_connections=40 -c shared_buffers=32MB`, "-w", "start"]);
  env.PGHOST = directory;
  env.PGPORT = "5432";
  env.PGUSER = "handrail_test";
  env.PGDATABASE = "postgres";
  env.TEST_DATABASE_URL = `postgresql:///postgres?host=${encodeURIComponent(directory)}`;
  env.CHAT_LAB_DATABASE_CHECK_URL = env.TEST_DATABASE_URL;
  run("focused-tests", process.execPath, ["--test", "--experimental-test-module-mocks", "--test-concurrency=1", "--test-timeout=45000",
    "examples/drop-in-react/test/ChatLabCleanupPostgres.test.mjs"]);
  const remaining = run("remaining-schemas", path.join(bin, "psql"), ["-Atc",
    "SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%'"]).trim();
  assert.equal(remaining, "", "A fixture leaked its schema");
  result.cleanup.remainingSchemas = [];
  result.passed = true;
} finally {
  try {
    if (directory && existsSync(path.join(directory, "data/postmaster.pid"))) {
      run("postgres-stop", path.join(bin, "pg_ctl"), ["-D", path.join(directory, "data"), "-m", "fast", "-w", "stop"]);
    }
    result.cleanup.postgresStopped = true;
    if (directory) {
      if (existsSync(path.join(directory, "server.log"))) writeFileSync(path.join(output, "postgres-server.log"), readFileSync(path.join(directory, "server.log")));
      rmSync(directory, { recursive: true });
      result.cleanup.directoryRemoved = !existsSync(directory);
    }
  } catch {
    result.passed = false;
    result.cleanup.error = "Owned cluster cleanup failed; directory retained";
    result.cleanup.retainedDirectory = directory;
    process.exitCode = 1;
  }
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
}
