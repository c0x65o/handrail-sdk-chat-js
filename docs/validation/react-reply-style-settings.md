# React reply-style settings validation

Owner item `05a78c94-0bc2-4b6e-b260-66bf6039d1fd`, goal
`0175981e-9e78-4a38-900a-e1148040c0a2`. Started from SDK main with the existing
runtime/capability prerequisite and sibling changes present; those were preserved.
Only SDK React settings implementation and deterministic local verification were
performed. No commit, push, PR, QA campaign, deployment, provider call, external
send or database operation.

## Behavior and changed files

Current means Reply opens a separate thread; Discord-style means Reply stays in
the current conversation with a reference. This item exposes that choice and
explanation; action routing, named creation/discovery and Flutter remain sibling
items. The existing runtime owns precedence, private persistence, reconciliation
and capabilities. No composer/provider remount or message/thread mutation is used.

- `src/react/reply-style-hooks.ts`: public state subscription and stable
  load/update/retry actions, runtime replacement and subscription cleanup.
- `src/react/index.ts`: hook/action type exports.
- `src/ui/reply-style-settings.ts`: labelled native select, effective style/source,
  host lock and saved choice, loading/unconfirmed/saving/failure/retry states;
  workspace dialog with focus containment/restoration and Escape/Close.
- `src/ui/index.ts`: reusable control/props exports.
- `src/ui/chat-workspace.ts`: default settings trigger and dialog with background
  inertness; existing host content/callback/custom header settings remain intact.
- `test/react-reply-style.test.mjs`: 17 focused component/hook/client checks.
- `test/chat-workspace-default.test.mjs`: updated default settings assertion and
  two settings/focus/host ownership regressions (three selected tests total).
- `type-tests/react-reply-style.test.ts`: public exports and supported action types.
- `tsconfig.react-reply-style.json`, `tsconfig.react-reply-style-type-tests.json`:
  scoped production compilation and public API type checks.
- `scripts/test-react-reply-style.mjs`: sequential isolated fresh-build runner.
- `docs/reply-style-settings.md`: host embedding and public hooks documentation.
- `docs/validation/react-reply-style-settings.md`: this record.

## Reproduction and results

From the SDK root:

```sh
node scripts/test-react-reply-style.mjs
```

Pass: production compilation, public API type checks, 17 component/hook tests
and 3 selected workspace tests. No failures, cancellations or skips.
The runner executes these commands sequentially (one test worker), replacing
`<fresh-output>` with a unique `build/react-reply-style-*` directory:

```sh
node node_modules/typescript/bin/tsc -p tsconfig.react-reply-style.json --outDir <fresh-output>
node node_modules/typescript/bin/tsc -p tsconfig.react-reply-style-type-tests.json
node --test --test-concurrency=1 --test-timeout=15000 test/react-reply-style.test.mjs
node --test --test-concurrency=1 --test-timeout=15000 --test-name-pattern='WorkspaceHeader|reply style settings|host settings content' <fresh-output>/workspace.test.mjs
```

`HANDRAIL_REPLY_STYLE_BUILD` points at the freshly compiled output for component
tests. The workspace test is copied into that output with only its four package
imports redirected to the fresh compilation. Shared `dist` is never overwritten;
the runner removes its own temporary output on completion.

```sh
git diff --check -- src/react/index.ts src/react/reply-style-hooks.ts src/ui/index.ts src/ui/reply-style-settings.ts src/ui/chat-workspace.ts test/chat-workspace-default.test.mjs test/react-reply-style.test.mjs scripts/test-react-reply-style.mjs type-tests/react-reply-style.test.ts docs/reply-style-settings.md docs/validation/react-reply-style-settings.md tsconfig.react-reply-style.json tsconfig.react-reply-style-type-tests.json
```

Pass. Initial fixture issues were corrected: explicit test NODE_ENV is required
for React `act`, and workspace slot overrides use `components`, not `slots`.
The initial NODE_ENV failure left test timers open; that run was interrupted,
and the final runner includes a bounded test timeout. No unresolved failures
were observed in the scoped checks.

## Coverage and limits

Tests use happy-dom/React plus the real preference runtime, with narrow HTTP or
snapshot/command boundary doubles. No database persistence is claimed. Coverage
includes absent preference, host default, explicit Current, enforced override,
unknown values/capabilities, independent preference support with inline/named
flags absent, unresolved reads, safe failed read/save errors, exact uncertain
mutation replay after reconciliation, conflict retry, authoritative reload,
reconnect, canonical event subscriptions and context client replacement/cleanup.

A populated real-client regression keeps draft text and an attachment reference,
reply metadata with `notifyAuthor: false`, canonical open-thread identity, message
cache and frozen queued-send destination/reference unchanged through settings
selection, conflict, retry, host policy changes and reload. A mounted composer
sentinel also remains identical. The workspace regression separately proves its
actual draft textarea stays mounted with its value when settings opens/closes.
Host settings callbacks, content, custom header slots, search and creation
controls are exercised in the selected existing WorkspaceHeader test.

Keyboard checks cover Enter/Space activation, Tab/Shift+Tab containment, Escape,
Close, focus restoration, associated labels/descriptions and live status/alert
text, including React StrictMode. Native select arrow-key behavior is delegated
to the browser: happy-dom does not implement that native default. Tests assert
the key is not intercepted and dispatch the resulting native change event.
No real-browser or screen-reader QA campaign was performed, as required by scope.

No canonical/generated descriptors changed, so regeneration was unnecessary.
No SQL, Flutter, preview or unrelated global checks were needed or run.
