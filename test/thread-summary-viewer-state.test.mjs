import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

let temporaryRoot;
let projectThreadSummaryForViewer;

before(async () => {
  // Compile current production source without touching dist or generated source.
  // Staying under the package preserves its ESM configuration for read-state.js.
  temporaryRoot = await mkdtemp(
    fileURLToPath(new URL(".thread-summary-viewer-", import.meta.url)),
  );
  const outfile = join(temporaryRoot, "client/read-state.js");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/client/read-state.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
  ({ projectThreadSummaryForViewer } = await import(pathToFileURL(outfile).href));
});

after(async () => {
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

const facts = deepFreeze({
  threadId: "thread-1",
  replyCount: 42,
  participantIds: ["viewer-1", "viewer-2"],
  lastReplyAt: "2030-01-01T00:00:10.000Z",
});
const cursor = deepFreeze({
  conversationId: "thread-1",
  userId: "viewer-1",
  lastReadSequence: 4,
  updatedAt: "2030-01-01T00:00:04.000Z",
});
const sequenceCoverage = deepFreeze({
  threadId: "thread-1",
  complete: true,
  latestSequence: 10,
});
const basis = deepFreeze({
  expectedUserId: "viewer-1",
  expectedThreadId: "thread-1",
  membershipActive: true,
  following: false,
  cursor,
  sequenceCoverage,
});

function assertProjection(inputFacts, inputBasis, expectedUnreadCount) {
  const beforeFacts = structuredClone(inputFacts);
  const beforeBasis = structuredClone(inputBasis);
  deepFreeze(inputFacts);
  deepFreeze(inputBasis);

  const result = projectThreadSummaryForViewer(inputFacts, inputBasis);

  assert.equal(result.unreadCount, expectedUnreadCount);
  assert.deepEqual(result, { ...beforeFacts, unreadCount: expectedUnreadCount });
  assert.notStrictEqual(result, inputFacts);
  assert.deepEqual(inputFacts, beforeFacts);
  assert.deepEqual(inputBasis, beforeBasis);
}

test("identical shared facts project each viewer's cursor and manual marker", async (t) => {
  const markedCursor = { ...cursor, lastReadSequence: 10, manualUnreadFromSequence: 8 };
  const { manualUnreadFromSequence: _marker, ...clearedCursor } = markedCursor;
  const cases = [
    ["N=10, viewer-1 R=10 => 0", { ...cursor, lastReadSequence: 10 }, 0],
    ["N=10, viewer-2 R=4 => 6", { ...cursor, userId: "viewer-2" }, 6],
    ["N=10, R=10, M=8 => 3", markedCursor, 3],
    ["removing M=8 at R=10 => 0", clearedCursor, 0],
    ["cursor R=12 ahead of N=10 clamps to 0", { ...cursor, lastReadSequence: 12 }, 0],
  ];
  for (const [name, viewerCursor, expected] of cases) {
    await t.test(name, () => {
      assertProjection(facts, {
        ...basis,
        expectedUserId: viewerCursor.userId,
        cursor: viewerCursor,
      }, expected);
    });
  }
});

test("eligibility and authoritative viewer/thread coverage determine number or null", async (t) => {
  const eligibilityCases = [
    [true, true, 6],
    [true, false, 6],
    [false, true, 6],
    [true, null, 6],
    [null, true, 6],
    [false, false, 0],
    [false, null, null],
    [null, false, null],
    [null, null, null],
  ];
  for (const [membershipActive, following, expected] of eligibilityCases) {
    await t.test(`membership=${membershipActive}, following=${following} => ${expected}`, () => {
      assertProjection(facts, { ...basis, membershipActive, following }, expected);
    });
  }

  const { cursor: _cursor, sequenceCoverage: _coverage, ...unprovenBasis } = basis;
  const cases = [
    ["both false without cursor or coverage => 0", {
      ...unprovenBasis, membershipActive: false, following: false,
    }, 0],
    ["absent cursor => null", { ...unprovenBasis, sequenceCoverage }, null],
    ["wrong cursor user => null", {
      ...basis, cursor: { ...cursor, userId: "other-user" },
    }, null],
    ["wrong cursor conversation => null", {
      ...basis, cursor: { ...cursor, conversationId: "other-thread" },
    }, null],
    ["absent proven coverage => null", { ...unprovenBasis, cursor }, null],
    ["incomplete coverage => null", {
      ...basis, sequenceCoverage: { ...sequenceCoverage, complete: false },
    }, null],
    ["coverage without completeness assertion => null", {
      ...basis, sequenceCoverage: { threadId: "thread-1", latestSequence: 10 },
    }, null],
    ["wrong coverage thread => null", {
      ...basis, sequenceCoverage: { ...sequenceCoverage, threadId: "other-thread" },
    }, null],
    ["expected thread differs from facts => null", {
      ...basis,
      expectedThreadId: "other-thread",
      cursor: { ...cursor, conversationId: "other-thread" },
      sequenceCoverage: { ...sequenceCoverage, threadId: "other-thread" },
    }, null],
  ];
  for (const [name, viewerBasis, expected] of cases) {
    await t.test(name, () => assertProjection(facts, viewerBasis, expected));
  }

  for (const replyCount of [0, 42]) {
    for (const [missing, viewerBasis] of [
      ["cursor", { ...unprovenBasis, sequenceCoverage }],
      ["coverage", { ...unprovenBasis, cursor }],
      ["cursor and coverage", unprovenBasis],
    ]) {
      await t.test(`replyCount=${replyCount} cannot supply ${missing} => null`, () => {
        assertProjection({ ...facts, replyCount }, viewerBasis, null);
      });
    }
  }
});

test("preserves shared facts and nested inputs; legacy sender unread has no authority", async (t) => {
  const { lastReplyAt: _lastReplyAt, ...factsWithoutLastReply } = facts;
  const cases = [
    ["computed unread", basis, 6],
    ["computed zero", { ...basis, cursor: { ...cursor, lastReadSequence: 10 } }, 0],
    ["manual unread", {
      ...basis, cursor: { ...cursor, lastReadSequence: 10, manualUnreadFromSequence: 8 },
    }, 3],
    ["unknown unread", { ...basis, cursor: undefined }, null],
  ];
  for (const sharedFacts of [facts, factsWithoutLastReply]) {
    for (const legacyUnreadCount of [0, 999]) {
      for (const [name, viewerBasis, expected] of cases) {
        await t.test(`${name} => ${expected}, legacy=${legacyUnreadCount}, lastReplyAt=${"lastReplyAt" in sharedFacts}`, () => {
          assertProjection({ ...sharedFacts, unreadCount: legacyUnreadCount }, viewerBasis, expected);
        });
      }
    }
  }
});
