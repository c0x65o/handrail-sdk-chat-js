import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import * as server from "@handrail/chat/server";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dirname, "..");
const guidePath = resolve(packageRoot, "docs/server-embedding.md");

const readGuide = () => readFile(guidePath, "utf8");

const parseContract = (guide) => {
  const serialized = guide.match(
    /<!-- server-embedding-contract\s*([\s\S]*?)\s*-->/u,
  )?.[1];
  assert.ok(serialized, "server embedding contract marker is missing");
  return JSON.parse(serialized);
};

const extractExample = (guide) => {
  const marked = guide.match(
    /<!-- server-embedding-example:start -->\s*```ts\s*\n([\s\S]*?)^```\s*\n<!-- server-embedding-example:end -->/mu,
  )?.[1];
  assert.ok(marked, "marked TypeScript embedding example is missing");
  return marked;
};

const interfaceMethods = (source, names) => {
  const methods = new Map();
  for (const name of names) {
    const body = source.match(
      new RegExp(
        `export interface ${name}(?:<[\\s\\S]*?>)?\\s*\\{([\\s\\S]*?)^\\}`,
        "mu",
      ),
    )?.[1];
    if (body === undefined) {
      continue;
    }
    methods.set(
      name,
      [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\??\s*(?:\(|:)/gmu)]
        .map(([, member]) => member),
    );
  }
  return methods;
};

const featureAdapters = (source) => {
  const body = source.match(
    /const FEATURE_ADAPTERS = \{([\s\S]*?)\} as const satisfies/um,
  )?.[1];
  assert.ok(body, "FEATURE_ADAPTERS was not found in create-chat-server.ts");
  return Object.fromEntries(
    [...body.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*): "([A-Za-z][A-Za-z0-9]*)",/gmu)]
      .map(([, feature, adapter]) => [feature, adapter]),
  );
};

test("server embedding guide links remain inside the repository", async () => {
  const guide = await readGuide();
  const targets = [...guide.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/gu)]
    .map(([, target]) => target.trim().replace(/^<|>$/gu, ""))
    .filter(
      (target) =>
        !target.startsWith("#") &&
        !target.startsWith("/") &&
        !/^[a-z][a-z+.-]*:/iu.test(target),
    );

  assert.ok(targets.length > 0, "server embedding guide has no links");
  for (const target of targets) {
    const linked = resolve(dirname(guidePath), decodeURIComponent(target.split("#", 1)[0]));
    const repositoryRelative = relative(packageRoot, linked);
    assert.equal(
      repositoryRelative.startsWith("..") || isAbsolute(repositoryRelative),
      false,
      `guide link leaves the repository: ${target}`,
    );
    await access(linked);
  }

  const [readme, exampleReadme] = await Promise.all([
    readFile(resolve(packageRoot, "README.md"), "utf8"),
    readFile(resolve(packageRoot, "examples/embedded-server/README.md"), "utf8"),
  ]);
  assert.match(readme, /\(docs\/server-embedding\.md\)/u);
  assert.match(exampleReadme, /\(\.\.\/\.\.\/docs\/server-embedding\.md\)/u);
});

test("marked embedding configuration, mount, and lifecycle compile against the server entry point", async () => {
  const guide = await readGuide();
  const example = extractExample(guide);
  const temporaryRoot = await mkdtemp(
    resolve(packageRoot, ".server-embedding-docs-"),
  );
  const sourcePath = resolve(temporaryRoot, "example.ts");
  const tscPath = resolve(packageRoot, "node_modules/typescript/bin/tsc");

  try {
    await writeFile(sourcePath, example, "utf8");
    await execFileAsync(
      process.execPath,
      [
        tscPath,
        "--ignoreConfig",
        "--noEmit",
        "--strict",
        "--exactOptionalPropertyTypes",
        "--skipLibCheck",
        "--target",
        "ES2022",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        sourcePath,
      ],
      { cwd: packageRoot },
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("documented adapters and feature gates match the public TypeScript source", async () => {
  const [
    guide,
    contractsSource,
    serverSource,
    notificationSource,
    auditSource,
    attachmentCleanupSource,
  ] = await Promise.all([
    readGuide(),
    readFile(resolve(packageRoot, "src/server/contracts.ts"), "utf8"),
    readFile(resolve(packageRoot, "src/server/create-chat-server.ts"), "utf8"),
    readFile(resolve(packageRoot, "src/server/notification-dispatcher.ts"), "utf8"),
    readFile(resolve(packageRoot, "src/server/audit-dispatcher.ts"), "utf8"),
    readFile(
      resolve(packageRoot, "src/server/attachment-cleanup-dispatcher.ts"),
      "utf8",
    ),
  ]);
  const contract = parseContract(guide);
  const documentedAdapters = {
    ...contract.requiredAdapters,
    ...contract.optionalAdapters,
  };
  for (const [adapter, members] of Object.entries(
    contract.optionalAdapterMembers ?? {},
  )) {
    documentedAdapters[adapter] = [
      ...(documentedAdapters[adapter] ?? []),
      ...members,
    ];
  }
  const sourceMethods = interfaceMethods(
    contractsSource,
    new Set(Object.keys(documentedAdapters)),
  );

  assert.equal(sourceMethods.size, Object.keys(documentedAdapters).length);
  for (const [adapter, members] of Object.entries(documentedAdapters)) {
    assert.deepEqual(
      new Set(sourceMethods.get(adapter)),
      new Set(members),
      `${adapter} documentation drifted from its public members`,
    );
    for (const member of members) {
      assert.match(
        guide,
        new RegExp(`\\b${member}\\b`, "u"),
        `${adapter}.${member} is absent from the guide`,
      );
    }
  }
  assert.deepEqual(featureAdapters(serverSource), contract.features);
  assert.match(
    notificationSource,
    /options\.adapter\.send\(input\)/u,
    "automatic notification delivery must call only the configured adapter",
  );
  assert.match(
    auditSource,
    /options\.adapter\.record\(event\)/u,
    "automatic audit export must call only the configured adapter",
  );
  assert.match(
    attachmentCleanupSource,
    /options\.adapter\.deleteObject\(input\)/u,
    "automatic attachment cleanup must call only the configured adapter",
  );
});

test("realtime delivery documentation locks single-process and clustered boundaries", async () => {
  const [guide, serverSource, fixtureHost] = await Promise.all([
    readGuide(),
    readFile(resolve(packageRoot, "src/server/create-chat-server.ts"), "utf8"),
    readFile(
      resolve(packageRoot, "examples/embedded-server/src/host.ts"),
      "utf8",
    ),
  ]);
  const normalized = guide.replace(/\s+/gu, " ");

  assert.deepEqual(parseContract(guide).realtimeDelivery, {
    option: "realtimeDelivery",
    default: "single_process",
    values: ["single_process", "clustered"],
    clusteredRequires: {
      feature: "realtime",
      adapterMembers: ["publish", "subscribe"],
    },
  });
  assert.match(
    normalized,
    /SDK guarantees only delivery to sockets attached to the same runtime process/u,
  );
  assert.match(
    normalized,
    /Clustered mode fails construction unless `features\.realtime` is `true` and the realtime adapter provides callable `publish` and `subscribe` members/u,
  );
  assert.match(
    normalized,
    /before allocating an owned database pool, starting workers, or calling a provider/u,
  );
  assert.match(serverSource, /const normalizeRealtimeDelivery =/u);
  assert.match(extractExample(guide), /realtimeDelivery:\s*"clustered"/u);
  assert.match(fixtureHost, /realtimeDelivery:\s*"single_process"/u);
});

test("audit export documentation preserves authority, delivery, and lifecycle boundaries", async () => {
  const guide = await readGuide();
  const normalized = guide.replace(/\s+/gu, " ");
  const contract = parseContract(guide).auditDelivery;

  assert.deepEqual(contract, {
    authoritativeTable: "chat_audit_events",
    deliverySemantics: "at_least_once",
    idempotencyKey: "auditEventId",
    enabledFeature: "audit",
    manualDrain: "auditDispatcher.runOnce",
    defaults: {
      batchSize: server.DEFAULT_CHAT_AUDIT_BATCH_SIZE,
      pollIntervalMs: server.DEFAULT_CHAT_AUDIT_POLL_INTERVAL_MS,
      leaseDurationMs: server.DEFAULT_CHAT_AUDIT_LEASE_DURATION_MS,
      initialRetryDelayMs: server.DEFAULT_CHAT_AUDIT_INITIAL_RETRY_DELAY_MS,
      maxRetryDelayMs: server.DEFAULT_CHAT_AUDIT_MAX_RETRY_DELAY_MS,
    },
  });
  assert.match(normalized, /PostgreSQL rows in `chat_audit_events` are the authoritative audit record/u);
  assert.match(normalized, /`ChatAuditAdapter` is an asynchronous at-least-once export boundary/u);
  assert.match(normalized, /provider must make `record` idempotent using the stable `auditEventId`/u);
  assert.match(normalized, /runtime exposes `auditDispatcher\.runOnce\(\)` for a deterministic manual batch/u);
  assert.match(normalized, /When audit is disabled, `runtime\.auditDispatcher` is `undefined` and no audit polling query or adapter call occurs/u);
  assert.match(normalized, /Construction, migration status, and migration application never call the audit provider/u);
  assert.match(normalized, /awaits an in-flight automatic or manual audit batch before an owned database is ended/u);
  assert.match(extractExample(guide), /auditDelivery:\s*\{[\s\S]*pollIntervalMs:/u);
});

test("attachment cleanup documentation preserves ownership and shutdown boundaries", async () => {
  const [guide, contractsSource] = await Promise.all([
    readGuide(),
    readFile(resolve(packageRoot, "src/server/contracts.ts"), "utf8"),
  ]);
  const normalized = guide.replace(/\s+/gu, " ");
  const contract = parseContract(guide).attachmentCleanup;

  assert.deepEqual(contract, {
    authoritativeTable: "chat_attachment_cleanup_deliveries",
    deliverySemantics: "at_least_once",
    stableRetryIdentity: ["tenantId", "attachmentId", "objectKey"],
    alreadyAbsentResult: "success",
    telemetryExcludes: ["providerMessages", "objectKeys"],
    enabledFeature: "attachments",
    manualDrain: "dispatchAttachmentCleanupOnce",
    defaults: {
      batchSize: server.DEFAULT_CHAT_ATTACHMENT_CLEANUP_BATCH_SIZE,
      pollIntervalMs: server.DEFAULT_CHAT_ATTACHMENT_CLEANUP_POLL_INTERVAL_MS,
      leaseDurationMs: server.DEFAULT_CHAT_ATTACHMENT_CLEANUP_LEASE_DURATION_MS,
      maxAttempts: server.DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_ATTEMPTS,
      initialRetryDelayMs:
        server.DEFAULT_CHAT_ATTACHMENT_CLEANUP_INITIAL_RETRY_DELAY_MS,
      maxRetryDelayMs:
        server.DEFAULT_CHAT_ATTACHMENT_CLEANUP_MAX_RETRY_DELAY_MS,
    },
  });
  assert.match(
    normalized,
    /`createChatServer` owns and starts one attachment cleanup dispatcher/u,
  );
  assert.match(
    normalized,
    /exposes `dispatchAttachmentCleanupOnce\(\)` for a deterministic manual drain/u,
  );
  assert.match(
    normalized,
    /`ChatStorageAdapter\.deleteObject` delivery is at least once/u,
  );
  assert.match(
    normalized,
    /stable retry identity is `\(tenantId, attachmentId, objectKey\)`/u,
  );
  assert.match(
    normalized,
    /deleting an already-absent object resolves successfully/u,
  );
  assert.match(
    normalized,
    /provider messages and object keys must never enter telemetry/u,
  );
  assert.match(
    contractsSource,
    /At-least-once cleanup boundary\.[\s\S]*\(tenantId, attachmentId, objectKey\) retry identity\.[\s\S]*already absent, must resolve successfully\.[\s\S]*Provider messages and object keys must never enter telemetry\.[\s\S]*deleteObject\(input: ChatStorageObjectInput\): Promise<void>;/u,
  );
  assert.match(
    normalized,
    /When attachments are disabled, `runtime\.attachmentCleanupDispatcher` is `undefined`/u,
  );
  assert.match(
    normalized,
    /Construction does not query the cleanup tables or call `storage\.deleteObject`/u,
  );
  assert.match(
    normalized,
    /awaits any in-flight automatic or manual cleanup batch before an owned database is ended/u,
  );
  assert.match(
    extractExample(guide),
    /attachmentCleanup:\s*\{[\s\S]*pollIntervalMs:/u,
  );
  assert.match(
    extractExample(guide),
    /chat\.dispatchAttachmentCleanupOnce\(\)/u,
  );
});

test("documented CLI usage and mounted paths match the built public implementation", async () => {
  const [guide, serverSource] = await Promise.all([
    readGuide(),
    readFile(resolve(packageRoot, "src/server/create-chat-server.ts"), "utf8"),
  ]);
  const contract = parseContract(guide);
  const { stdout: help, stderr } = await execFileAsync(
    process.execPath,
    [resolve(packageRoot, "dist/cli.js"), "--help"],
    { cwd: packageRoot },
  );
  assert.equal(stderr, "");
  for (const usageLine of contract.cliUsage) {
    assert.ok(help.includes(usageLine), `CLI help is missing: ${usageLine}`);
  }
  assert.deepEqual(contract.postgresMigrationReleasePolicy.preflightCommands, [
    "handrail-chat migrate status [--connection-string <url>] [--schema <name>]",
    "handrail-chat doctor --config <module.mjs> [--json]",
    "handrail-chat migrate apply  [--connection-string <url>] [--schema <name>]",
    "handrail-chat serve --config <module.mjs> [--host <host>] [--port <port>]",
  ]);
  for (const command of
    contract.postgresMigrationReleasePolicy.preflightCommands) {
    assert.ok(contract.cliUsage.includes(command));
    assert.ok(help.includes(command), `CLI help is missing preflight: ${command}`);
  }

  const helpFlags = new Set(help.match(/--[a-z][a-z-]*/gu) ?? []);
  const documentedFlags = new Set(guide.match(/--[a-z][a-z-]*/gu) ?? []);
  for (const flag of documentedFlags) {
    assert.ok(helpFlags.has(flag), `guide documents an unknown CLI flag: ${flag}`);
  }

  assert.deepEqual(contract.httpRoutes, [
    { method: "GET", path: "/_meta" },
    { method: "POST", path: server.HOST_DIRECTORY_BATCH_ROUTE },
    { method: "GET", path: server.HOST_DIRECTORY_SEARCH_ROUTE },
    { method: "GET", path: server.CONVERSATION_LIST_ROUTE },
    { method: "GET", pathPrefix: server.CONVERSATION_DETAIL_ROUTE_PREFIX },
  ]);
  assert.match(
    serverSource,
    /staticChatRoute\("GET", "\/_meta"\)/u,
  );
  assert.equal(contract.webSocketDefaultPath, server.DEFAULT_CHAT_WEBSOCKET_PATH);
  assert.deepEqual(contract.webSocketSessionRevalidation, {
    intervalOption: "sessionRevalidationIntervalMs",
    defaultMs: server.DEFAULT_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
    minimumMs: server.MIN_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
    maximumMs: server.MAX_CHAT_WEBSOCKET_SESSION_REVALIDATION_INTERVAL_MS,
  });
  for (const route of contract.httpRoutes) {
    const displayedPath =
      route.path ?? `${route.pathPrefix}{conversationId}`;
    assert.ok(guide.includes(`\`${displayedPath}\``));
  }
  assert.ok(guide.includes(`\`${contract.webSocketDefaultPath}\``));
});

test("request admission documentation preserves the host-auth and fail-closed contract", async () => {
  const guide = await readGuide();
  const contract = parseContract(guide).requestAdmission;

  assert.deepEqual(contract, {
    authenticationApiHostLimit: { requests: 10, windowSeconds: 60 },
    minimumRetryAfterSeconds:
      server.MIN_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
    maximumRetryAfterSeconds:
      server.MAX_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
    failureRetryAfterSeconds:
      server.DEFAULT_CHAT_REQUEST_ADMISSION_RETRY_AFTER_SECONDS,
    failurePolicy: "fail_closed",
    metadata: ["method", "routeTemplate"],
  });
  assert.match(
    guide,
    /authoritative\s+authentication-API rule remains host-owned at \*\*10 requests per 60 seconds\*\*/u,
  );
  assert.match(guide, /does not protect the host login endpoint/u);
  assert.match(guide, /before `auth\.resolveActor`[\s\S]*request-body reads/u);
  assert.match(guide, /raw path identifiers and query strings are\s+never copied/u);
  assert.match(guide, /fails closed[\s\S]*provider text are never copied/u);
  assert.match(
    guide,
    /does not derive identity or a limiter key from headers,\s+IP addresses, cookies, query parameters, or bodies/u,
  );
});

test("PostgreSQL compatibility and rollback gates remain explicit", async () => {
  const guide = await readGuide();
  const prose = guide.replace(
    /<!-- server-embedding-contract[\s\S]*?-->/u,
    "",
  );
  const normalized = prose.replace(/[`\s]+/gu, " ").trim();
  const policy = parseContract(guide).postgresMigrationReleasePolicy;

  assert.deepEqual(policy.compatibilityGates, [
    "The supported sequence is expand before code, code and bounded backfill, then contract.",
    "Every forward schema must remain compatible with runtime releases N and N-1, so application rollback can restore N-1 while leaving the forward schema in place.",
    "Run data backfills separately from schema migration transactions, in bounded, restartable batches with measured lock and load impact.",
    "A destructive contract migration is allowed only after the N/N-1 compatibility window has closed, all N-1 instances and old jobs are retired, the backfill is verified, and no supported code path depends on the object being removed.",
    "Before apply, operators must create a recoverable backup using their database platform's approved mechanism and verify through a tested restore exercise that the documented restore procedure works.",
  ]);
  assert.deepEqual(policy.preflightBehavior, [
    "handrail-chat migrate status is read-only and detects pending, out-of-order, or checksum-incompatible migration history.",
    "handrail-chat doctor --config <module.mjs> [--json] validates configuration and reports migration state without applying it.",
    "handrail-chat migrate apply is the explicit compatible apply step.",
    "handrail-chat serve refuses incompatible or pending migrations rather than applying them.",
  ]);
  assert.equal(
    policy.immutableAppliedMigrationRule,
    "Never edit SQL for an applied migration; its recorded checksum makes edited history incompatible.",
  );
  assert.equal(
    policy.rollbackPolicy,
    "Routine rollback must not use a down migration; restore and down operations are operator-owned emergency actions, not SDK automation.",
  );
  for (const command of policy.preflightCommands) {
    assert.ok(prose.includes(command), `missing documented preflight: ${command}`);
  }

  for (const statement of [
    ...policy.compatibilityGates,
    ...policy.preflightBehavior,
    policy.immutableAppliedMigrationRule,
    policy.rollbackPolicy,
  ]) {
    assert.ok(normalized.includes(statement), `missing migration policy: ${statement}`);
  }
});

test("server embedding safety boundaries remain explicit", async () => {
  const guide = await readGuide();
  const normalized = guide.replace(/\s+/gu, " ");
  const requiredStatements = [
    "Trusted tenant ID, user ID, and roles come exclusively from the host's authenticated server-side request/session.",
    "Request bodies, query parameters, client-supplied tenant/user fields, and caller-authored identity headers are never trusted as identity sources.",
    "All storage, notification, audit, realtime, and media provider calls occur through host-supplied adapters.",
    "createChatServer startup never applies migrations, seeds data, or preflights provider calls.",
    "PostgreSQL rows in `chat_audit_events` are the authoritative audit record; `chat_audit_deliveries` tracks asynchronous export attempts without replacing that record.",
    "Provider and database secrets remain server-side.",
    "Only narrowly scoped upload/download URLs or participant tokens cross the client boundary.",
  ];
  for (const statement of requiredStatements) {
    assert.ok(normalized.includes(statement), `missing safety statement: ${statement}`);
  }

  assert.match(normalized, /runtime derives recipient intents from durable `message\.created` outbox rows after commit/u);
  assert.match(normalized, /It never receives the message body, message content, credentials, secrets, or provider payloads/u);
  assert.doesNotMatch(
    extractExample(guide),
    /postgres(?:ql)?:\/\/|-----BEGIN .*PRIVATE KEY-----|Bearer\s+[^"'\s]+/iu,
    "compiled example must not contain database URLs, credentials, or keys",
  );
});
