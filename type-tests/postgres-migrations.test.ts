import { Pool } from "pg";

import {
  PostgresMigrationIncompatibilityError,
  chatConversationsMembershipMigration,
  createPostgresMigrationRunner,
  handrailChatPostgresMigrations,
  type AppliedPostgresMigration,
  type PostgresMigration,
  type PostgresMigrationApplyResult,
  type PostgresMigrationStatus,
} from "../src/server/index.js";

const pool = new Pool({ connectionString: "postgresql://localhost/example" });
const migrations = [
  {
    id: "0001-example",
    order: 1,
    statements: ["CREATE TABLE example (id bigint PRIMARY KEY)"],
  },
] as const satisfies readonly PostgresMigration[];

const runner = createPostgresMigrationRunner({ database: pool, migrations });
const configuredRunner = createPostgresMigrationRunner({
  database: pool,
  schema: "custom_chat",
  migrations,
});
const productRunner = createPostgresMigrationRunner({
  database: pool,
  migrations: handrailChatPostgresMigrations,
});
const productMigration: PostgresMigration = chatConversationsMembershipMigration;

async function inspectAndApply(): Promise<void> {
  const status: PostgresMigrationStatus = await runner.status();
  const pendingChecksum: string | undefined = status.pending[0]?.checksum;
  const result: PostgresMigrationApplyResult = await configuredRunner.apply();
  const applied: AppliedPostgresMigration | undefined = result.applied[0];

  try {
    await runner.apply();
  } catch (error) {
    if (error instanceof PostgresMigrationIncompatibilityError) {
      const incompatibleStatus: PostgresMigrationStatus = error.status;
      void incompatibleStatus;
    }
  }

  void [pendingChecksum, applied];
}

const invalidOrder: PostgresMigration = {
  id: "invalid",
  // @ts-expect-error Migration order is numeric and explicit.
  order: "1",
  statements: ["SELECT 1"],
};

const invalidStatements: PostgresMigration = {
  id: "invalid-statements",
  order: 2,
  // @ts-expect-error Migration statements are SQL strings.
  statements: [false],
};

void [
  inspectAndApply,
  productRunner,
  productMigration,
  invalidOrder,
  invalidStatements,
];
