#!/usr/bin/env bash
# Development fixture only. Never connects to an existing database.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
: "${TMPDIR:?Set TMPDIR to a writable test scratch directory}"
: "${PG_BIN:?Set PG_BIN to the installed PostgreSQL bin directory}"
fixture=$(mktemp -d "$TMPDIR/pg.XXXXXX")
started=0
cleanup() {
  if [[ "$started" == 1 ]]; then
    "$PG_BIN/pg_ctl" -D "$fixture/data" -m fast -w stop
  fi
  # Keep fixture and logs for inspection; no broad cleanup or existing DB reset.
  printf 'Retained disposable fixture: %s\n' "$fixture"
}
trap cleanup EXIT
"$PG_BIN/postgres" --version
"$PG_BIN/initdb" -D "$fixture/data" --username=native_token_test --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 > "$fixture/initdb.log"
# A private Unix socket, no TCP listener, no inherited database credentials.
# Statement/error SQL logging is disabled because test statements bind secrets.
"$PG_BIN/pg_ctl" -D "$fixture/data" -l "$fixture/postgres.log" -o "-h '' -k '$fixture' -p 55432 -c max_connections=20 -c shared_buffers=32MB -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length_on_error=0" -w start
started=1
"$PG_BIN/createdb" -h "$fixture" -p 55432 -U native_token_test native_token_validation
export TEST_DATABASE_URL
TEST_DATABASE_URL=$(node --input-type=module -e 'const u = new URL("postgresql://native_token_test@localhost:55432/native_token_validation"); u.searchParams.set("host", process.argv[1]); console.log(u.href)' "$fixture")
"$PG_BIN/psql" "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT current_database(), current_user, version(), current_setting('data_directory') AS data_directory, current_setting('listen_addresses') AS listen_addresses;"
node --test --test-concurrency=1 test/postgres-native-tokens.test.mjs
"$PG_BIN/psql" "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT count(*) AS remaining_test_schemas FROM pg_namespace WHERE nspname LIKE 'native_upgrade_%' OR nspname LIKE 'native_tokens_%';"
