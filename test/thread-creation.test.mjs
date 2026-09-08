import assert from "node:assert/strict";
import test from "node:test";

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

// Exercise current source and public exports without a full build or stale dist.
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(join(repositoryRoot, ".thread-creation-test-"));
let contracts;
try {
  const outfile = join(temporaryRoot, "contracts.mjs");
  await build({
    stdin: {
      contents: `
        export { ThreadCreationParseError, createConversationSnapshotMetadata,
          parseThreadCreationInput, parseThreadCreationResult } from "./src/index.ts";
        export { parseThreadCreationInput as clientParseInput } from "./src/client/index.ts";
        export { parseThreadCreationResult as serverParseResult } from "./src/server/index.ts";
      `,
      resolveDir: repositoryRoot,
      loader: "ts",
    },
    outfile, bundle: true, packages: "external", format: "esm",
    platform: "node", target: "node22",
  });
  contracts = await import(pathToFileURL(outfile).href);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
const {
  ThreadCreationParseError, createConversationSnapshotMetadata,
  parseThreadCreationInput, parseThreadCreationResult,
} = contracts;

const now = "2026-08-25T20:00:00.000Z";
const input = {
  operation: "create_thread",
  parentConversationId: "conversation-parent",
  rootMessageId: "message-root",
  initialFollow: true,
  idempotencyKey: "create-thread-1",
};
const metadata = createConversationSnapshotMetadata({
  packageVersion: "0.1.3",
  protocolVersion: 1,
  schemaVersion: 1,
  enabledFeatures: { threadCreation: true },
});

function threadDetail(overrides = {}) {
  const id = overrides.id ?? "conversation-thread";
  return {
    kind: "conversation_detail",
    conversation: {
      id,
      tenantId: "tenant-from-session",
      type: "thread",
      visibility: "private",
      parentConversationId: input.parentConversationId,
      rootMessageId: input.rootMessageId,
      createdAt: now,
      updatedAt: now,
      activityAt: now,
      latestSequence: 0,
      unreadMentionCount: 0,
      activeMemberUserIds: ["user-actor"],
      currentMember: {
        tenantId: "tenant-from-session",
        conversationId: id,
        userId: "user-actor",
        role: "owner",
        state: "active",
        joinedAt: now,
        updatedAt: now,
      },
      currentReadState: {
        conversationId: id,
        userId: "user-actor",
        lastReadSequence: 0,
        updatedAt: now,
      },
      memberUserIds: ["user-actor"],
      currentPreference: {
        conversationId: id,
        userId: "user-actor",
        notificationPreference: "all",
        isStarred: false,
        mute: { muted: false },
        updatedAt: now,
      },
      ...overrides,
    },
    _meta: metadata,
  };
}

function result(reconciliationStatus = "created") {
  return {
    operation: "create_thread",
    reconciliationStatus,
    parentConversationId: input.parentConversationId,
    rootMessageId: input.rootMessageId,
    conversation: threadDetail(),
    rootThreadSummary: {
      threadId: "conversation-thread",
      replyCount: 0,
      participantIds: [],
      unreadCount: 0,
    },
  };
}

function assertParseError(code) {
  return (error) =>
    error instanceof ThreadCreationParseError && error.code === code;
}

test("parses a valid thread root reference and optional initial follow intent", () => {
  assert.deepEqual(parseThreadCreationInput(input), input);
  assert.deepEqual(
    parseThreadCreationInput({ ...input, initialFollow: false }).initialFollow,
    false,
  );
  assert.equal(
    contracts.clientParseInput,
    parseThreadCreationInput,
  );
  assert.equal(
    contracts.serverParseResult,
    parseThreadCreationResult,
  );
});

test("rejects absent or blank root identifiers and idempotency keys", () => {
  const { parentConversationId: _parent, ...withoutParent } = input;
  const { rootMessageId: _root, ...withoutRoot } = input;
  const { idempotencyKey: _idempotency, ...withoutIdempotency } = input;

  for (const invalid of [
    withoutParent,
    withoutRoot,
    withoutIdempotency,
    { ...input, parentConversationId: " " },
    { ...input, rootMessageId: "\n" },
    { ...input, idempotencyKey: "\t" },
  ]) {
    assert.throws(
      () => parseThreadCreationInput(invalid),
      assertParseError("malformed_input"),
    );
  }
});

test("rejects normalized client tenant, actor, session, and authorization fields", () => {
  const spoofed = [
    ["tenantId", "tenant-spoof"],
    ["organization_id", "organization-spoof"],
    ["Actor-User-ID", "user-spoof"],
    ["current.user.id", "user-spoof"],
    ["session-id", "session-spoof"],
    ["authorization", "Bearer spoof"],
    ["roles", ["admin"]],
    ["capabilities", ["chat.admin"]],
  ];

  for (const [field, value] of spoofed) {
    assert.throws(
      () => parseThreadCreationInput({ ...input, [field]: value }),
      assertParseError("trusted_identity_field"),
      field,
    );
  }
});

test("created, existing-for-root, and replayed outcomes share one canonical shape", () => {
  const statuses = ["created", "existing_for_root", "replayed"];
  const parsed = statuses.map((status) =>
    parseThreadCreationResult(
      JSON.parse(JSON.stringify(result(status))),
      input,
    ),
  );

  for (const [index, value] of parsed.entries()) {
    assert.equal(value.reconciliationStatus, statuses[index]);
    assert.equal(value.conversation.conversation.id, "conversation-thread");
    assert.equal(value.rootThreadSummary.threadId, "conversation-thread");
    assert.deepEqual(Object.keys(value).sort(), Object.keys(parsed[0]).sort());
  }

  const canonicalState = ({ reconciliationStatus: _status, ...value }) => value;
  assert.deepEqual(canonicalState(parsed[0]), canonicalState(parsed[1]));
  assert.deepEqual(canonicalState(parsed[1]), canonicalState(parsed[2]));
});

test("rejects absent or mismatched result root identifiers", () => {
  const valid = result();
  const { parentConversationId: _parent, ...withoutParent } = valid;
  const { rootMessageId: _root, ...withoutRoot } = valid;

  for (const malformed of [withoutParent, withoutRoot]) {
    assert.throws(
      () => parseThreadCreationResult(malformed, input),
      assertParseError("malformed_result"),
    );
  }

  for (const incoherent of [
    { ...valid, parentConversationId: "conversation-other" },
    { ...valid, rootMessageId: "message-other" },
    {
      ...valid,
      conversation: threadDetail({
        parentConversationId: "conversation-other",
      }),
    },
    {
      ...valid,
      conversation: threadDetail({ rootMessageId: "message-other" }),
    },
  ]) {
    assert.throws(
      () => parseThreadCreationResult(incoherent, input),
      assertParseError("incoherent_result"),
    );
  }
});

test("requires the root summary to identify the returned thread conversation", () => {
  assert.throws(
    () =>
      parseThreadCreationResult(
        {
          ...result("existing_for_root"),
          rootThreadSummary: {
            ...result().rootThreadSummary,
            threadId: "conversation-other-thread",
          },
        },
        input,
      ),
    assertParseError("incoherent_result"),
  );
});

const validNames = [
  "Launch 🚀", "🚀", "a".repeat(100), "🚀".repeat(100),
  "e\u0301".repeat(50), "a  b", "a\u0085b", "\u200b", "\u180e",
];
const malformedNames = [
  null, 42, true, [], {}, "", " ", "  \t\n", " leading", "trailing ",
  "a".repeat(101), "🚀".repeat(101), "e\u0301".repeat(51),
  "\ud800", "\udfff", "x\ud800y",
];

test("named and unnamed inputs round-trip without changing names or follow intent", () => {
  for (const name of [undefined, ...validNames]) {
    for (const initialFollow of [undefined, false, true]) {
      const wire = { ...input };
      delete wire.initialFollow;
      if (name !== undefined) wire.name = name;
      if (initialFollow !== undefined) wire.initialFollow = initialFollow;
      const parsed = parseThreadCreationInput(JSON.parse(JSON.stringify(wire)));
      assert.deepEqual(parsed, wire);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), wire);
      assert.equal(Object.hasOwn(parsed, "name"), name !== undefined);
    }
  }
});

test("malformed supplied names retain the malformed_input error category", () => {
  for (const name of malformedNames) {
    assert.throws(
      () => parseThreadCreationInput(JSON.parse(JSON.stringify({ ...input, name }))),
      assertParseError("malformed_input"),
      JSON.stringify(name),
    );
  }
});

test("creation names use frozen edge whitespace without trimming internal whitespace", () => {
  const whitespace = [9, 10, 11, 12, 13, 32, 133, 160, 5760,
    8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
    8232, 8233, 8239, 8287, 12288, 65279];
  for (const point of whitespace) {
    const space = String.fromCodePoint(point);
    for (const name of [space, `${space}Launch`, `Launch${space}`]) {
      assert.throws(() => parseThreadCreationInput({ ...input, name }),
        assertParseError("malformed_input"));
    }
    const name = `a${space}b`;
    assert.equal(parseThreadCreationInput({ ...input, name }).name, name);
  }
});

for (const status of ["created", "existing_for_root", "replayed"]) {
  test(`${status} retains the authoritative named result and ID`, () => {
    for (const name of validNames) {
      const wire = result(status);
      wire.conversation = threadDetail({ id: "canonical-thread", name });
      wire.rootThreadSummary.threadId = "canonical-thread";
      for (const request of [input, { ...input, name: "Proposed different name" }]) {
        const parsed = parseThreadCreationResult(JSON.parse(JSON.stringify(wire)), request);
        assert.equal(parsed.conversation.conversation.name, name);
        assert.equal(parsed.conversation.conversation.id, "canonical-thread");
        assert.deepEqual(JSON.parse(JSON.stringify(parsed)), wire);
        assert.deepEqual(parseThreadCreationResult(parsed, request), parsed);
      }
    }
  });
}

test("a proposed name never fills in an authoritative unnamed existing or replayed thread", () => {
  for (const status of ["existing_for_root", "replayed"]) {
    const parsed = parseThreadCreationResult(result(status), { ...input, name: "Proposal" });
    assert.equal(Object.hasOwn(parsed.conversation.conversation, "name"), false);
    assert.equal(parsed.conversation.conversation.id, "conversation-thread");
  }
});

test("malformed result names retain snapshot validation and malformed_result errors", () => {
  for (const name of malformedNames) {
    assert.throws(
      () => parseThreadCreationResult({ ...result(), conversation: threadDetail({ name }) }, input),
      assertParseError("malformed_result"),
    );
  }
});
