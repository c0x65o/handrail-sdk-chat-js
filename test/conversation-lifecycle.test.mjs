import assert from "node:assert/strict";
import test from "node:test";
import {
  validateConversationThreadLifecycle,
  validateThreadLifecycle,
} from "../src/contracts/conversation.ts";

const closure = {
  closedAt: "2026-09-06T12:00:00.000Z",
  closedByUserId: "user-closer",
};
const thread = {
  id: "thread-1", tenantId: "tenant-1", type: "thread", visibility: "private",
  createdAt: "2026-09-06T10:00:00.000Z", updatedAt: "2026-09-06T11:00:00.000Z",
  parentConversationId: "parent-1", rootMessageId: "message-1", name: "Launch 🚀",
};
const states = [
  { revision: 1, locked: false },
  { revision: 2, locked: false, ...closure },
  { revision: Number.MAX_SAFE_INTEGER, locked: true, ...closure },
];

test("lifecycle round-trips preserve absence, names, IDs, and independent archive", () => {
  for (const state of [undefined, ...states]) {
    for (const archive of [{}, {
      archivedAt: "2026-09-06T13:00:00.000Z", archivedByUserId: "user-archiver",
    }]) {
      const wire = { ...thread, ...archive, ...(state ? { threadLifecycle: state } : {}) };
      const decoded = JSON.parse(JSON.stringify(wire));
      const validated = validateConversationThreadLifecycle(decoded);
      assert.deepEqual(validated, state);
      const result = { ...decoded, ...(validated ? { threadLifecycle: validated } : {}) };
      assert.deepEqual(result, wire);
      assert.equal(Object.hasOwn(result, "threadLifecycle"), state !== undefined);
    }
  }
});

test("lifecycle is forbidden on every nonthread even when supplied as null or undefined", () => {
  for (const type of ["channel", "direct", "group_direct"]) {
    assert.equal(validateConversationThreadLifecycle({ type }), undefined);
    for (const threadLifecycle of [...states, null, undefined]) {
      assert.throws(() => validateConversationThreadLifecycle({ type, threadLifecycle }), TypeError);
    }
  }
});

test("lifecycle rejects malformed revisions, field types, closure pairs, and locked/open", () => {
  const invalid = [undefined, null, false, 1, "open", [], {},
    { locked: false }, { revision: 1 },
    ...[undefined, null, "1", true, 0, -1, 1.5, NaN, Infinity, -Infinity,
      Number.MAX_SAFE_INTEGER + 1].map((revision) => ({ revision, locked: false })),
    ...[undefined, null, 0, 1, "false", [], {}].map((locked) => ({ revision: 1, locked })),
    { revision: 1, locked: true },
    { revision: 1, locked: false, closedAt: closure.closedAt },
    { revision: 1, locked: false, closedByUserId: closure.closedByUserId },
    ...[null, undefined, false, 42, [], {}].flatMap((value) => [
      { revision: 1, locked: false, ...closure, closedAt: value },
      { revision: 1, locked: true, ...closure, closedByUserId: value },
      { revision: 1, locked: false, closedAt: value, closedByUserId: value },
    ]),
    { revision: 1, locked: false, hidden: true },
    { revision: 1, locked: false, archivedAt: closure.closedAt },
  ];
  for (const value of invalid) {
    assert.throws(() => validateThreadLifecycle(value), TypeError);
    assert.throws(() => validateConversationThreadLifecycle({ ...thread, threadLifecycle: value }), TypeError);
  }
});
