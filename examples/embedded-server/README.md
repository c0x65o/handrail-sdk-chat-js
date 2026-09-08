# Embedded Node server

This example embeds the single `@handrail/chat` package in an existing Node
HTTP server. It imports only the public `@handrail/chat/server` entry point,
mounts the router at `/api/chat`, attaches WebSocket upgrades to the same HTTP
listener, and closes runtime-owned sockets and server resources deterministically.

Use the repository's [safe server embedding and host-adapter guide](../../docs/server-embedding.md)
for the complete operational contract. This fixture stays intentionally small
and local while the guide covers every current adapter, feature gate, database
ownership mode, replay outcome, and secret boundary.

The fixture host intentionally has no live integrations. An opaque, randomly
generated `host_session` cookie is mapped server-side to a fixture tenant, user,
and roles. Chat bodies, query parameters, and caller-authored identity headers
are never identity sources. The directory, entity authorization, storage,
notification, audit, media, and database boundaries are deterministic local
fixtures so the smoke test needs no provider or external service.

## Install and verify

From this directory:

```sh
npm install
npm run typecheck
npm run build
npm run smoke
npm run check:static
```

`npm run check` runs all three acceptance paths. The smoke test binds only to
`127.0.0.1` on an ephemeral port, authenticates with the fixture host session,
reads `/api/chat/_meta`, lists the actor-visible fixture conversation, completes
the package-compatible WebSocket handshake, and invokes graceful shutdown.
`npm start` runs the fixture host until `SIGINT` or `SIGTERM`; the signal path
uses the same idempotent shutdown routine exercised by the smoke test and never
prints the opaque fixture session cookie.

## Migrations for a real host database

The local query fixture is deliberately read-only and does not apply migrations.
A real host supplies its PostgreSQL URL through the environment and runs status
and apply explicitly before starting the application:

```sh
export HANDRAIL_CHAT_DATABASE_URL="${DATABASE_URL:?set DATABASE_URL in your environment}"
npx handrail-chat migrate status
npx handrail-chat migrate apply
```

No database URL or credential belongs in source control. The runtime also
supports an environment-derived connection string when the host constructs
`createChatServer`; migration application remains an explicit CLI operation.

The deterministic notification fixture does not register device push tokens. Its
protector rejects that unsupported operation. An application enabling device
push supplies its own token protector and durable notification provider.
