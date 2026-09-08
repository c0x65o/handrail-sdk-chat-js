# PostgreSQL restore acceptance

For owner task `bbb16b0c-f648-4aca-922c-c81ecf144a4e`, run from
`handrail-sdk-chat`:

```sh
node scripts/accept-restore.mjs
```

This is the exact dev project-check/task command. It prints a fresh evidence
directory under `TMPDIR` (default `/tmp`). To select a durable artifact location,
pass a **new**, nonexistent directory whose parent exists and is writable:

```sh
node scripts/accept-restore.mjs /absolute/artifacts/restore-UNIQUE-RUN-ID
```

Use a path outside the checkout. Retain the whole directory as staff-only QA
evidence before the worker/container is removed. Exit 0 **and**
`source-identity.json` with `accepted: true` are required. Missing prerequisites,
compile failures, skipped/cancelled/todo assertions, unexpected negative failures,
and cleanup failures exit unsuccessfully. An interrupted run without a final
accepted manifest is unsuccessful too; retain its available logs.

## Required execution definition

The repository-owned [Dockerfile](../scripts/restore-acceptance.Dockerfile) supplies
Node 22, npm, Git, PostgreSQL 15 server binaries, and a non-root default user.
It needs no database service, privileged container, Docker socket, exposed ports,
or application environment. Build it in the subsequent runtime activation step:

```sh
docker build -f scripts/restore-acceptance.Dockerfile -t handrail-restore-acceptance:dev scripts
```

For a standalone dev/QA execution on a Docker-capable host:

```sh
# A private, host-owned evidence parent; the runner creates its child directory.
artifact_parent=$(mktemp -d "${TMPDIR:-/tmp}/restore-artifacts.XXXXXX")
docker run --rm --init --user "$(id -u):$(id -g)" \
  --mount "type=bind,src=$PWD,dst=/workspace,readonly" \
  --mount "type=bind,src=$artifact_parent,dst=/evidence" \
  handrail-restore-acceptance:dev \
  node scripts/accept-restore.mjs /evidence/run
```

Run that command as a non-root host user. On a root-only host, omit `--user` to
use the image's `node` user (UID/GID 1000); the separately prepared evidence mount
must be writable by UID 1000. Never override the container user to root. The
checkout and Git metadata must be readable; for Git worktrees, make the referenced
Git directory readable at its original path as well. The runner uses read-only
Git commands with an invocation-local safe-directory setting.

The equivalent native host configuration is a non-root Unix UID, Node 22/npm,
Git, PostgreSQL 15+ `initdb`/`pg_ctl` (`PG_BINDIR`, or discoverable via `pg_config`),
and a writable `TMPDIR`. For long queued-worker temporary paths the runner uses a
short owned `.rp-*` directory in the checkout for the socket; that fallback requires
a writable checkout. Container runs use short `/tmp` and a read-only checkout.
The worker used for this implementation has this
configuration. Both paths need npm registry access for `npm ci` from the current
snapshot's lockfile. Dependencies and npm cache are created only in private
scratch space; install hooks are disabled. No shared `node_modules` is required.
The image pins Node and PostgreSQL's major version; Debian security packages can
advance. Retain the built image digest during activation, plus the runner's exact
Node/PostgreSQL versions and lockfile hash, to identify the runtime used. This is
not a claim of PostgreSQL 16 verification or bit-for-bit Debian rebuilds.

## Subsequent typed Handrail activation and QA

This change does not configure Handrail or launch QA. A subsequent typed action
should inventory existing tasks/checks, then configure the SDK repo explicitly:

- Repo: `handrail-sdk-chat`; environment: `dev` only.
- Name: `PostgreSQL restore acceptance`; command: `node scripts/accept-restore.mjs`.
- Native project check: `check_type: test`, `resource_tier: standard`; its executor
  must meet the non-root native configuration above. A check has no image override;
  do not register it on an incompatible root-only executor.
- Container project task: slug `postgres-restore-acceptance`, `kind: test`,
  `execution_mode: isolated`, `image_override: <built image reference@sha256:digest>`,
  `working_dir: .`, `allowed_envs: [dev]`, `timeout_seconds: 900`,
  `work_request_trigger_phase: none`, `schedule_enabled: false`,
  `dev_provision_seed_enabled: false`, `vault_login_injection_enabled: false`.
  Ensure the isolated executor honors the image's non-root user and supplies the
  current checkout with readable Git metadata, a writable short `TMPDIR`, and
  artifact collection. If evidence is mounted, use the explicit-directory command
  above with a unique child for each invocation.

Do not inject `DATABASE_URL`, `TEST_DATABASE_URL`, PostgreSQL connection variables,
or login Vault credentials. The runner discards inherited database URLs/PG
connection settings and constructs its own test URL. Preserve existing Flutter
checks/tasks. After typed activation, invoke the configured task with
`run_project_task` with `{ "task_id": "<configured task UUID>", "env": "dev" }`,
then inspect `get_project_task_run` and
collect the reported evidence directory. QA must inspect the acceptance manifest
and logs, not just the task's scheduling/completion status. The Owner Goal runner
can use that evidence to resume restore acceptance; no status-only wake supplies
runtime proof.

## What the runner proves

The isolation and evidence conventions follow
[`accept-huddle-renewal.mjs`](../scripts/accept-huddle-renewal.mjs). Git enumerates
current working-tree files, including tracked edits and nonignored untracked
files; snapshots contain sibling reducer changes, including Flutter sources.
Secrets, ignored caches, and generated build directories are excluded. SHA-256
maps record the current snapshot, the negative snapshot, each compiled output,
HEAD, and working-tree status. Source contents/diffs are not retained, except the
small fixed/broken restore query needed to review the negative control. Logs and
metadata redact database URLs and inherited secret values.

Both copies compile with the lockfile's TypeScript compiler using
`tsconfig.json`. This intentionally avoids source generation from `npm run build`
so the tested source bytes match the snapshot. Shared source, tests, dependencies,
and `dist` are never written. Before/after hashes check shared source and `dist`.
Concurrent source edits invalidate acceptance; serialize the validation window.

A disposable native PostgreSQL cluster runs as the execution UID with TCP disabled,
a private mode-0700 Unix socket, local trust, and rejected host authentication.
The existing `createPostgresTestBackend` and
`test/postgres-archive-conversation-command.test.mjs` create schemas, apply actual
migrations, and run actual SQL. No shared database is provisioned or reset.

The corrected copy must pass all seven subtests (eight tests including the parent),
including restored revision **3**, null archive timestamp/user, and identical
restore replay with exactly **two audit and two outbox effects**. The negative
copy reinstates only the unused `$2` restore binding, leaving both timestamp
precision clamps and the affected-row guard intact. It must report PostgreSQL
`42P18` (`could not determine data type of parameter $2`), fail the restore test
and its two dependent state/effect tests, and pass the other four subtests,
including fractional-millisecond claim replay. TAP counts, case diagnostics,
process statuses, and the verbose PostgreSQL log are retained.

Cleanup evidence checks no test schemas remain after each suite, verifies probe
schema removal, records PostgreSQL stop status, and removes only owned scratch
and cluster directories. A running cluster directory is never blindly deleted.
`evidence-metadata.json` inventories redacted artifacts with hashes. The focused
runner-only fixture check (no database required) is:

```sh
node --test scripts/accept-restore.test.mjs
```
