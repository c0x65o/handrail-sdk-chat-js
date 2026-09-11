// Keep explicit selection intact, including database-only URLs whose connection
// settings pg resolves from PG*. Never retry against a lower-priority database.
export function selectChatLabDatabase(options = {}, env = process.env) {
  const candidates = [
    ["options.databaseUrl", options.databaseUrl],
    ["CHAT_LAB_DATABASE_URL", env.CHAT_LAB_DATABASE_URL],
    ["TEST_DATABASE_URL", env.TEST_DATABASE_URL],
    ["DATABASE_URL", env.DATABASE_URL],
  ];
  const selected = candidates.find(([, value]) => value !== undefined && value !== null);
  if (selected === undefined) return { source: "container-default", databaseUrl: undefined };
  const [source, databaseUrl] = selected;
  // The SDK treats blank URLs as permission to start a disposable container.
  // A selected lab override must instead fail visibly.
  if (typeof databaseUrl !== "string" || databaseUrl.trim() === "") {
    throw new TypeError(`Chat Lab database selection ${source} must be a non-empty PostgreSQL URL; no fallback attempted.`);
  }
  try {
    // WHATWG URL also accepts opaque forms (postgres:garbage), which pg can
    // interpret as a different database. PostgreSQL URIs require the // prefix;
    // an empty authority remains valid for database-only URLs using PG*.
    if (!/^postgres(?:ql)?:\/\//iu.test(databaseUrl)) throw new Error();
    const url = new URL(databaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new TypeError(`Chat Lab database selection ${source} must be a valid PostgreSQL URL; no fallback attempted.`);
  }
  return { source, databaseUrl };
}

export async function createChatLabDatabaseHarness(createHarness, selection, options) {
  try {
    return await createHarness({
      ...options,
      ...(selection.databaseUrl === undefined ? {} : { testDatabaseUrl: selection.databaseUrl }),
    });
  } catch (error) {
    // Do not retain the driver message, stack or cause: any can include a URL,
    // database user, password, or query. Only known diagnostic codes are safe.
    const code = ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "28P01", "3D000", "42501"]
      .includes(error?.code) ? error.code : "setup_failed";
    const cleanupFailed = error instanceof AggregateError;
    throw new Error(
      `Chat Lab database initialization failed: selection=${selection.source}, code=${code}. ` +
      (selection.databaseUrl === undefined
        ? "Check the disposable PostgreSQL container dependency. "
        : "Explicit selection retained; no fallback attempted. Check the selected database and its connection settings. ") +
      (cleanupFailed ? "Harness cleanup also failed; inspect owned resources before retrying." : ""),
    );
  }
}
