#!/usr/bin/env node

import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

import {
  DOCTOR_EXIT_CODES,
  formatDoctorResult,
  inspectDoctorConfiguration,
} from "./doctor.js";
import { handrailChatPostgresMigrations } from "./server/postgres-schema-migrations.js";
import {
  PostgresMigrationIncompatibilityError,
  createPostgresMigrationRunner,
  type PostgresMigrationStatus,
} from "./server/postgres-migrations.js";
import { runServe } from "./serve.js";

const EXIT_SUCCESS = 0;
const EXIT_OPERATIONAL_ERROR = 1;
const EXIT_USAGE_ERROR = 2;
const EXIT_INCOMPATIBLE = 3;
const DEFAULT_SCHEMA = "handrail_chat";
const DEFAULT_SERVE_HOST = "127.0.0.1";
const DEFAULT_SERVE_PORT = 3000;
const CONNECTION_TIMEOUT_MILLISECONDS = 5_000;

interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

interface MigrateOptions {
  readonly connectionString: string;
  readonly schema: string;
}

interface DoctorOptions {
  readonly configPath: string;
  readonly json: boolean;
}

interface ServeOptions {
  readonly configPath: string;
  readonly host: string;
  readonly port: number;
}

type ParsedCommand =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | ({ readonly kind: "doctor" } & DoctorOptions)
  | ({ readonly kind: "serve" } & ServeOptions)
  | ({ readonly kind: "status" | "apply" } & MigrateOptions);

class CliUsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const packageMetadata = createRequire(import.meta.url)(
  "../package.json",
) as PackageMetadata;
const migrationVersion =
  handrailChatPostgresMigrations.at(-1)?.id ?? "none";

const usage = `Usage:
  handrail-chat --help
  handrail-chat --version
  handrail-chat doctor --config <module.mjs> [--json]
  handrail-chat serve --config <module.mjs> [--host <host>] [--port <port>]
  handrail-chat migrate status [--connection-string <url>] [--schema <name>]
  handrail-chat migrate apply  [--connection-string <url>] [--schema <name>]

Connection defaults to HANDRAIL_CHAT_DATABASE_URL.
Schema defaults to HANDRAIL_CHAT_SCHEMA, then ${DEFAULT_SCHEMA}.

Commands:
  doctor          Validate config and inspect database state without side effects.
  serve           Start a local HTTP/WebSocket host after read-only migration checks.
  migrate status  Inspect migration state without creating database objects.
  migrate apply   Explicitly apply compatible pending migrations.

Exit codes:
  0  Command completed successfully.
  1  Database, startup, cleanup, or migration operation failed.
  2  Command-line input is invalid.
  3  Package, protocol, schema, or migration history is incompatible.
  4  Doctor/serve found actionable configuration or pending-migration work.

Serve defaults to ${DEFAULT_SERVE_HOST}:${DEFAULT_SERVE_PORT}. A non-loopback
host is used only when explicitly supplied with --host. Port 0 selects an
ephemeral port. SIGINT and SIGTERM perform a clean shutdown and exit 0.`;

const parseConnectionString = (value: string | undefined): string => {
  if (!value?.trim()) {
    throw new CliUsageError(
      "a database connection is required; use --connection-string or HANDRAIL_CHAT_DATABASE_URL",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CliUsageError("the database connection string must be a valid PostgreSQL URL");
  }

  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.hostname.length === 0
  ) {
    throw new CliUsageError("the database connection string must be a valid PostgreSQL URL");
  }

  return value;
};

const readOptionValue = (
  args: readonly string[],
  index: number,
  option: string,
): string => {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliUsageError(`${option} requires a value`);
  }
  return value;
};

const parseMigrateOptions = (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): MigrateOptions => {
  let connectionString = environment.HANDRAIL_CHAT_DATABASE_URL;
  let schema = environment.HANDRAIL_CHAT_SCHEMA ?? DEFAULT_SCHEMA;
  let sawConnectionString = false;
  let sawSchema = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--connection-string") {
      if (sawConnectionString) {
        throw new CliUsageError("--connection-string may be provided only once");
      }
      connectionString = readOptionValue(args, index, option);
      sawConnectionString = true;
      index += 1;
    } else if (option === "--schema") {
      if (sawSchema) {
        throw new CliUsageError("--schema may be provided only once");
      }
      schema = readOptionValue(args, index, option);
      sawSchema = true;
      index += 1;
    } else {
      throw new CliUsageError(`unknown option: ${option ?? ""}`);
    }
  }

  return {
    connectionString: parseConnectionString(connectionString),
    schema,
  };
};

const parseDoctorOptions = (args: readonly string[]): DoctorOptions => {
  let configPath: string | undefined;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--config") {
      if (configPath !== undefined) {
        throw new CliUsageError("--config may be provided only once");
      }
      configPath = readOptionValue(args, index, option);
      index += 1;
    } else if (option === "--json") {
      if (json) {
        throw new CliUsageError("--json may be provided only once");
      }
      json = true;
    } else {
      throw new CliUsageError(`unknown option: ${option ?? ""}`);
    }
  }

  if (configPath === undefined) {
    throw new CliUsageError("doctor requires --config <module.mjs>");
  }
  return { configPath, json };
};

const parseServeOptions = (args: readonly string[]): ServeOptions => {
  let configPath: string | undefined;
  let host = DEFAULT_SERVE_HOST;
  let port = DEFAULT_SERVE_PORT;
  let sawHost = false;
  let sawPort = false;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--config") {
      if (configPath !== undefined) {
        throw new CliUsageError("--config may be provided only once");
      }
      configPath = readOptionValue(args, index, option);
      index += 1;
    } else if (option === "--host") {
      if (sawHost) {
        throw new CliUsageError("--host may be provided only once");
      }
      host = readOptionValue(args, index, option).trim();
      if (host.length === 0) {
        throw new CliUsageError("--host requires a non-empty value");
      }
      sawHost = true;
      index += 1;
    } else if (option === "--port") {
      if (sawPort) {
        throw new CliUsageError("--port may be provided only once");
      }
      const value = readOptionValue(args, index, option);
      if (!/^\d+$/u.test(value)) {
        throw new CliUsageError("--port must be an integer from 0 through 65535");
      }
      port = Number(value);
      if (!Number.isSafeInteger(port) || port > 65_535) {
        throw new CliUsageError("--port must be an integer from 0 through 65535");
      }
      sawPort = true;
      index += 1;
    } else {
      throw new CliUsageError(`unknown option: ${option ?? ""}`);
    }
  }

  if (configPath === undefined) {
    throw new CliUsageError("serve requires --config <module.mjs>");
  }
  return { configPath, host, port };
};

const parseArguments = (
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): ParsedCommand => {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    return { kind: "help" };
  }
  if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
    return { kind: "version" };
  }
  if (args[0] === "doctor") {
    if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
      return { kind: "help" };
    }
    return { kind: "doctor", ...parseDoctorOptions(args.slice(1)) };
  }
  if (args[0] === "serve") {
    if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
      return { kind: "help" };
    }
    return { kind: "serve", ...parseServeOptions(args.slice(1)) };
  }
  if (args[0] !== "migrate") {
    throw new CliUsageError(
      args.length === 0 ? "a command is required" : `unknown command: ${args[0]}`,
    );
  }
  if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
    return { kind: "help" };
  }
  if (args[1] !== "status" && args[1] !== "apply") {
    throw new CliUsageError(
      args[1] === undefined
        ? "a migrate subcommand is required"
        : `unknown migrate subcommand: ${args[1]}`,
    );
  }

  return {
    kind: args[1],
    ...parseMigrateOptions(args.slice(2), environment),
  };
};

const formatVersion = (): string =>
  `${packageMetadata.name} ${packageMetadata.version} migrations ${migrationVersion}`;

const formatStatus = (status: PostgresMigrationStatus): readonly string[] => {
  const lines = [
    `status applied=${status.applied.length} pending=${status.pending.length} incompatible=${status.incompatible.length}`,
  ];
  if (status.pending.length > 0) {
    lines.push(`pending ${status.pending.map(({ id }) => id).join(",")}`);
  }
  if (status.incompatible.length > 0) {
    lines.push(
      `incompatible ${status.incompatible
        .map(({ id, reason }) => `${id}:${reason}`)
        .join(",")}`,
    );
  }
  return lines;
};

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const createRedactor = (connectionString: string | undefined) => {
  const secrets = new Set<string>();
  if (connectionString) {
    secrets.add(connectionString);
    try {
      const parsed = new URL(connectionString);
      for (const credential of [
        parsed.username,
        parsed.password,
        safeDecodeURIComponent(parsed.username),
        safeDecodeURIComponent(parsed.password),
        parsed.searchParams.get("password") ?? "",
      ]) {
        if (credential.length > 0) {
          secrets.add(credential);
        }
      }
    } catch {
      // Invalid connection input is still replaced as an opaque value below.
    }
  }

  const orderedSecrets = [...secrets].sort((left, right) => right.length - left.length);
  return (message: string): string => {
    let redacted = message.replace(
      /postgres(?:ql)?:\/\/[^\s"'<>]+/giu,
      "[REDACTED_DATABASE_URL]",
    );
    for (const secret of orderedSecrets) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted;
  };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function runCli(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: ParsedCommand;
  let candidateConnectionString = environment.HANDRAIL_CHAT_DATABASE_URL;

  const connectionOptionIndex = args.indexOf("--connection-string");
  if (connectionOptionIndex >= 0) {
    candidateConnectionString = args[connectionOptionIndex + 1];
  }
  const redact = createRedactor(candidateConnectionString);

  try {
    parsed = parseArguments(args, environment);
  } catch (error) {
    process.stderr.write(`handrail-chat: ${redact(errorMessage(error))}\n\n${usage}\n`);
    return EXIT_USAGE_ERROR;
  }

  if (parsed.kind === "help") {
    process.stdout.write(`${usage}\n`);
    return EXIT_SUCCESS;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${formatVersion()}\n`);
    return EXIT_SUCCESS;
  }
  if (parsed.kind === "doctor") {
    const result = await inspectDoctorConfiguration(parsed.configPath);
    process.stdout.write(
      parsed.json ? `${JSON.stringify(result, null, 2)}\n` : formatDoctorResult(result),
    );
    return result.exitCode;
  }
  if (parsed.kind === "serve") {
    return runServe(parsed);
  }

  const pool = new Pool({
    connectionString: parsed.connectionString,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MILLISECONDS,
    max: 1,
  });
  let exitCode = EXIT_OPERATIONAL_ERROR;
  let runnerCreated = false;

  try {
    const runner = createPostgresMigrationRunner({
      database: pool,
      schema: parsed.schema,
      migrations: handrailChatPostgresMigrations,
    });
    runnerCreated = true;
    process.stdout.write(`${formatVersion()} schema ${runner.schema}\n`);

    if (parsed.kind === "status") {
      const status = await runner.status();
      process.stdout.write(`${formatStatus(status).join("\n")}\n`);
      exitCode = status.incompatible.length > 0
        ? EXIT_INCOMPATIBLE
        : EXIT_SUCCESS;
    } else {
      const result = await runner.apply();
      process.stdout.write(
        `applied ${result.applied.length}${
          result.applied.length > 0
            ? ` ${result.applied.map(({ id }) => id).join(",")}`
            : ""
        }\n${formatStatus(result.status).join("\n")}\n`,
      );
      exitCode = EXIT_SUCCESS;
    }
  } catch (error) {
    if (error instanceof PostgresMigrationIncompatibilityError) {
      process.stderr.write(
        `handrail-chat: incompatible migration history\n${formatStatus(error.status).join("\n")}\n`,
      );
      exitCode = EXIT_INCOMPATIBLE;
    } else {
      process.stderr.write(`handrail-chat: ${redact(errorMessage(error))}\n`);
      exitCode =
        !runnerCreated && error instanceof TypeError
          ? EXIT_USAGE_ERROR
          : EXIT_OPERATIONAL_ERROR;
    }
  } finally {
    try {
      await pool.end();
    } catch (error) {
      process.stderr.write(
        `handrail-chat: failed to close database pool: ${redact(errorMessage(error))}\n`,
      );
      if (exitCode === EXIT_SUCCESS) {
        exitCode = EXIT_OPERATIONAL_ERROR;
      }
    }
  }

  return exitCode;
}

const isDirectExecution = (): boolean => {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isDirectExecution()) {
  process.exitCode = await runCli(process.argv.slice(2));
}

export { DOCTOR_EXIT_CODES };
