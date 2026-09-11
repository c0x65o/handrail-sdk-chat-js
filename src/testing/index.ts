import { randomUUID } from "node:crypto";

import { Pool } from "pg";

/** Types shared by Handrail Chat integration-test helpers. */
export declare namespace HandrailChatTesting {
  type Surface = "database" | "server" | "client";
}

export type PostgresTestBackendKind = "url-backed" | "container-backed";

export interface PostgresTestBackendOptions {
  /** Explicit test URL. Defaults to `process.env.TEST_DATABASE_URL`. */
  readonly testDatabaseUrl?: string;
  /** Docker image used only when no test URL is available. */
  readonly containerImage?: string;
}

export interface PostgresTestHarnessOptions {
  /** Lowercase PostgreSQL identifier prefix, up to 24 characters. */
  readonly schemaPrefix?: string;
}

export interface PostgresTestHarness {
  readonly backendKind: PostgresTestBackendKind;
  readonly connectionString: string;
  readonly schema: string;
  /** A pool whose connections always use this harness's isolated schema. */
  readonly pool: Pool;
  /** Drops only this harness's schema. Safe to call more than once. */
  teardown(): Promise<void>;
}

export interface PostgresTestBackend {
  readonly kind: PostgresTestBackendKind;
  readonly connectionString: string;
  createHarness(options?: PostgresTestHarnessOptions): Promise<PostgresTestHarness>;
  schemaExists(schema: string): Promise<boolean>;
  /** Drops remaining owned schemas and stops an owned container, if any. */
  teardown(): Promise<void>;
}

interface OwnedPostgresContainer {
  stop(): Promise<unknown>;
}

const DEFAULT_CONTAINER_IMAGE = "postgres:16-alpine";
const DEFAULT_SCHEMA_PREFIX = "handrail_test";
const SCHEMA_PREFIX_PATTERN = /^[a-z_][a-z0-9_]{0,23}$/;

const quoteIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const resolveSchemaPrefix = (prefix?: string): string => {
  const resolved = prefix ?? DEFAULT_SCHEMA_PREFIX;

  if (!SCHEMA_PREFIX_PATTERN.test(resolved)) {
    throw new TypeError(
      "schemaPrefix must be a lowercase PostgreSQL identifier of at most 24 characters",
    );
  }

  return resolved;
};

class PostgresTestBackendImplementation implements PostgresTestBackend {
  readonly #adminPool: Pool;
  readonly #container: OwnedPostgresContainer | undefined;
  readonly #ownedSchemas = new Map<string, Pool>();
  #teardownPromise: Promise<void> | undefined;
  #closed = false;

  public constructor(
    public readonly kind: PostgresTestBackendKind,
    public readonly connectionString: string,
    container?: OwnedPostgresContainer,
  ) {
    this.#adminPool = new Pool({ connectionString });
    this.#container = container;
  }

  public async createHarness(
    options: PostgresTestHarnessOptions = {},
  ): Promise<PostgresTestHarness> {
    if (this.#closed || this.#teardownPromise) {
      throw new Error("The PostgreSQL test backend has already been torn down");
    }

    const prefix = resolveSchemaPrefix(options.schemaPrefix);
    const schema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = quoteIdentifier(schema);
    const pool = new Pool({
      connectionString: this.connectionString,
      max: 4,
      options: `-c search_path=${schema},pg_catalog`,
    });

    await this.#adminPool.query(`CREATE SCHEMA ${quotedSchema}`);
    this.#ownedSchemas.set(schema, pool);

    try {
      const configuredSchema = await pool.query<{ current_schema: string | null }>(
        "SELECT current_schema() AS current_schema",
      );

      if (configuredSchema.rows[0]?.current_schema !== schema) {
        throw new Error("PostgreSQL did not apply the isolated schema search path");
      }
    } catch (error) {
      await this.#dropOwnedSchema(schema);
      throw error;
    }

    let teardownPromise: Promise<void> | undefined;
    const teardown = (): Promise<void> => {
      teardownPromise ??= this.#dropOwnedSchema(schema);
      return teardownPromise;
    };

    return {
      backendKind: this.kind,
      connectionString: this.connectionString,
      schema,
      pool,
      teardown,
    };
  }

  public async schemaExists(schema: string): Promise<boolean> {
    if (this.#closed) {
      throw new Error("The PostgreSQL test backend has already been torn down");
    }

    const result = await this.#adminPool.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists",
      [schema],
    );

    return result.rows[0]?.exists ?? false;
  }

  public teardown(): Promise<void> {
    this.#teardownPromise ??= this.#performTeardown();
    return this.#teardownPromise;
  }

  async #dropOwnedSchema(schema: string): Promise<void> {
    const pool = this.#ownedSchemas.get(schema);

    if (!pool) {
      return;
    }

    await pool.end();
    await this.#adminPool.query(
      `DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`,
    );
    this.#ownedSchemas.delete(schema);
  }

  async #performTeardown(): Promise<void> {
    const errors: unknown[] = [];

    for (const schema of [...this.#ownedSchemas.keys()]) {
      try {
        await this.#dropOwnedSchema(schema);
      } catch (error) {
        errors.push(error);
      }
    }

    try {
      await this.#adminPool.end();
    } catch (error) {
      errors.push(error);
    }

    if (this.#container) {
      try {
        await this.#container.stop();
      } catch (error) {
        errors.push(error);
      }
    }

    this.#closed = true;

    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to tear down PostgreSQL test backend");
    }
  }
}

/**
 * Creates a real PostgreSQL backend. A supplied test URL is never reset or
 * stopped; without one, this starts and owns a disposable Docker container.
 */
export async function createPostgresTestBackend(
  options: PostgresTestBackendOptions = {},
): Promise<PostgresTestBackend> {
  const testDatabaseUrl =
    options.testDatabaseUrl ?? process.env.TEST_DATABASE_URL;

  if (testDatabaseUrl?.trim()) {
    return new PostgresTestBackendImplementation(
      "url-backed",
      testDatabaseUrl,
    );
  }

  let container: OwnedPostgresContainer | undefined;

  try {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const startedContainer = await new PostgreSqlContainer(
      options.containerImage ?? DEFAULT_CONTAINER_IMAGE,
    )
      .withDatabase("handrail_test")
      .withUsername("handrail_test")
      .withPassword(randomUUID())
      .start();
    container = startedContainer;

    return new PostgresTestBackendImplementation(
      "container-backed",
      startedContainer.getConnectionUri(),
      startedContainer,
    );
  } catch (cause) {
    const startupError = new Error(
      "Unable to start container-backed PostgreSQL. Set TEST_DATABASE_URL to a test database URL or make Docker available.",
      { cause },
    );
    if (container) {
      try {
        await container.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError],
          "PostgreSQL container startup and cleanup both failed",
        );
      }
    }
    throw startupError;
  }
}

/** Creates one isolated schema and owns all backend cleanup for the caller. */
export async function createPostgresTestHarness(
  options: PostgresTestBackendOptions & PostgresTestHarnessOptions = {},
): Promise<PostgresTestHarness> {
  const backend = await createPostgresTestBackend(options);

  try {
    const harness = await backend.createHarness(options);
    let teardownPromise: Promise<void> | undefined;

    return {
      ...harness,
      teardown() {
        teardownPromise ??= (async () => {
          try {
            await harness.teardown();
          } finally {
            await backend.teardown();
          }
        })();
        return teardownPromise;
      },
    };
  } catch (error) {
    await backend.teardown();
    throw error;
  }
}

import {
  createChatTestHarnessInternal,
  type ChatTestHarness,
  type CreateChatTestHarnessOptions,
} from "./create-chat-test-harness.js";

export type {
  ChatTestActor,
  ChatTestActorInput,
  ChatTestAdapterBoundary,
  ChatTestAdapterCall,
  ChatTestCallLog,
  ChatTestClock,
  ChatTestFailureQueue,
  ChatTestHarness,
  ChatTestWebSocketConnection,
  CreateChatTestHarnessOptions,
} from "./create-chat-test-harness.js";

/** Creates a migrated, loopback-bound full-stack Handrail Chat test fixture. */
export function createChatTestHarness(
  options: CreateChatTestHarnessOptions = {},
): Promise<ChatTestHarness> {
  return createChatTestHarnessInternal(options, createPostgresTestBackend);
}
