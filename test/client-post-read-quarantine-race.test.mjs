import assert from "node:assert/strict";
import test from "node:test";

import {
  ApplicationChatStorageRecordKind,
  CHAT_CLIENT_PACKAGE_VERSION,
  createApplicationChatNormalizedSnapshotRecord,
  createApplicationChatQueuedConversationArchiveIntentsRecord,
  createApplicationChatQueuedConversationCreationIntentsRecord,
  createApplicationChatQueuedConversationMembershipIntentsRecord,
  createApplicationChatQueuedConversationPreferenceIntentsRecord,
  createApplicationChatQueuedMessageReminderIntentsRecord,
  createApplicationChatQueuedSavedMessageIntentsRecord,
  createApplicationChatQueuedThreadFollowIntentsRecord,
  createApplicationChatStorage,
  createChatClient,
  createNormalizedChatCache,
  encodeApplicationChatStorageRecord,
} from "../dist/client/index.js";
import { CHAT_PROTOCOL_VERSION } from "../dist/index.js";

const identity = Object.freeze({
  tenantId: "tenant-quarantine-race",
  userId: "user-quarantine-race",
  deviceId: "device-quarantine-race",
});
const siblingIdentity = Object.freeze({
  tenantId: identity.tenantId,
  userId: "sibling-user-quarantine-race",
  deviceId: "sibling-device-quarantine-race",
});
const cacheIdentity = Object.freeze({
  tenantId: identity.tenantId,
  userId: identity.userId,
  sessionId: "session-quarantine-race",
});
const endpointSecret = "https://provider-endpoint-secret.invalid/api/chat";
const accessTokenSecret = "access-token-secret";
const fixtureSecrets = Object.freeze([
  "malformed-content-secret",
  accessTokenSecret,
  endpointSecret,
  "actor-private-email-secret@example.invalid",
  "actor-private-reminder-note-secret",
  "idempotency-key-secret",
  "other-fixture-secret",
]);

const recordKey = (scope, kind) =>
  `${scope.tenantId}\0${scope.userId}\0${scope.deviceId}\0${kind}`;
const metadata = Object.freeze({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: CHAT_PROTOCOL_VERSION,
  schemaVersion: 1,
  enabledFeatures: {},
  supportedProtocolRange: {
    minimumVersion: CHAT_PROTOCOL_VERSION,
    maximumVersion: CHAT_PROTOCOL_VERSION,
  },
});
const response = () => ({
  ok: true,
  status: 200,
  async json() { return metadata; },
});

const emptySnapshotRecord = (scope) => createApplicationChatNormalizedSnapshotRecord(
  scope,
  createNormalizedChatCache(cacheIdentity).getState(),
);

const cases = Object.freeze([
  {
    kind: ApplicationChatStorageRecordKind.normalizedSnapshot,
    code: "snapshot_rejected",
    message: "The stored normalized cache snapshot was rejected and quarantined.",
    replacement: emptySnapshotRecord,
  },
  {
    kind: ApplicationChatStorageRecordKind.queuedConversationCreationIntents,
    code: "conversation_creation_intents_rejected",
    message: "The stored conversation-creation intents were rejected and quarantined.",
    replacement: (scope) =>
      createApplicationChatQueuedConversationCreationIntentsRecord(scope, []),
  },
  {
    kind: ApplicationChatStorageRecordKind.queuedConversationMembershipIntents,
    code: "membership_intents_rejected",
    message: "The stored conversation-membership intents were rejected and quarantined.",
    replacement: (scope) =>
      createApplicationChatQueuedConversationMembershipIntentsRecord(scope, []),
  },
  {
    kind: ApplicationChatStorageRecordKind.queuedConversationPreferenceIntents,
    code: "conversation_preference_intents_rejected",
    message: "The stored conversation-preference intents were rejected and quarantined.",
    replacement: (scope) =>
      createApplicationChatQueuedConversationPreferenceIntentsRecord(scope, []),
  },
  {
    kind: ApplicationChatStorageRecordKind.queuedThreadFollowIntents,
    code: "thread_follow_intents_rejected",
    message: "The stored thread-follow intents were rejected and quarantined.",
    replacement: (scope) =>
      createApplicationChatQueuedThreadFollowIntentsRecord(scope, []),
  },
  {
    kind: ApplicationChatStorageRecordKind.queuedSavedMessageIntents,
    code: "saved_message_intents_rejected",
    message: "The stored saved-message intents were rejected and quarantined.",
    replacement: (scope) =>
      createApplicationChatQueuedSavedMessageIntentsRecord(scope, []),
  },
  {
    kind: ApplicationChatStorageRecordKind.queuedMessageReminderIntents,
    code: "message_reminder_intents_rejected",
    message: "The stored message-reminder intents were rejected and quarantined.",
    replacement: (scope) =>
      createApplicationChatQueuedMessageReminderIntentsRecord(scope, []),
  },
]);

const malformedRecord = (kind) => JSON.stringify({
  schemaVersion: 999,
  kind,
  identity,
  payload: {
    content: fixtureSecrets[0],
    accessToken: accessTokenSecret,
    endpoint: endpointSecret,
    actorPrivate: {
      email: fixtureSecrets[3],
      reminderNote: fixtureSecrets[4],
    },
    idempotencyKey: fixtureSecrets[5],
    other: fixtureSecrets[6],
  },
});

function createAtomicRaceHarness(testCase) {
  const rows = new Map();
  const calls = [];
  const targetKey = recordKey(identity, testCase.kind);
  const malformed = malformedRecord(testCase.kind);
  const validReplacement = encodeApplicationChatStorageRecord(
    testCase.replacement(identity),
  );
  const siblingKind = testCase.kind === ApplicationChatStorageRecordKind.normalizedSnapshot
    ? ApplicationChatStorageRecordKind.queuedConversationArchiveIntents
    : ApplicationChatStorageRecordKind.normalizedSnapshot;
  const siblingKindValue = encodeApplicationChatStorageRecord(
    siblingKind === ApplicationChatStorageRecordKind.normalizedSnapshot
      ? emptySnapshotRecord(identity)
      : createApplicationChatQueuedConversationArchiveIntentsRecord(identity, []),
  );
  const siblingIdentityKey = recordKey(siblingIdentity, testCase.kind);
  const siblingIdentityValue = `sibling-identity-row-secret:${testCase.kind}`;
  const siblingKindKey = recordKey(identity, siblingKind);

  rows.set(targetKey, malformed);
  rows.set(siblingIdentityKey, siblingIdentityValue);
  rows.set(siblingKindKey, siblingKindValue);

  const adapter = {
    async read(scope, kind) {
      calls.push({ operation: "read", scope: structuredClone(scope), kind });
      return rows.get(recordKey(scope, kind)) ?? null;
    },
    async replace(scope, kind, encoded) {
      calls.push({ operation: "replace", scope: structuredClone(scope), kind, encoded });
      rows.set(recordKey(scope, kind), encoded);
    },
    async remove(scope, kind) {
      calls.push({ operation: "remove", scope: structuredClone(scope), kind });
      rows.delete(recordKey(scope, kind));
    },
    async compareExchange(scope, kind, expected, replacement) {
      calls.push({
        operation: "compareExchange",
        scope: structuredClone(scope),
        kind,
        expected,
        replacement,
      });
      const key = recordKey(scope, kind);
      if ((rows.get(key) ?? null) !== expected) return false;
      if (replacement === null) rows.delete(key);
      else rows.set(key, replacement);
      if (key === targetKey && expected === malformed && replacement === null) {
        rows.set(key, validReplacement);
      }
      return true;
    },
    async clearForLogout() {},
  };

  return {
    calls,
    rows,
    storage: createApplicationChatStorage(adapter),
    targetKey,
    validReplacement,
    malformed,
    siblingIdentityKey,
    siblingIdentityValue,
    siblingKindKey,
    siblingKindValue,
  };
}

test("createChatClient preserves atomic replacements after malformed retained reads", async (t) => {
  for (const testCase of cases) {
    await t.test(testCase.kind, async () => {
      const harness = createAtomicRaceHarness(testCase);
      const diagnostics = [];
      const client = createChatClient({
        endpoint: endpointSecret,
        getAccessToken: () => accessTokenSecret,
        fetch: async () => response(),
        cache: createNormalizedChatCache(),
        normalizedCachePersistence: {
          storage: harness.storage,
          resolveIdentity: () => identity,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        },
      });

      assert.equal((await client.start()).state, "ready");
      assert.equal(harness.rows.get(harness.targetKey), harness.validReplacement);
      assert.equal(
        harness.rows.get(harness.siblingIdentityKey),
        harness.siblingIdentityValue,
      );
      assert.equal(harness.rows.get(harness.siblingKindKey), harness.siblingKindValue);
      assert.deepEqual(
        harness.calls.filter(({ operation }) => operation === "remove"),
        [],
      );
      assert.deepEqual(
        harness.calls.filter(({ operation, kind, expected, replacement }) =>
          operation === "compareExchange" &&
          kind === testCase.kind &&
          expected === harness.malformed &&
          replacement === null),
        [{
          operation: "compareExchange",
          scope: identity,
          kind: testCase.kind,
          expected: harness.malformed,
          replacement: null,
        }],
      );
      assert.deepEqual(diagnostics, [{ code: testCase.code, message: testCase.message }]);
      const encodedDiagnostics = JSON.stringify(diagnostics);
      for (const secret of fixtureSecrets) {
        assert.equal(encodedDiagnostics.includes(secret), false, secret);
      }
      client.close();
    });
  }
});
