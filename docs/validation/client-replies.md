# Client reply sends and unread reconciliation

Selected Owner Task item: `86599fae-5b99-4e45-b731-77c1e641882f`.

The authored TypeScript client previously discarded the optional inline reply
reference. It now accepts the canonical `MessageReplyReference`, validates it,
and retains it in the optimistic message and HTTP request. The supplied
conversation is the destination, including an existing thread. Sending an
inline reply does not create a thread. Canonical HTTP and event reconciliation
already preserve the reference; the focused tests exercise both arrival orders.

Logical requests are detached and recursively frozen before asynchronous work.
Retries retain destination, source ID, notifyAuthor, content, clientMessageId and
idempotencyKey. Successful sends clear the draft in the original destination,
even if the caller mutates its input while awaiting the response.

Reply pings remain outside content mentions. The new refresh coordinator observes
canonical cache changes (including HTTP settlements and cross-tab event reduction),
coalesces each conversation's work and permits at most four concurrent detail
requests. Canonical reply creation and deletion/source deletion refresh authority;
unavailable source context triggers a safe refresh. Reconnect refreshes cached
conversations, including those whose replies/sources are outside loaded pages.
Duplicate canonical revisions do not request more work. Ping-disabled replies and
known other recipients do not trigger creation refreshes.

A dedicated reader does not automatically hydrate the cache. Before hydration the
coordinator checks the current actor/session, tenant, conversation, memberships,
read state, durable stream state, parent context and request lifetime. Changes
while a request is running discard the response and coalesce a follow-up. Identity
boundaries, close and stream revocation cancel pending work; parent revocation also
suppresses pending child refreshes. Detail hydration now retains authoritative
unread mention counts in the same metadata used by list selectors.

Changed files for this item:

- `src/client/create-chat-client.ts`
- `src/client/normalized-cache.ts`
- `src/client/realtime-session.ts`
- `src/client/unread-mention-refresh.ts`
- `test/optimistic-message-sending.test.mjs`
- `test/realtime-session.test.mjs`
- `type-tests/create-chat-client.test.ts`
- `tsconfig.client-replies.json`
- `tsconfig.client-replies-type-tests.json`
- `docs/validation/client-replies.md`

Verification on 2026-09-06, sequential with one Node test worker:

- `node_modules/.bin/tsc --project tsconfig.client-replies.json`: PASS. Emits the
  client production dependency graph to the existing ignored dist directory.
- `node_modules/.bin/tsc --project tsconfig.client-replies-type-tests.json`: PASS.
- `node --test --test-concurrency=1 test/optimistic-message-sending.test.mjs test/realtime-session.test.mjs test/client-draft-synchronization.test.mjs`:
  PASS, 47 tests against freshly compiled code.
- `node --test --test-concurrency=1 --test-name-pattern='normalizes|projects paginated|older conversation|older timeline|structural sharing' test/normalized-cache.test.mjs`:
  PASS, 5 focused cache regressions.
- `git diff --check`: PASS.

The initial full normalized-cache test file also exposed an unrelated existing
failure at `test/normalized-cache.test.mjs:638`: its preference mutation fixture
omits required current-contract fields (including isStarred). The preference
mutation path and fixture were not changed by this item.

`node --test --test-concurrency=1 test/postgres-conversation-reply-unread.test.mjs`
could not initialize the existing isolated PostgreSQL harness: no TEST_DATABASE_URL
or usable Docker backend was available. SQL persistence assertions therefore did
not run. Realtime tests use a narrow HTTP boundary with explicit authoritative
snapshot fixtures; they do not claim to prove SQL persistence and do not substitute
a handwritten database. Rerun the existing Postgres test when its backend is available.

No canonical contract or generated Dart production file needed changes. Dart
analysis is not applicable to this patch. Offline persistence remains the separate
dependent task. Sibling dirty files were preserved; this patch is uncommitted.
