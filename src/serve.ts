import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { CHAT_PROTOCOL_VERSION } from "./contracts/realtime.js";
import {
  collectConfigurationSecrets,
  createConfigurationRedactor,
  loadConfigurationModuleValue,
  normalizeConfigurationModuleValue,
} from "./doctor.js";
import {
  ChatServerConfigurationError,
  createChatServer,
  type ChatServerRuntime,
} from "./server/create-chat-server.js";
import { createPostgresMigrationRunner } from "./server/postgres-migrations.js";
import { handrailChatPostgresMigrations } from "./server/postgres-schema-migrations.js";

const packageMetadata = createRequire(import.meta.url)("../package.json") as {
  readonly version: string;
};

export const SERVE_EXIT_CODES = Object.freeze({
  stopped: 0,
  operationalError: 1,
  incompatible: 3,
  actionable: 4,
} as const);

export interface ServeOptions {
  readonly configPath: string;
  readonly host: string;
  readonly port: number;
}

type ShutdownSignal = "SIGINT" | "SIGTERM";

const packageSchemaVersion = handrailChatPostgresMigrations.reduce(
  (highest, migration) => Math.max(highest, migration.order),
  0,
);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const closeHttpServer = async (server: Server): Promise<void> => {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => (error ? rejectClose(error) : resolveClose()));
    // Do not let keep-alive HTTP clients make local subprocess shutdown hang.
    server.closeAllConnections();
  });
};

const listen = async (server: Server, port: number, host: string): Promise<void> =>
  new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveListen();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

const formatAddress = (address: AddressInfo): string => {
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
};

const compatibilityFailures = (
  compatibility: ReturnType<typeof normalizeConfigurationModuleValue>["compatibility"],
): readonly string[] => {
  const expected = [
    ["package", compatibility.packageVersion, packageMetadata.version],
    ["realtime protocol", compatibility.protocolVersion, CHAT_PROTOCOL_VERSION],
    ["schema", compatibility.schemaVersion, packageSchemaVersion],
  ] as const;
  return expected.flatMap(([label, configured, actual]) =>
    configured !== undefined && configured !== actual
      ? [`${label} version ${actual} is incompatible with configured value ${configured}`]
      : [],
  );
};

/** Runs the standalone local host until SIGINT or SIGTERM. */
export async function runServe(options: ServeOptions): Promise<number> {
  const configPath = resolve(options.configPath);
  let redact = createConfigurationRedactor();
  let runtime: ChatServerRuntime | undefined;
  let httpServer: Server | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let cleanupFailureReported = false;
  let removeSignalHandlers = () => {};

  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      const results = await Promise.allSettled([
        runtime?.close() ?? Promise.resolve(),
        httpServer === undefined
          ? Promise.resolve()
          : closeHttpServer(httpServer),
      ]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [errorMessage(result.reason)] : [],
      );
      if (failures.length > 0) {
        throw new Error(failures.join("; "));
      }
    })();
    return shutdownPromise;
  };

  try {
    let moduleValue: unknown;
    try {
      moduleValue = await loadConfigurationModuleValue(configPath);
      redact = createConfigurationRedactor(
        collectConfigurationSecrets(moduleValue),
      );
    } catch (error) {
      process.stderr.write(`handrail-chat serve: ${redact(errorMessage(error))}\n`);
      return error instanceof ChatServerConfigurationError
        ? SERVE_EXIT_CODES.actionable
        : SERVE_EXIT_CODES.operationalError;
    }

    let configuration: ReturnType<typeof normalizeConfigurationModuleValue>;
    try {
      configuration = normalizeConfigurationModuleValue(moduleValue);
    } catch (error) {
      process.stderr.write(`handrail-chat serve: ${redact(errorMessage(error))}\n`);
      return SERVE_EXIT_CODES.actionable;
    }

    const incompatible = compatibilityFailures(configuration.compatibility);
    if (incompatible.length > 0) {
      process.stderr.write(
        `handrail-chat serve: incompatible configuration\n${incompatible.join("\n")}\n`,
      );
      return SERVE_EXIT_CODES.incompatible;
    }

    try {
      runtime = createChatServer(configuration.server);
    } catch (error) {
      process.stderr.write(`handrail-chat serve: ${redact(errorMessage(error))}\n`);
      return error instanceof ChatServerConfigurationError
        ? SERVE_EXIT_CODES.actionable
        : SERVE_EXIT_CODES.operationalError;
    }

    const runner = createPostgresMigrationRunner({
      database: runtime.database,
      schema: runtime.config.database.schema,
      migrations: handrailChatPostgresMigrations,
    });
    const migrationStatus = await runner.status();
    if (migrationStatus.incompatible.length > 0) {
      process.stderr.write(
        `handrail-chat serve: migration history is incompatible (${migrationStatus.incompatible
          .map(({ id, reason }) => `${id}:${reason}`)
          .join(",")})\n`,
      );
      return SERVE_EXIT_CODES.incompatible;
    }
    if (migrationStatus.pending.length > 0) {
      process.stderr.write(
        `handrail-chat serve: ${migrationStatus.pending.length} migration(s) are pending; run handrail-chat migrate apply explicitly before serving\n`,
      );
      return SERVE_EXIT_CODES.actionable;
    }

    httpServer = createServer(runtime.router);
    runtime.attachWebSocket(httpServer);

    let resolveSignal!: (signal: ShutdownSignal) => void;
    const signalRequested = new Promise<ShutdownSignal>((resolveRequested) => {
      resolveSignal = resolveRequested;
    });
    const onSigint = () => resolveSignal("SIGINT");
    const onSigterm = () => resolveSignal("SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    removeSignalHandlers = () => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    await listen(httpServer, options.port, options.host);
    const address = httpServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("HTTP listener did not report a TCP address");
    }
    process.stdout.write(
      `handrail-chat serve ready ${formatAddress(address)} schema=${runner.schema}\n`,
    );

    let rejectServerError!: (error: Error) => void;
    const serverFailed = new Promise<never>((_resolve, reject) => {
      rejectServerError = reject;
    });
    const onServerError = (error: Error) => rejectServerError(error);
    httpServer.once("error", onServerError);
    try {
      const signal = await Promise.race([signalRequested, serverFailed]);
      await shutdown();
      process.stdout.write(`handrail-chat serve stopped ${signal}\n`);
      return SERVE_EXIT_CODES.stopped;
    } finally {
      httpServer.off("error", onServerError);
    }
  } catch (error) {
    const cleanupFailure = shutdownPromise !== undefined;
    process.stderr.write(
      `handrail-chat serve: ${cleanupFailure ? "cleanup failed: " : ""}${redact(errorMessage(error))}\n`,
    );
    cleanupFailureReported = cleanupFailure;
    return SERVE_EXIT_CODES.operationalError;
  } finally {
    removeSignalHandlers();
    try {
      await shutdown();
    } catch (error) {
      if (!cleanupFailureReported) {
        process.stderr.write(
          `handrail-chat serve: cleanup failed: ${redact(errorMessage(error))}\n`,
        );
      }
      return SERVE_EXIT_CODES.operationalError;
    }
  }
}
