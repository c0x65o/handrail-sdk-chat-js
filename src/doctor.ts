import { createRequire } from "node:module";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { CHAT_PROTOCOL_VERSION } from "./contracts/realtime.js";
import {
  ChatServerConfigurationError,
  createChatServer,
  type CreateChatServerConfig,
} from "./server/create-chat-server.js";
import { createPostgresMigrationRunner } from "./server/postgres-migrations.js";
import { handrailChatPostgresMigrations } from "./server/postgres-schema-migrations.js";

const packageMetadata = createRequire(import.meta.url)("../package.json") as {
  readonly name: string;
  readonly version: string;
};

export const DOCTOR_RESULT_SCHEMA_VERSION = 1 as const;

export const DOCTOR_EXIT_CODES = Object.freeze({
  healthy: 0,
  operationalError: 1,
  usageError: 2,
  incompatible: 3,
  actionable: 4,
} as const);

export type DoctorCheckStatus = "pass" | "warn" | "fail";
export type DoctorCheckSeverity = "info" | "warning" | "error";
export type DoctorStatus =
  | "healthy"
  | "actionable"
  | "incompatible"
  | "operational_error";

export interface DoctorCheck {
  readonly id: string;
  readonly status: DoctorCheckStatus;
  readonly severity: DoctorCheckSeverity;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface DoctorResult {
  readonly schemaVersion: typeof DOCTOR_RESULT_SCHEMA_VERSION;
  readonly command: "doctor";
  readonly status: DoctorStatus;
  readonly exitCode: number;
  readonly package: Readonly<{
    name: string;
    version: string;
    protocolVersion: number;
    schemaVersion: number;
  }>;
  readonly config: Readonly<{ module: string }>;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorCompatibility {
  /** Exact package version expected by the host integration. */
  readonly packageVersion?: string;
  /** Realtime protocol version expected by the host integration. */
  readonly protocolVersion?: number;
  /** Latest migration order expected by the host integration. */
  readonly schemaVersion?: number;
}

export interface DoctorConfiguration {
  readonly server: CreateChatServerConfig;
  readonly compatibility?: DoctorCompatibility;
}

export type DoctorModuleValue =
  | CreateChatServerConfig
  | DoctorConfiguration
  | (() =>
      | CreateChatServerConfig
      | DoctorConfiguration
      | Promise<CreateChatServerConfig | DoctorConfiguration>);

const FEATURE_ADAPTERS = Object.freeze({
  attachments: "storage",
  notifications: "notifications",
  audit: "audit",
  realtime: "realtime",
  media: "media",
} as const);

type FeatureName = keyof typeof FEATURE_ADAPTERS;

const SECRET_KEY_PATTERN =
  /(?:authorization|credential|databaseurl|password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)/iu;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const safeDecodeURIComponent = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const collectConfigurationSecrets = (value: unknown): readonly string[] => {
  const secrets = new Set<string>();
  const seen = new Set<object>();

  const visit = (candidate: unknown, key = ""): void => {
    if (typeof candidate === "string") {
      if (SECRET_KEY_PATTERN.test(key) && candidate.length > 0) {
        secrets.add(candidate);
      }
      try {
        const url = new URL(candidate);
        if (url.protocol === "postgres:" || url.protocol === "postgresql:") {
          secrets.add(candidate);
          for (const credential of [
            url.username,
            url.password,
            safeDecodeURIComponent(url.username),
            safeDecodeURIComponent(url.password),
          ]) {
            if (credential.length > 0) {
              secrets.add(credential);
            }
          }
          for (const [parameter, parameterValue] of url.searchParams) {
            if (SECRET_KEY_PATTERN.test(parameter) && parameterValue.length > 0) {
              secrets.add(parameterValue);
            }
          }
        }
      } catch {
        // Most configuration strings are not URLs.
      }
      return;
    }

    if ((typeof candidate !== "object" || candidate === null) || seen.has(candidate)) {
      return;
    }
    seen.add(candidate);

    for (const [property, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(candidate),
    )) {
      if ("value" in descriptor) {
        visit(descriptor.value, property);
      }
    }
  };

  visit(value);
  return [...secrets].sort((left, right) => right.length - left.length);
};

export const createConfigurationRedactor = (
  knownSecrets: readonly string[] = [],
) => {
  return (input: string): string => {
    let output = input
      .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/giu, "[REDACTED_DATABASE_URL]")
      .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [REDACTED]")
      .replace(
        /\b(authorization|credential|password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|client[_-]?secret)(\s*[:=]\s*)([^\s,;\]}]+)/giu,
        "$1$2[REDACTED]",
      );

    for (const secret of knownSecrets) {
      output = output.split(secret).join("[REDACTED]");
    }
    return output;
  };
};

const normalizeCompatibility = (value: unknown): DoctorCompatibility => {
  if (value === undefined) {
    return Object.freeze({});
  }
  if (!isRecord(value)) {
    throw new ChatServerConfigurationError("doctor compatibility must be an object");
  }

  const supported = new Set(["packageVersion", "protocolVersion", "schemaVersion"]);
  for (const key of Object.keys(value)) {
    if (!supported.has(key)) {
      throw new ChatServerConfigurationError(
        `doctor compatibility.${key} is not supported`,
      );
    }
  }

  const packageVersion = value.packageVersion;
  if (
    packageVersion !== undefined &&
    (typeof packageVersion !== "string" || packageVersion.trim().length === 0)
  ) {
    throw new ChatServerConfigurationError(
      "doctor compatibility.packageVersion must be a non-empty string",
    );
  }

  const readVersion = (
    candidate: unknown,
    field: "protocolVersion" | "schemaVersion",
    minimum: number,
  ): number | undefined => {
    if (candidate === undefined) {
      return undefined;
    }
    if (!Number.isSafeInteger(candidate) || (candidate as number) < minimum) {
      throw new ChatServerConfigurationError(
        `doctor compatibility.${field} must be a safe integer of at least ${minimum}`,
      );
    }
    return candidate as number;
  };

  const normalized: {
    packageVersion?: string;
    protocolVersion?: number;
    schemaVersion?: number;
  } = {};
  if (typeof packageVersion === "string") {
    normalized.packageVersion = packageVersion;
  }
  const protocolVersion = readVersion(
    value.protocolVersion,
    "protocolVersion",
    1,
  );
  if (protocolVersion !== undefined) {
    normalized.protocolVersion = protocolVersion;
  }
  const schemaVersion = readVersion(value.schemaVersion, "schemaVersion", 0);
  if (schemaVersion !== undefined) {
    normalized.schemaVersion = schemaVersion;
  }
  return Object.freeze(normalized);
};

export const normalizeConfigurationModuleValue = (
  value: unknown,
): { server: CreateChatServerConfig; compatibility: DoctorCompatibility } => {
  if (!isRecord(value)) {
    throw new ChatServerConfigurationError(
      "doctor module default export must resolve to a configuration object",
    );
  }

  if (Object.hasOwn(value, "server")) {
    if (!isRecord(value.server)) {
      throw new ChatServerConfigurationError("doctor server must be an object");
    }
    return {
      server: value.server as unknown as CreateChatServerConfig,
      compatibility: normalizeCompatibility(value.compatibility),
    };
  }

  return {
    server: value as unknown as CreateChatServerConfig,
    compatibility: Object.freeze({}),
  };
};

const packageSchemaVersion = handrailChatPostgresMigrations.reduce(
  (highest, migration) => Math.max(highest, migration.order),
  0,
);

const baseResult = (configPath: string) => ({
  schemaVersion: DOCTOR_RESULT_SCHEMA_VERSION,
  command: "doctor" as const,
  package: Object.freeze({
    name: packageMetadata.name,
    version: packageMetadata.version,
    protocolVersion: CHAT_PROTOCOL_VERSION,
    schemaVersion: packageSchemaVersion,
  }),
  config: Object.freeze({ module: basename(configPath) }),
});

const finishResult = (
  configPath: string,
  status: DoctorStatus,
  checks: DoctorCheck[],
): DoctorResult => {
  const exitCode =
    status === "healthy"
      ? DOCTOR_EXIT_CODES.healthy
      : status === "actionable"
        ? DOCTOR_EXIT_CODES.actionable
        : status === "incompatible"
          ? DOCTOR_EXIT_CODES.incompatible
          : DOCTOR_EXIT_CODES.operationalError;
  return Object.freeze({
    ...baseResult(configPath),
    status,
    exitCode,
    checks: Object.freeze(checks.map((check) => Object.freeze(check))),
  });
};

const compatibilityCheck = (
  id: string,
  label: string,
  configured: string | number | undefined,
  actual: string | number,
): DoctorCheck => {
  if (configured === undefined || configured === actual) {
    return {
      id,
      status: "pass",
      severity: "info",
      message:
        configured === undefined
          ? `${label} is ${actual}`
          : `${label} matches configured value ${actual}`,
      details: Object.freeze({ actual, configured: configured ?? null }),
    };
  }
  return {
    id,
    status: "fail",
    severity: "error",
    message: `${label} ${actual} is incompatible with configured value ${configured}`,
    details: Object.freeze({ actual, configured }),
  };
};

export const loadConfigurationModuleValue = async (
  configPath: string,
): Promise<unknown> => {
  // Configuration modules are data providers. Discard their incidental console
  // output so an import/factory cannot bypass the doctor's redacted reporters.
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    const loaded = (await import(pathToFileURL(configPath).href)) as {
      readonly default?: DoctorModuleValue;
    };
    if (!("default" in loaded)) {
      throw new ChatServerConfigurationError(
        "doctor module must provide a default export",
      );
    }
    return typeof loaded.default === "function"
      ? await loaded.default()
      : loaded.default;
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
};

/**
 * Runs the doctor inspection. It never calls router/listener/provider methods and
 * uses only the migration runner's catalog/status queries.
 */
export async function inspectDoctorConfiguration(
  configPathInput: string,
): Promise<DoctorResult> {
  const configPath = resolve(configPathInput);
  const checks: DoctorCheck[] = [];
  let redact = createConfigurationRedactor();
  let moduleValue: unknown;

  try {
    moduleValue = await loadConfigurationModuleValue(configPath);
    redact = createConfigurationRedactor(collectConfigurationSecrets(moduleValue));
    checks.push({
      id: "config.module",
      status: "pass",
      severity: "info",
      message: `loaded ${basename(configPath)}`,
    });
  } catch (error) {
    const isConfigurationError = error instanceof ChatServerConfigurationError;
    checks.push({
      id: "config.module",
      status: "fail",
      severity: isConfigurationError ? "warning" : "error",
      message: redact(errorMessage(error)),
    });
    return finishResult(
      configPath,
      isConfigurationError ? "actionable" : "operational_error",
      checks,
    );
  }

  let configuration: ReturnType<typeof normalizeConfigurationModuleValue>;
  try {
    configuration = normalizeConfigurationModuleValue(moduleValue);
  } catch (error) {
    checks.push({
      id: "config.validation",
      status: "fail",
      severity: "warning",
      message: redact(errorMessage(error)),
    });
    return finishResult(configPath, "actionable", checks);
  }

  const compatibilityChecks = [
    compatibilityCheck(
      "compatibility.package",
      "package version",
      configuration.compatibility.packageVersion,
      packageMetadata.version,
    ),
    compatibilityCheck(
      "compatibility.protocol",
      "realtime protocol version",
      configuration.compatibility.protocolVersion,
      CHAT_PROTOCOL_VERSION,
    ),
    compatibilityCheck(
      "compatibility.schema",
      "package schema version",
      configuration.compatibility.schemaVersion,
      packageSchemaVersion,
    ),
  ];

  let runtime: ReturnType<typeof createChatServer> | undefined;
  let status: DoctorStatus = compatibilityChecks.some(
    (check) => check.status === "fail",
  )
    ? "incompatible"
    : "healthy";

  try {
    runtime = createChatServer(configuration.server);
    checks.push({
      id: "config.validation",
      status: "pass",
      severity: "info",
      message: "required configuration and adapter methods are valid",
    });
    checks.push(...compatibilityChecks);

    for (const [feature, adapter] of Object.entries(FEATURE_ADAPTERS) as Array<
      [FeatureName, (typeof FEATURE_ADAPTERS)[FeatureName]]
    >) {
      const enabled = runtime.config.features[feature];
      checks.push({
        id: `feature.${feature}`,
        status: "pass",
        severity: "info",
        message: enabled
          ? `${feature} is enabled and the ${adapter} adapter is configured`
          : `${feature} is disabled; the ${adapter} adapter is not required`,
        details: Object.freeze({ enabled }),
      });
    }

    const runner = createPostgresMigrationRunner({
      database: runtime.database,
      schema: runtime.config.database.schema,
      migrations: handrailChatPostgresMigrations,
    });
    const migrationStatus = await runner.status();
    checks.push({
      id: "database.connectivity",
      status: "pass",
      severity: "info",
      message: `connected and inspected schema ${runner.schema} with read-only queries`,
    });

    const details = Object.freeze({
      schema: runner.schema,
      applied: migrationStatus.applied.length,
      pending: migrationStatus.pending.map(({ id }) => id),
      incompatible: migrationStatus.incompatible.map(({ id, reason }) => ({
        id,
        reason,
      })),
    });
    if (migrationStatus.incompatible.length > 0) {
      checks.push({
        id: "database.migrations",
        status: "fail",
        severity: "error",
        message: "applied migration history is incompatible with this package",
        details,
      });
      status = "incompatible";
    } else if (migrationStatus.pending.length > 0) {
      checks.push({
        id: "database.migrations",
        status: "warn",
        severity: "warning",
        message: `${migrationStatus.pending.length} migration(s) are pending; doctor did not apply them`,
        details,
      });
      if (status === "healthy") {
        status = "actionable";
      }
    } else {
      checks.push({
        id: "database.migrations",
        status: "pass",
        severity: "info",
        message: `${migrationStatus.applied.length} migration(s) are applied and compatible`,
        details,
      });
    }
  } catch (error) {
    if (error instanceof ChatServerConfigurationError) {
      checks.push({
        id: "config.validation",
        status: "fail",
        severity: "warning",
        message: redact(errorMessage(error)),
      });
      status = "actionable";
    } else {
      checks.push({
        id: runtime === undefined ? "config.initialization" : "database.connectivity",
        status: "fail",
        severity: "error",
        message: redact(errorMessage(error)),
      });
      status = "operational_error";
    }
  } finally {
    if (runtime !== undefined) {
      try {
        await runtime.close();
      } catch (error) {
        checks.push({
          id: "database.close",
          status: "fail",
          severity: "error",
          message: redact(errorMessage(error)),
        });
        status = "operational_error";
      }
    }
  }

  return finishResult(configPath, status, checks);
}

export const formatDoctorResult = (result: DoctorResult): string => {
  const lines = [
    `${result.package.name} doctor ${result.status} (exit ${result.exitCode})`,
  ];
  for (const check of result.checks) {
    const marker =
      check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${marker} ${check.id} ${check.message}`);
  }
  return `${lines.join("\n")}\n`;
};
