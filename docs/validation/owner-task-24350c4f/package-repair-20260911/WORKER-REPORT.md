# Package repair and publication handoff

Task: `24350c4f-985e-4762-ac15-445f69009f18`, strategy
`208c227f-2485-488a-b9c3-920e5017ba28`. Worker request
`fa79737f-72ab-4921-834d-0e485bc520f3`, run
`4c405a50-6416-4afe-be93-d28b98773fef`.

The declaration dependency defect is repaired, and the current source and normal
build agree on **1.0.28**. Six focused regressions pass. This is source validation,
not installed-consumer acceptance or independent acceptance. A final commit
containing the complete corrected artifact **does not yet exist** as inspected.

## Current source and concurrent publication

Initial JS HEAD was `693459fc6dfc21b2f5b061a9c2693325e0c2805c`, with the existing
seven-file cleanup repair. The repair files and every retained evidence file
were checked by SHA256 and preserved. In particular, the prior patch remains
`9ef227a09bd35b783261a80b444293a5136bd62e8b530d8ea35c422335d3c8f0`, and its
manifest remains `f611904b1fd667cd61965b8abdda88b2d3595b8f2deb1a47c285ce79e809ff48`.
No historical patch was applied to this checkout. No merge/rebase/index lock was
present initially; deferred synchronization was not bypassed.

After successful 1.0.27 checks, an external concurrent process bumped metadata
and the SDK-root lock to 1.0.28, staged pending files, and committed/published
`5dde4e190e14b867069e87fd7d5f47dddffde389`. Read-only public HTTPS `git ls-remote`
confirmed that new HEAD. That commit includes the dependency repair and tests,
but its generated source still says 1.0.27. This worker preserved that history
and metadata bump, then used the normal build to regenerate 1.0.28 and reran
the focused checks. The remaining source delta against this new publication
base is the generated version line. Historical 1.0.27 logs remain intact;
`*-1.0.28.log` and `rebuild-identity-1.0.28.json` are the current evidence.

This worker did not stage, commit, push, publish, reset, stash, fetch or alter
Git configuration. The concurrent publication is observed evidence, not a
worker-authorized action or a claim that the final artifact is published.

## Findings and changes

The scoped `handrail_current_context` reader confirmed the active project and
request. All four attached frozen owner memories were fetched and read. The
scoped `get_work_request` reader returned the independent QA request
`d56b4165-fe75-4b73-b663-734ca7ec9d96`, run
`5ca8ca5e-45e3-4651-ab23-60d5a4c50f20`; its canonical outcome is **failed**.
The canonical outcome and evidence references are retained in
`qa-finding-context.json`. A separate full worker-record reader was not exposed,
and the referenced local report was unavailable. Thus supplied full-record hash
`6bd3b39e0b5a4eecec10e24a425b26dcdb4c14e5a5f02d4dafd94aa0e8eea7d2` is not
independently rehashed here. The canonical findings themselves were read.

1. **TS7016 in server/testing declarations:** moved the existing exact
   `@types/pg@8.23.1` pin from `devDependencies` to `dependencies`.
   `npm install --package-lock-only --ignore-scripts --offline --no-audit
   --no-fund` regenerated only the SDK-root lock metadata: the root dependency
   move and removal of the package's `dev` flag. No resolved version or integrity
   changed for this repair. The separate concurrent 1.0.28 version changes were
   retained. Example and preview pins/locks were not edited.
2. **Generated identity drift:** normal `npm run build` executed generation,
   TypeScript compilation, and CSS copying. Package metadata, generated source,
   and compiled version now all equal 1.0.28. Generation was never disabled,
   and no archive or custom package was produced.
3. **Regression coverage:** added an isolated declaration-graph test and a
   compiled-version equality test. The declaration test copies emitted source
   artifacts outside the repository dependency ancestry, supplies only locked
   production dependencies plus explicitly identified host React types and
   their `csstype` dependency, and compiles every public typed export with
   `strict: true`, `skipLibCheck: false`, exact optional properties, and unchecked
   index access checking. SDK development dependency directories are excluded.
   Removing `@types/pg` must reproduce TS7016 in both
   `server/postgres-migrations.d.ts` and `testing/index.d.ts`.

The source fixture uses paths to emitted declarations. It is deliberately not
an SDK installation. Existing root compilation settings were not weakened;
their pre-existing `skipLibCheck: true` is not relied on for declaration
acceptance. No `any` shim or CSS declaration was added. Ordinary bundler CSS
declarations remain a separate consumer concern.

## Verification and reproduction

Node 22.23.1, npm 10.9.8, locked TypeScript 7.0.2. Commands ran sequentially,
Node tests at concurrency 1, retaining configured `VITEST_MAX_WORKERS=1`.
No unusual consumption, launch failure, or OOM was observed.

From the SDK root, after providing a writable temporary directory outside the
SDK's dependency ancestry:

```sh
npm run build
node --test --test-concurrency=1 test/public-declaration-dependencies.test.mjs test/package-version-generation.test.mjs
npm run check:package-version
python3 docs/validation/owner-task-24350c4f/package-repair-20260911/verify-rebuild.py 1.0.28
git diff --check
```

- Normal build/TypeScript compilation: passed (`build-1.0.28.log`).
- Focused regressions: 6 passed, 0 failed/skipped (`focused-tests-1.0.28.log`).
  Includes the successful strict compile and expected two-site TS7016 negative
  control; the latter is an asserted failure inside the passing test.
- Generated-version check: passed (`version-check-1.0.28.log`).
- Second normal build: passed, byte-identical across 649 emitted files and
  163 source files (`rebuild-identity-1.0.28.json`). No unexplained drift.
- New test syntax and diff whitespace checks: passed.
- Cumulative source patch reconstruction: passed in a disposable directory,
  all 12 affected file hashes matched; no Git repository initialized.
- Prior cleanup/evidence bytes, other tracked source, linked Flutter checkout
  revisions/status, and consumer pins/locks: preserved by hash comparisons.

The original stale-version check failed as expected (`baseline-version.log`).
Earlier successful 1.0.27 runs were repeated only because concurrent metadata
changed the artifact. Completed cleanup, PostgreSQL, Flutter compatibility,
runtime/browser, and evidence-import suites were not repeated.

## Exact artifact and Main action

Public Git repository: `https://github.com/c0x65o/handrail-sdk-chat-js.git`.
Current publication base: `5dde4e190e14b867069e87fd7d5f47dddffde389`.
Original cumulative base: `693459fc6dfc21b2f5b061a9c2693325e0c2805c`.

`artifact.json` lists every affected file and SHA256. Patch identities:

- `publication.patch`: remaining generated-source repair against current base,
  SHA256 `e2f23a66433d5dd8d7e1927905aa05c9c400db82d91f96f62737ecac09cf04b8`.
- `source.patch`: complete cumulative implementation/test delta (12 files)
  against original base, including preserved cleanup,
  SHA256 `d048002d26dfcdd1e0484cbd8110eff4e07aadac5de794ee48b1c26c7fe78ba6`.
- `package-repair.patch`: five package/version/regression files against original
  base, SHA256 `7006464fc9b32608885fe58d74ac827fe331486c118b71dfa446ea1025917c58`.
- Source digest: `bc3dca8bfa8173359a8aff1a213fa6ee9cb584805daf1e6ad074572ba2173619`
  (SHA256 of compact, sorted JSON of the 12-file hash map).

The five files changed in this repair are `package.json`, `package-lock.json`,
`src/client/generated/package-version.ts`,
`test/package-version-generation.test.mjs`, and
`test/public-declaration-dependencies.test.mjs`. The first, second and tests
are already in the concurrent commit. Only the generated version remains as
an implementation delta. Evidence additions/updates live in this directory;
their complete inventory and hashes are in `manifest-sha256.json`, separately
from implementation patches to avoid recursive patch hashes.

Main's next action is to review this exact artifact with the existing independent
reviewer, reconcile any further concurrent HEAD/metadata change, then under its
publication authority commit the generated-version correction and retain this
evidence. **Run normal generation/build after the final metadata version bump,
and include the resulting generated source in that same commit.** If metadata
changes again, regenerate and revalidate instead of committing the current
version line unchanged. Preserve example/preview committed-pin holds. Publish
that reviewed commit to the same public repository and return its actual full
40-character SHA; no final SHA is proposed or fabricated here.

After publication, the existing independent verifier must install from
`git+https://github.com/c0x65o/handrail-sdk-chat-js.git#<actual-final-40-character-SHA>`
with a matching disposable consumer lockfile and ordinary install/prepare/build
compilation, then prove clean `npm ci`, strict public declaration compilation,
and metadata/generated/compiled identity. Do not add consumer `@types/pg` to
mask the fix; it must arrive from SDK production dependencies. Host TypeScript
and React typings can be explicit consumer development tools. Retain the
existing `test:git-consumer` check as applicable, supplemented by strict
installed-declaration and version checks and recorded package/lock provenance.
No archive/file/workspace/registry SDK substitute qualifies. The prior archive
installation success is diagnostic history only.

Publication of the exact corrected artifact and independent Git-consumer
verification remain the next acceptance boundary. Only after that should Main
consider its separately controlled runtime handoff and live React/Flutter
default/Discord save/read/reload/reconnect/failed-save slice. Worker completion
does not accept the owner task.

## Preserved limits and evidence

No database connections, imports, provisioning, managed-resource actions,
service startup, generated environment changes, raw browser access, external
messages, deployments or ERP edits occurred. Managed PostgreSQL health recorded
by Main did not grant this worker resource authority. Service
`812c4054-6ced-4616-94fb-13f672b3e897` was not started. No database or queue state
was modified by this worker.

Retain prior passing cleanup/PostgreSQL/Flutter receipts, accepted planning-only
Hitcents integration recipe, historical inconclusive QA and media, fixture
provenance, native accessibility limitations and 4px Send-padding limitation.
Hitcents remains read-only. Overall SDK/live/native/adoption readiness is not
accepted, and the changed artifact still requires independent review.
