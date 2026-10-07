#!/usr/bin/env bash
set -euo pipefail
umask 077
PG_BINDIR=/usr/lib/postgresql/15/bin
pg_fixture=$(mktemp -d "$PWD/build/ack-pg.XXXXXX")
cleanup() {
  if test -f "$pg_fixture/data/postmaster.pid"; then "$PG_BINDIR/pg_ctl" -D "$pg_fixture/data" -m fast -w stop; fi
}
trap cleanup EXIT
unset DATABASE_URL TEST_DATABASE_URL PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGOPTIONS
"$PG_BINDIR/postgres" --version
"$PG_BINDIR/initdb" -D "$pg_fixture/data" -U handrail_test --auth-local=trust --auth-host=reject --encoding=UTF8 --no-locale > "$pg_fixture/initdb.log"
"$PG_BINDIR/pg_ctl" -D "$pg_fixture/data" -l "$pg_fixture/postgres.log" -o "-c listen_addresses='' -c unix_socket_directories='$pg_fixture' -c unix_socket_permissions=0700 -c max_connections=20 -c shared_buffers=32MB -c log_statement=none -c log_min_error_statement=panic -c log_parameter_max_length_on_error=0" -w start
export TEST_DATABASE_URL="postgresql://handrail_test@/postgres?host=$pg_fixture"
node --test --test-concurrency=1 "$@"
"$PG_BINDIR/psql" "$TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT count(*) AS remaining_test_schemas FROM pg_namespace WHERE nspname NOT IN ('public','information_schema') AND nspname NOT LIKE 'pg_%';"
