# @handrail/chat

This repository contains the JavaScript/TypeScript Handrail Chat SDK. Its public
package name remains `@handrail/chat`, with one version across its subpath exports.
The Dart/Flutter SDK lives in `handrail-sdk-chat-flutter`.

Install from `https://github.com/c0x65o/handrail-sdk-chat-js.git` at a full committed
SDK SHA and commit the matching package-manager lockfile. The install runs the
normal `prepare` build; there is no packaging or registry publishing step.
The repository split has committed SDK revisions; see the exact consumer pins
and remaining runtime validation in [the migration status](docs/sdk-repository-split.md).

Set `HANDRAIL_CHAT_JS_SHA` to the verified
40-character revision and run:

```bash
[[ "$HANDRAIL_CHAT_JS_SHA" =~ ^[0-9a-f]{40}$ ]] || exit 1
npm install --save-exact "@handrail/chat@git+https://github.com/c0x65o/handrail-sdk-chat-js.git#${HANDRAIL_CHAT_JS_SHA}"
```

Do not split these surfaces into independently versioned sibling packages.
Subpath exports keep browser, React, UI, server, and test code modular while
ensuring that their contracts move together under the same package version.

## Public entry points

The root contains runtime-neutral contracts and helpers shared across the SDK:

```ts
import * as chatContracts from "@handrail/chat";
```

Use the environment-specific subpaths instead of reaching into package internals:

```ts
// Node host application
import * as chatServer from "@handrail/chat/server";

// Browser application
import * as chatClient from "@handrail/chat/client";
import * as chatReact from "@handrail/chat/react";
import * as chatUi from "@handrail/chat/ui";
```

```ts
// Node integration tests
import * as chatTesting from "@handrail/chat/testing";
```

| Entry point | Responsibility | Runtime |
| --- | --- | --- |
| `@handrail/chat` | Shared transport, domain, identifier, read-state, and realtime contracts and helpers. | Runtime-neutral |
| `@handrail/chat/server` | Server contracts and the Node backend integration surface. | Node.js |
| `@handrail/chat/client` | Browser-safe state, snapshot, realtime, typing, and presence behavior. This is the primary custom-UI integration boundary. | Browser |
| `@handrail/chat/react` | Browser-safe, headless React integration that builds on the client surface. | Browser + React |
| `@handrail/chat/ui` | Browser-safe optional UI layer built on the headless integration. | Browser + React |
| `@handrail/chat/ui/styles.css` | Scoped design tokens and UI primitives. It has no implicit JavaScript import. | Browser CSS |
| `@handrail/chat/testing` | PostgreSQL-backed integration-test harness and test-only helpers. | Node.js tests |

Building a fully custom browser UI? Start with the
**[headless client and React integration guide](docs/headless-client-react.md)**
for lifecycle ownership, query view models, actions, optimistic reconciliation,
threads, reads, drafts, attachments, presence, huddles, and recovery behavior.

Starting the first application pilot? Follow the
**[React/Vite, Node/PostgreSQL, and Flutter pilot guide](docs/pilot-integration.md)**
for the executable path, ownership boundaries, UI capability matrix, and
production deferrals.

The React and UI entry points are public boundaries. The UI entry exports the
complete `ChatWorkspace` composition and its public slot contracts; its
timeline, composer, thread, and huddle bodies remain host-replaceable.
See the focused
**[ChatWorkspace customization contract](docs/chat-workspace-customization.md)**
for all layout modes, scopes, controlled selection, slots and renderer-safe
props, complete token names, body composition, accessibility ownership, and the
fully headless escape hatch.

## Architecture and ownership

```text
Host application
├─ Browser
│  ├─ custom UI ──> headless React ──┐
│  └─ optional Handrail UI ──────────┤
│                 browser client/state
│                         │ HTTP snapshots + managed realtime
└─ Node host ──> server module
                  ├─ trusted host adapters (auth/directory/permissions)
                  ├─ PostgreSQL chat data and outbox
                  └─ realtime boundary
```

The host application remains authoritative for identity, tenant resolution,
authorization, directory data, and other host services. The server surface owns
the chat-side persistence and transport boundary. The client surface owns
canonical browser state, snapshot application, reconnect/replay behavior, and
ephemeral signals; React and the optional UI consume that state.

See the [safe server embedding and host-adapter guide](docs/server-embedding.md)
for the trusted identity boundary, exact adapter members and feature gates,
PostgreSQL ownership, router/WebSocket mounting, replay, and graceful shutdown.

Consumers must use the client/state API rather than subscribe to raw WebSocket
events. Raw subscriptions bypass ordering, replay, refresh, and normalized-state
behavior that every attached UI needs to share.

## Platform and bundling expectations

- Node.js `>=22.0.0` is required. The server and testing entry points are
  Node-side surfaces.
- The client, React, and UI JavaScript entry points are browser-safe. React is a
  host-provided peer dependency with the supported range `>=18.2.0 <20`.
- Browser code should import browser subpaths directly. Conditional exports
  prevent browser resolution of the Node-only server entry, and the server graph
  must never enter a browser bundle.
- Import only the surfaces an application uses so bundlers can tree-shake along
  the subpath boundaries. Do not import `@handrail/chat/testing` from production
  or browser graphs; it intentionally brings Node and PostgreSQL test support.
- UI styles remain opt-in and are not imported by any JavaScript entry point:

```ts
import "@handrail/chat/ui/styles.css";
```

  Every provided selector is scoped beneath a host-owned `.handrail-chat` root.
  See the [optional UI styling guide](docs/ui-styles.md) for the styling
  foundation and the
  [ChatWorkspace customization contract](docs/chat-workspace-customization.md)
  for the complete shell and replacement API.

## Realtime compatibility

Realtime negotiation accepts the current protocol and its immediately previous
version. An unsupported older or newer protocol returns `refresh_required` with
the canonical message: “Chat was updated; refresh to continue.” Compatibility
is evaluated before replay availability.

If a compatible client's replay cursor has expired, the server returns
`snapshot_required`; the client must fetch a fresh snapshot before continuing.
Applications should handle these states through the client/state API, not by
implementing their own socket protocol.

The behavior is source-backed by the [realtime contract tests](test/realtime.test.mjs).

## PostgreSQL integration testing

The test harness uses real PostgreSQL and isolates each harness in its own
temporary schema. Set `TEST_DATABASE_URL` to use an existing test database. If
it is unset, the harness starts and owns a disposable `postgres:16-alpine`
container, so Docker must be available. Teardown drops only harness-owned
schemas and stops only a harness-owned container.

See the focused [full-stack integration testing guide](docs/integration-testing.md)
for actor and tenant fixtures, HTTP/client/socket examples, deterministic
failures, reconnect/idempotency coverage, and database safety boundaries. The
[PostgreSQL harness example](test/postgres-harness.test.mjs) and
[browser client bundle fixture](test/fixtures/browser-client.ts) remain focused,
executable references.

## PostgreSQL migrations

The published package installs the noninteractive `handrail-chat` command. It
uses the migration definitions shipped with that same package version:

```sh
handrail-chat --version
handrail-chat migrate status --connection-string "$HANDRAIL_CHAT_DATABASE_URL" --schema handrail_chat
handrail-chat migrate apply --connection-string "$HANDRAIL_CHAT_DATABASE_URL" --schema handrail_chat
```

`HANDRAIL_CHAT_DATABASE_URL` and `HANDRAIL_CHAT_SCHEMA` provide the same inputs
without flags; the schema defaults to `handrail_chat`. `migrate status` only
observes PostgreSQL catalogs and migration metadata—it does not create the
schema or metadata table. Only the explicit `migrate apply` subcommand creates
or changes database objects, using the migration runner's compatibility checks,
schema-scoped advisory lock, and transactions.

Migration `0043-chat-thread-lifecycle` is an expand-only addition
after `0036`: it creates the durable `chat_attachment_cleanup_deliveries` table,
its lifecycle-validation trigger, and recoverable work for already-abandoned
attachment objects without performing external deletion. Runtime releases N
and N-1 must tolerate the new table and trigger. Routine application rollback
leaves this forward schema in place; there is no down migration or destructive
contract step. Once applied, the migration SQL and its checksum are immutable.

Exit code `0` means the command completed (including a status with pending
migrations), `1` means a connection or migration operation failed, `2` means
the command input was invalid, and `3` means stored migration history is
incompatible with this package. Diagnostic output redacts the supplied database
URL and its credentials.

## Local development server

Start the package's focused HTTP and WebSocket host with an explicitly selected
ESM configuration module:

```sh
handrail-chat serve --config ./handrail-chat.config.mjs
handrail-chat serve --config ./handrail-chat.config.mjs --host 127.0.0.1 --port 0
```

The default address is `127.0.0.1:3000`. Port `0` asks the operating system for
an ephemeral port, and the readiness line reports the resolved loopback URL.
The command never selects a public bind address implicitly; a non-loopback host
is used only when it is explicitly passed with `--host`.

The default export follows the doctor configuration contract documented below:
it may be a `createChatServer` configuration, a `{ server, compatibility }`
envelope, or a zero-argument synchronous/async factory returning either form.
Module and factory console output is discarded so configuration secrets cannot
bypass the command's redacted reporters.

Before opening the listener, `serve` constructs the chat runtime and performs
only the migration runner's read-only status inspection. Pending migrations
exit `4`, and incompatible package/protocol/schema configuration or migration
history exits `3`; neither case listens. Operational startup or cleanup failures
exit `1`, invalid CLI options exit `2`, and a clean `SIGINT` or `SIGTERM`
shutdown exits `0`. The command never applies migrations, creates migration
metadata, seeds users, or calls host adapters as a startup preflight. Runtime
HTTP and WebSocket requests invoke adapters normally. Shutdown closes the HTTP
listener, active sockets, the chat runtime, and any database pool owned by the
runtime.

## Doctor preflight

Run the deterministic, side-effect-free integration preflight with an explicitly
selected local ESM module:

```sh
handrail-chat doctor --config ./handrail-chat.config.mjs
handrail-chat doctor --config ./handrail-chat.config.mjs --json
```

The module's default export may be the same configuration object passed to
`createChatServer`, or a zero-argument synchronous/async factory returning it.
The module and factory should only construct configuration; doctor discards
their incidental console output. Use an envelope when the host needs exact
compatibility assertions:

```js
export default async function createDoctorConfiguration() {
  return {
    server: {
      database: {
        connectionString: process.env.HANDRAIL_CHAT_DATABASE_URL,
        schema: "handrail_chat",
      },
      auth: hostAuthAdapter,
      directory: hostDirectoryAdapter,
      permissions: hostPermissionAdapter,
      storage: hostStorageAdapter,
      features: { attachments: true, media: false },
    },
    compatibility: {
      protocolVersion: 4,
      schemaVersion: 43,
    },
  };
}
```

Compatibility fields are optional exact assertions against the installed npm
package, realtime protocol, and latest shipped migration order. The example
leaves `packageVersion` unset so routine npm upgrades do not require a config
edit; pin it from application-owned configuration when an exact package build
is an intentional deployment boundary. Doctor uses the runtime's own
configuration normalization, so required adapter methods,
optional adapter methods, feature prerequisites, WebSocket options, and schema
identifiers are checked exactly as they are by `createChatServer`.

Doctor never starts HTTP or WebSocket listeners, attaches upgrade handlers,
calls auth/directory/permissions/storage/notification/audit/realtime/media
adapter methods, or applies migrations. Database inspection calls only the
migration runner's read-only catalog/status queries. Pending migrations are
reported, not applied. A pool supplied as `database.pool` is borrowed and is
never ended; a pool created from `database.connectionString` is owned by the
doctor runtime and is ended before the command exits.

`--json` emits the versioned result contract below. Check identifiers and order,
statuses (`pass`, `warn`, `fail`), and severities (`info`, `warning`, `error`)
are deterministic for schema version 1.

```json
{
  "schemaVersion": 1,
  "command": "doctor",
  "status": "healthy",
  "exitCode": 0,
  "package": {
    "name": "@handrail/chat",
    "version": "<installed package version>",
    "protocolVersion": 4,
    "schemaVersion": 43
  },
  "config": { "module": "handrail-chat.config.mjs" },
  "checks": [
    {
      "id": "config.module",
      "status": "pass",
      "severity": "info",
      "message": "loaded handrail-chat.config.mjs"
    }
  ]
}
```

Doctor exit codes are `0` for healthy, `1` for an operational/module/database
failure, `2` for invalid CLI usage, `3` for package/protocol/schema/migration
incompatibility, and `4` for actionable configuration or pending migrations.
Human and JSON output recursively redact PostgreSQL URLs, URL credentials,
authorization material, and values under secret-looking configuration keys.

## Repository checks

Install the locked development dependencies, then build and type-check:

```sh
npm ci --include=dev
npm run build
npm run typecheck
npm run test:cli
npm run test:exports
```
