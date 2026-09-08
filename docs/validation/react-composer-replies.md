# React inline reply composer

The composer sends an inline reply in its current `conversationId`, including
when that conversation is already a thread. It never creates or opens a thread.
The separately owned reply-style setting preserves the existing Reply-to-thread
action; changing that setting must not remount or retarget a pending composer.
Both style presentations can keep this composer and its selected reference.

## Public controls

`MessageComposer` accepts `controlsRef: Ref<ChatComposerControls>`. Custom
`Composer` slots receive the same commands through `props.controls`:

- `selectReply({ conversationId, messageId })` selects/replaces a source and
  defaults `notifyAuthor` to `true`. Cross-conversation targets are rejected.
- `setReplyNotifyAuthor(false)` records an explicit disabled reply-author ping;
  explicit mentions continue to use the existing mention behavior.
- `clearReply()` preserves text, mentions and attachments and restores the
  default editor's focus. Custom renderers manage their own editor focus.
- `retryReplySource()` retries a recoverable source lookup in the same scope.

`state.replyTo` contains the selected reference and ping; `state.replyContext`
contains bounded accessible author/text or a loading, deleted, unavailable or
recoverable error status. No source snapshot is stored in the draft. The public
source-context runtime supplies access decisions and invalidates resolved content.
The composer removes inaccessible source content from its current DOM/slot state.
Server validation remains authoritative for the source's actual conversation.

Source and ping changes call the existing durable draft actions. An otherwise
empty source-only draft is retained and restored. The send contract carries
`replyTo` beside `content`, while drafts carry it inside draft content, as their
respective canonical contracts require. Reference and ping remain frozen in
queued sends. Retrying an old intent uses its client message ID and leaves a
newer composer draft intact. A new composition submits a separate intent.

Edit-message controls remain separate: editing a sent message submits only the
existing edit contract, and a source-only composer does not trigger the empty
composer's ArrowUp edit shortcut.

## Local verification

Run `node scripts/test-composer-replies.mjs`. It sequentially compiles the current
UI/client import graph into an isolated temporary directory, checks the public
composer types, then runs the Happy DOM/React composer tests and existing client
draft synchronization tests with `--test-concurrency=1`. Tests load this fresh
output instead of stale `dist`; the script removes its own output afterward.
Final run: both scoped TypeScript checks passed and **63/63 tests passed**.

Coverage includes source-only restoration, replacement, ping, cancellation and
focus, channel/thread destination preservation, style rerenders, rejected-source
recovery with attachments, loading/error/revocation, failed-intent selection by
source and ping, frozen retry metadata, late completion after newer draft edits
or a conversation switch, and immutable edit ancestry. The real client draft
runtime test covers its late-send clear guard; composer tests use narrow client
and source-runtime boundaries. No SQL behavior, provider calls or deployed QA
are claimed. Style persistence and timeline action routing remain separate work.

## Changed files and shared-checkout note

Production changes are limited to `src/ui/message-composer.ts`, composer fields
in `src/ui/slots.ts`, local rules in `src/ui/styles.css`, and the late-send draft
clear guard in `src/client/create-chat-client.ts`. No React hook/export changes
were needed. Verification changes are in `test/message-composer.test.mjs`,
`test/client-draft-synchronization.test.mjs`, `type-tests/message-composer.test.ts`,
`scripts/test-composer-replies.mjs`, and the two `tsconfig.composer-replies*.json`
files, plus this note.

During the run, HEAD advanced externally from `509e29f` to `93712df`, including
some in-progress source edits and this worker's temporary compiler output. The
worker did not commit or push. Its own `build/composer-replies-Pv6MUH/` output and
`build/composer-replies-check.log` were removed; their tracked deletions are cleanup
of that externally captured output. Future temporary output uses ignored `dist`.
Sibling source changes were preserved.
