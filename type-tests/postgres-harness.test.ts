import {
  createPostgresTestBackend,
  createPostgresTestHarness,
  type PostgresTestBackendKind,
} from "../src/testing/index.js";

async function usePostgresHarness(): Promise<void> {
  const standalone = await createPostgresTestHarness({
    schemaPrefix: "handrail_types",
  });
  const standaloneKind: PostgresTestBackendKind = standalone.backendKind;
  await standalone.pool.query("SELECT 1");
  await standalone.teardown();

  const backend = await createPostgresTestBackend({
    testDatabaseUrl: "postgresql://localhost/handrail_test",
  });
  const suite = await backend.createHarness();
  const schema: string = suite.schema;
  const exists: boolean = await backend.schemaExists(schema);
  void [standaloneKind, exists];
  await suite.teardown();
  await backend.teardown();
}

void usePostgresHarness;
