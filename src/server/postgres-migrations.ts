import { createHash } from "node:crypto";

import type { Pool, PoolClient } from "pg";

export const DEFAULT_POSTGRES_SCHEMA = "handrail_chat";
const METADATA_TABLE = "_handrail_migrations";
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIGRATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The subset of a pg-compatible checked-out connection used by the runner. */
export type PostgresMigrationConnection = Pick<PoolClient, "query" | "release">;

/** A pg Pool, or an equivalent executor that can reserve one connection. */
export interface PostgresMigrationDatabase {
  readonly query: Pool["query"];
  connect(): Promise<PostgresMigrationConnection>;
}

/** One immutable, explicitly ordered PostgreSQL schema migration. */
export interface PostgresMigration {
  readonly id: string;
  readonly order: number;
  /** SQL is checksummed byte-for-byte and run in order inside one transaction. */
  readonly statements: readonly string[];
}

/** Public migration metadata with executable SQL intentionally omitted. */
export interface PostgresMigrationDescriptor {
  readonly id: string;
  readonly order: number;
  readonly checksum: string;
}

export interface AppliedPostgresMigration extends PostgresMigrationDescriptor {
  readonly appliedAt: Date;
}

export type PostgresMigrationIncompatibility =
  | {
      readonly reason: "checksum_mismatch";
      readonly id: string;
      readonly storedChecksum: string;
      readonly currentChecksum: string;
      readonly storedOrder: number;
      readonly currentOrder: number;
      readonly appliedAt: Date;
    }
  | {
      readonly reason: "order_mismatch";
      readonly id: string;
      readonly storedChecksum: string;
      readonly currentChecksum: string;
      readonly storedOrder: number;
      readonly currentOrder: number;
      readonly appliedAt: Date;
    }
  | {
      readonly reason: "unknown_applied";
      readonly id: string;
      readonly storedChecksum: string;
      readonly storedOrder: number;
      readonly appliedAt: Date;
    }
  | {
      readonly reason: "out_of_order";
      readonly id: string;
      readonly currentChecksum: string;
      readonly currentOrder: number;
    };

export interface PostgresMigrationStatus {
  readonly applied: readonly AppliedPostgresMigration[];
  readonly pending: readonly PostgresMigrationDescriptor[];
  readonly incompatible: readonly PostgresMigrationIncompatibility[];
}

export interface PostgresMigrationApplyResult {
  /** Migrations executed by this apply call. */
  readonly applied: readonly AppliedPostgresMigration[];
  readonly status: PostgresMigrationStatus;
}

export interface PostgresMigrationRunner {
  readonly schema: string;
  readonly migrations: readonly PostgresMigrationDescriptor[];
  /** Inspects catalog and metadata state without creating any database object. */
  status(): Promise<PostgresMigrationStatus>;
  /** Explicitly creates migration metadata and applies compatible pending work. */
  apply(): Promise<PostgresMigrationApplyResult>;
}

export interface CreatePostgresMigrationRunnerOptions {
  readonly database: PostgresMigrationDatabase;
  readonly schema?: string;
  readonly migrations: readonly PostgresMigration[];
}

/** Raised before pending SQL runs when applied migration history is incompatible. */
export class PostgresMigrationIncompatibilityError extends Error {
  public readonly status: PostgresMigrationStatus;

  public constructor(status: PostgresMigrationStatus) {
    super("Applied PostgreSQL migrations are incompatible with the current migration set");
    this.name = "PostgresMigrationIncompatibilityError";
    this.status = status;
  }
}

interface PreparedMigration extends PostgresMigrationDescriptor {
  readonly statements: readonly string[];
}

interface StoredMigrationRow {
  readonly id: string;
  readonly migration_order: string | number;
  readonly checksum: string;
  readonly applied_at: Date | string;
}

/** Validates a PostgreSQL schema name before it is interpolated into SQL. */
export const validatePostgresSchema = (schema: string): string => {
  if (!IDENTIFIER_PATTERN.test(schema) || Buffer.byteLength(schema, "utf8") > 63) {
    throw new TypeError(
      "schema must be a PostgreSQL identifier of at most 63 ASCII characters",
    );
  }

  return schema;
};

const quoteIdentifier = (identifier: string): string => {
  // All callers validate before interpolation. Quoting remains defense in depth.
  return `"${identifier.replaceAll('"', '""')}"`;
};

const checksumStatements = (statements: readonly string[]): string => {
  const canonicalContent = JSON.stringify({ format: 1, statements });
  return `sha256:${createHash("sha256").update(canonicalContent).digest("hex")}`;
};

const prepareMigrations = (
  migrations: readonly PostgresMigration[],
): readonly PreparedMigration[] => {
  const ids = new Set<string>();
  const orders = new Set<number>();
  const prepared = migrations.map((migration): PreparedMigration => {
    if (
      !MIGRATION_ID_PATTERN.test(migration.id) ||
      Buffer.byteLength(migration.id, "utf8") > 128
    ) {
      throw new TypeError(
        "migration ids must be 1-128 ASCII letters, numbers, dots, underscores, or hyphens",
      );
    }
    if (ids.has(migration.id)) {
      throw new TypeError(`duplicate migration id: ${migration.id}`);
    }
    if (!Number.isSafeInteger(migration.order) || migration.order < 1) {
      throw new TypeError(`migration ${migration.id} order must be a positive safe integer`);
    }
    if (orders.has(migration.order)) {
      throw new TypeError(`ambiguous migration order: ${migration.order}`);
    }
    if (migration.statements.length === 0) {
      throw new TypeError(`migration ${migration.id} must contain at least one SQL statement`);
    }

    const statements = migration.statements.map((statement) => {
      if (typeof statement !== "string" || statement.trim().length === 0) {
        throw new TypeError(`migration ${migration.id} contains an empty SQL statement`);
      }
      return statement;
    });

    ids.add(migration.id);
    orders.add(migration.order);

    return Object.freeze({
      id: migration.id,
      order: migration.order,
      checksum: checksumStatements(statements),
      statements: Object.freeze(statements),
    });
  });

  prepared.sort((left, right) => left.order - right.order);
  return Object.freeze(prepared);
};

const toDescriptor = (
  migration: PreparedMigration,
): PostgresMigrationDescriptor =>
  Object.freeze({
    id: migration.id,
    order: migration.order,
    checksum: migration.checksum,
  });

const parseStoredMigration = (row: StoredMigrationRow): AppliedPostgresMigration => {
  const order =
    typeof row.migration_order === "number"
      ? row.migration_order
      : Number(row.migration_order);
  const appliedAt =
    row.applied_at instanceof Date ? row.applied_at : new Date(row.applied_at);

  if (!Number.isSafeInteger(order) || order < 1 || Number.isNaN(appliedAt.valueOf())) {
    throw new Error(`Invalid stored migration metadata for ${row.id}`);
  }

  return Object.freeze({
    id: row.id,
    order,
    checksum: row.checksum,
    appliedAt,
  });
};

const freezeStatus = (
  applied: AppliedPostgresMigration[],
  pending: PostgresMigrationDescriptor[],
  incompatible: PostgresMigrationIncompatibility[],
): PostgresMigrationStatus =>
  Object.freeze({
    applied: Object.freeze(applied),
    pending: Object.freeze(pending),
    incompatible: Object.freeze(incompatible),
  });

/** Creates a side-effect-free runner. Migrations run only after `apply()` is called. */
export function createPostgresMigrationRunner(
  options: CreatePostgresMigrationRunnerOptions,
): PostgresMigrationRunner {
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const quotedSchema = quoteIdentifier(schema);
  const quotedMetadataTable = quoteIdentifier(METADATA_TABLE);
  const qualifiedMetadataTable = `${quotedSchema}.${quotedMetadataTable}`;
  const prepared = prepareMigrations(options.migrations);
  const descriptors = Object.freeze(prepared.map(toDescriptor));
  const migrationById = new Map(prepared.map((migration) => [migration.id, migration]));

  const readStatus = async (
    executor: Pick<PostgresMigrationConnection, "query">,
    metadataTableKnownToExist = false,
  ): Promise<PostgresMigrationStatus> => {
    let metadataTableExists = metadataTableKnownToExist;

    if (!metadataTableExists) {
      const catalogResult = (await executor.query(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_class AS relation
           INNER JOIN pg_catalog.pg_namespace AS namespace
             ON namespace.oid = relation.relnamespace
           WHERE namespace.nspname = $1
             AND relation.relname = $2
             AND relation.relkind IN ('r', 'p')
         ) AS exists`,
        [schema, METADATA_TABLE],
      )) as { rows: Array<{ exists: boolean }> };
      metadataTableExists = catalogResult.rows[0]?.exists ?? false;
    }

    if (!metadataTableExists) {
      return freezeStatus([], descriptors.slice(), []);
    }

    const storedResult = (await executor.query(
      `SELECT id, migration_order, checksum, applied_at
       FROM ${qualifiedMetadataTable}
       ORDER BY migration_order, id`,
    )) as { rows: StoredMigrationRow[] };
    const stored = storedResult.rows.map(parseStoredMigration);
    const storedById = new Map(stored.map((migration) => [migration.id, migration]));
    const applied: AppliedPostgresMigration[] = [];
    const pending: PostgresMigrationDescriptor[] = [];
    const incompatible: PostgresMigrationIncompatibility[] = [];

    for (const storedMigration of stored) {
      const current = migrationById.get(storedMigration.id);

      if (!current) {
        incompatible.push(
          Object.freeze({
            reason: "unknown_applied",
            id: storedMigration.id,
            storedChecksum: storedMigration.checksum,
            storedOrder: storedMigration.order,
            appliedAt: storedMigration.appliedAt,
          }),
        );
      } else if (current.checksum !== storedMigration.checksum) {
        incompatible.push(
          Object.freeze({
            reason: "checksum_mismatch",
            id: current.id,
            storedChecksum: storedMigration.checksum,
            currentChecksum: current.checksum,
            storedOrder: storedMigration.order,
            currentOrder: current.order,
            appliedAt: storedMigration.appliedAt,
          }),
        );
      } else if (current.order !== storedMigration.order) {
        incompatible.push(
          Object.freeze({
            reason: "order_mismatch",
            id: current.id,
            storedChecksum: storedMigration.checksum,
            currentChecksum: current.checksum,
            storedOrder: storedMigration.order,
            currentOrder: current.order,
            appliedAt: storedMigration.appliedAt,
          }),
        );
      } else {
        applied.push(storedMigration);
      }
    }

    for (const migration of prepared) {
      if (!storedById.has(migration.id)) {
        pending.push(toDescriptor(migration));
      }
    }

    const firstPendingOrder = pending[0]?.order;
    if (
      firstPendingOrder !== undefined &&
      stored.some((migration) => migration.order > firstPendingOrder)
    ) {
      const firstPending = pending[0];
      if (firstPending) {
        incompatible.push(
          Object.freeze({
            reason: "out_of_order",
            id: firstPending.id,
            currentChecksum: firstPending.checksum,
            currentOrder: firstPending.order,
          }),
        );
      }
    }

    return freezeStatus(applied, pending, incompatible);
  };

  const applyOne = async (
    connection: PostgresMigrationConnection,
    migration: PreparedMigration,
  ): Promise<AppliedPostgresMigration> => {
    await connection.query("BEGIN");

    try {
      await connection.query(
        `SET LOCAL search_path TO ${quotedSchema}, pg_catalog`,
      );
      for (const statement of migration.statements) {
        await connection.query(statement);
      }
      const insertResult = (await connection.query(
        `INSERT INTO ${qualifiedMetadataTable}
           (id, migration_order, checksum)
         VALUES ($1, $2, $3)
         RETURNING id, migration_order, checksum, applied_at`,
        [migration.id, migration.order, migration.checksum],
      )) as { rows: StoredMigrationRow[] };
      const inserted = insertResult.rows[0];
      if (!inserted) {
        throw new Error(`PostgreSQL did not return metadata for migration ${migration.id}`);
      }
      const appliedMigration = parseStoredMigration(inserted);
      await connection.query("COMMIT");
      return appliedMigration;
    } catch (error) {
      try {
        await connection.query("ROLLBACK");
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Migration ${migration.id} failed and its transaction could not be rolled back`,
        );
      }
      throw error;
    }
  };

  return Object.freeze({
    schema,
    migrations: descriptors,
    status: () => readStatus(options.database),
    async apply(): Promise<PostgresMigrationApplyResult> {
      const connection = await options.database.connect();
      const lockKey = `@handrail/chat:migrations:v1:${schema}`;
      let lockAcquired = false;
      let result: PostgresMigrationApplyResult | undefined;
      let operationError: unknown;
      const cleanupErrors: unknown[] = [];

      try {
        await connection.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
          lockKey,
        ]);
        lockAcquired = true;
        await connection.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
        await connection.query(
          `CREATE TABLE IF NOT EXISTS ${qualifiedMetadataTable} (
             id text PRIMARY KEY,
             migration_order bigint NOT NULL UNIQUE,
             checksum text NOT NULL,
             applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
           )`,
        );

        const before = await readStatus(connection, true);
        if (before.incompatible.length > 0) {
          throw new PostgresMigrationIncompatibilityError(before);
        }

        const newlyApplied: AppliedPostgresMigration[] = [];
        for (const pending of before.pending) {
          const migration = migrationById.get(pending.id);
          if (!migration) {
            throw new Error(`Pending migration ${pending.id} is not defined`);
          }
          newlyApplied.push(await applyOne(connection, migration));
        }

        result = Object.freeze({
          applied: Object.freeze(newlyApplied),
          status: await readStatus(connection, true),
        });
      } catch (error) {
        operationError = error;
      } finally {
        if (lockAcquired) {
          try {
            await connection.query(
              "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
              [lockKey],
            );
          } catch (error) {
            cleanupErrors.push(error);
          }
        }

        try {
          connection.release();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }

      if (operationError !== undefined) {
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [operationError, ...cleanupErrors],
            "PostgreSQL migration apply and cleanup both failed",
          );
        }
        throw operationError;
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(cleanupErrors, "PostgreSQL migration cleanup failed");
      }
      if (!result) {
        throw new Error("PostgreSQL migration apply completed without a result");
      }

      return result;
    },
  });
}
