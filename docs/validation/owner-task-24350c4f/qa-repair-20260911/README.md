# QA finding repairs — September 11, 2026

Implementation evidence for task `24350c4f-985e-4762-ac15-445f69009f18`.
All three supplied findings are repaired in this working tree. Independent
acceptance and overall SDK readiness remain outstanding. No commit or push.

## Reconciliation and available context

JS HEAD is `693459fc6dfc21b2f5b061a9c2693325e0c2805c`, exactly the HEAD reported
by QA. The eight source hashes in the prior `lab-database-20260911/final-artifact.json`
all matched before editing. Both linked Flutter checkouts were clean. No pending
merge/rebase/index lock was present. Deferred Main synchronization was not
bypassed: no fetch, reset, stash, checkout, index change or history change.
`baseline.json` records all three revisions, initial status and tracked file
hashes. Historical patches were not reapplied.

The supplied saved brief/rules were read, as were the retained lab diagnosis,
repair manifest, PG reproduction instructions and historical Flutter evidence.
**Handrail scoped tools, including current_context and the work-request/memory
readers, are unavailable in this run's tool catalog.** Thus the four attached
memory publications could not be fetched separately, nor could QA WR
`ecbcc04e-f093-449b-9d3e-22d3c9df1890`, run
`acffb8d4-25d2-40a3-b794-940106486035`. The supplied full worker-record SHA256
`87c9f60be5283c293bdf5cbfcde806e9526096d43f3d32b23d2a079cfa589552`
is a requested identity, not a hash verified here. Its canonical result is
**failed**, regardless of worker execution success.

`artifacts/qa-reproductions.tar.gz` was not present in the exposed repository or
run-private files. Its supplied SHA256
`1d5e2094372d992c348ea8556ab1a04c531bd95e64e07e4df7a85fc2b68f67ae`
is likewise unverified. The full record's reproduction commands could not be
read without scoped readers. No inaccessible historical host path was retried.
The tests here are new regressions from the three supplied findings; they are
not represented as a rerun of QA's 10 passing/four failing focused tests.

## Responses to findings

1. **Opaque PostgreSQL selections:** require the PostgreSQL URI `//` prefix
   before WHATWG parsing. Reject `postgres:garbage`, `postgres:`, equivalent
   `postgresql:` forms and single-slash forms before any harness call. Retain
   options → CHAT_LAB_DATABASE_URL → TEST_DATABASE_URL → DATABASE_URL precedence,
   exact selected bytes, no fallback, and credential-safe diagnostics. Tests
   check every selector and the installed lab pg parser for database-only,
   default-only, host/port/user/password, encoded password, IPv6, encoded socket
   host and query socket forms. PG16 tests exercise database-only selection with
   explicit private PG defaults through real fixture startup and SQL. The
   installed parser retains IPv6 brackets; this is parser evidence, not an IPv6
   network connectivity claim.
2. **Lost container-stop failure:** `createPostgresTestBackend` now throws an
   AggregateError containing the startup error (with its original cause) and
   cleanup error when recovery's `stop()` rejects. Successful cleanup still
   preserves the original cause without reporting a cleanup failure. The test
   intercepts only the testcontainers `start` service boundary: an acquired
   object's `getConnectionUri()` fails and its `stop()` independently fails.
   It executes the compiled lower layer directly and then the real
   `createChatTestHarness` → lab wrapper path. The wrapper reports cleanup
   failure without retaining synthetic credential-bearing messages or causes.
   No Docker container or database is started by these boundary tests.
3. **Vite close skips database teardown:** one shared close promise attempts
   media, Vite, the acquired backend harness, and idempotent storage cleanup,
   collecting failures. Startup recovery uses the same cleanup function and
   retains the startup error plus cleanup errors. Tests inject media/Vite/DB
   close failures, cover backend/create/attach/listen/address/origin startup
   failures, concurrent/repeated close, successful cleanup, and acquisition
   boundaries. Two PG16 tests use the real installed lab backend with only
   Vite intercepted. Vite close failure on normal close and startup failure
   leaves zero owned schema/listener leaks and preserves sentinel schema data.
   No unrelated backend, container or listener is cleaned.

## Commands and results

Run from the JS repository root, with the existing installed dependencies:

```sh
node node_modules/typescript/bin/tsc --project tsconfig.json
node --test --test-concurrency=1 --experimental-test-module-mocks examples/drop-in-react/test/ChatLabDatabase.test.mjs examples/drop-in-react/test/ChatLabCleanup.test.mjs test/postgres-container-startup-cleanup.test.mjs
PG_BINDIR=/path/to/private/extracted/usr/lib/postgresql/16/bin node docs/validation/owner-task-24350c4f/qa-repair-20260911/verify-postgres.mjs /new/evidence/output
git diff --check
```

- TypeScript compile/build: exit 0, `compile.log`. This compiles the typed SDK
  into root dist without running generators or changing installed packages.
- Focused tests: **15 passed, zero failed/skipped**, `focused-tests.log`.
- New PG16 failure-injection tests: **2 passed, zero failed/skipped**,
  `postgres/focused-tests.log`. No completed qualification suite was repeated.
- Seven `node --check` calls and diff whitespace check passed;
  `syntax-and-diff.json` records exact commands/results.
- `precompile-tests.log` retains the development run: 13 passed, two failed.
  One failure reproduced the old compiled container recovery; one was the
  corrected IPv6 parser expectation described above.
- `negative-control.log` deliberately loads the original lab modules and saved
  precompile testing module through `negative-control-loader.mjs`: nine passed,
  six failed. It establishes sensitivity of the new tests to baseline behavior;
  it is distinct from the unavailable independent QA reproduction archive.
  The resource guard reported the expected exit 1 (80 MiB peak, no OOM kill).

Negative-control command (do not treat its failure as final patch failure):

```sh
node --import ./docs/validation/owner-task-24350c4f/qa-repair-20260911/negative-control-loader.mjs --test --test-concurrency=1 --experimental-test-module-mocks examples/drop-in-react/test/ChatLabDatabase.test.mjs examples/drop-in-react/test/ChatLabCleanup.test.mjs test/postgres-container-startup-cleanup.test.mjs
```

## PostgreSQL safety and teardown

Reused the retained supported PGDG 16.15 package URLs and SHA256s from
`../reproduce.md`, privately downloaded and extracted under this run's tmp.
`pg16-tooling.json` records verified package hashes. No system installation,
UID override, managed resource, declared service or held database was used.
The runner derives from the existing lab DB runner and only runs the two new
cleanup tests. It removes inherited database/PG configuration and NODE_OPTIONS.

PostgreSQL ran as UID 993, with TCP disabled, private 0700 socket directory,
40 connections and 32MB shared buffers. Tests verified the complete schema list
was restored, sentinel data was preserved, media upgrade handlers detached and
the owned backend port could be rebound and closed. No browser/HTTP probe or
Vite listener was used. `postgres/result.json` and retained start/stop/schema
logs prove zero remaining fixture schemas, successful fast shutdown and owned
directory removal. Only inert extracted PG tools remain in run-private tmp.

## Exact artifact and independent handoff

`source.patch` contains all seven changed/new implementation and test files
against the unchanged JS HEAD. `artifact.json` identifies its SHA256, every
changed file, compiled testing module, installed lab dependency provenance,
and reconstruction check. `manifest-sha256.json` hashes the evidence files.
The source patch was checked and applied in a disposable directory containing
only the relevant baseline files, and every reconstructed file matched the
working-tree bytes. No Git repository was initialized or index modified.

Return this package to the same task for the **existing independent reviewer**
to review this exact patch and reconcile the full failed QA record and original
reproductions through scoped readers. This implementation run does not act as
that independent reviewer or update task/queue/database state.

Retain all saved holds: managed resource
`c699099d-668d-4a0f-a5a0-7f52923f3e32` and service
`812c4054-6ced-4616-94fb-13f672b3e897` remain held. No configuration/generated-env
changes, provisioning, substitution, listener handoff, publication or deployment.
Hitcents `0f617308-8c3a-4ad4-83e7-34b1fda024b3` remains read-only and untouched.

Preserve the saved build proposal and lockfile diagnosis from the request:
Flutter 3.41.7/Dart 3.11.5 enforcement failed with exit 65; a disposable candidate
passed after 16 dependency changes. JS archive and Flutter local-package builds
passed; clean npm installation and runtime handoff remain unproven. Those claims
are inherited evidence, not new checks. No pins, lockfiles, dependencies or
declared runtime overrides were changed, and compatibility/qualification suites
were not repeated. The PG tests use the existing installed lab SDK; the root
compile does not upgrade that package or qualify a final runtime.

Accepted Hitcents integration planning, the independent 23-test PG receipt,
historical inconclusive QA/media, fixture provenance, native limitations and
4px Send limitation remain unchanged. Overall readiness is **not accepted**.
