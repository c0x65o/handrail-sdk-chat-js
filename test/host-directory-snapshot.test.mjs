import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_DIRECTORY_SNAPSHOT_FEATURE,
  HOST_DIRECTORY_SNAPSHOT_VERSION,
  MAX_HOST_DIRECTORY_BATCH_SIZE,
  MAX_HOST_DIRECTORY_QUERY_LENGTH,
  HostDirectorySnapshotParseError,
  createHostDirectorySnapshotMetadata,
  decodeHostDirectorySearchCursor,
  encodeHostDirectorySearchCursor,
  parseHostDirectoryBatchLookupInput,
  parseHostDirectoryBatchLookupResult,
  parseHostDirectorySearchInput,
  parseHostDirectorySearchResult,
} from "../dist/client/index.js";
import * as serverContracts from "../dist/server/index.js";
import {
  activeDirectoryUsers,
  directoryUsers,
  hostDirectoryMetadata,
  missingDirectoryUser,
  redactedDirectoryUser,
} from "./fixtures/host-directory-snapshots.mjs";

const cursor = encodeHostDirectorySearchCursor({
  query: "av",
  continuation: "opaque-provider-page-2",
});

test("JSON-round-trips active, redacted, missing, and unavailable batch summaries", () => {
  const snapshot = {
    kind: "host_directory_batch",
    users: directoryUsers,
    _meta: hostDirectoryMetadata,
  };

  assert.deepEqual(
    parseHostDirectoryBatchLookupResult(JSON.parse(JSON.stringify(snapshot))),
    snapshot,
  );
  assert.deepEqual(
    activeDirectoryUsers.map(({ avatar }) => avatar.kind),
    ["image", "initials", "none", "image"],
  );
  assert.equal("displayName" in redactedDirectoryUser, false);
  assert.equal("displayName" in missingDirectoryUser, false);
});

test("JSON-round-trips paginated search and host-supplied optional statuses", () => {
  const snapshot = {
    kind: "host_directory_search",
    users: activeDirectoryUsers,
    page: { nextCursor: cursor },
    _meta: hostDirectoryMetadata,
  };

  assert.deepEqual(
    parseHostDirectorySearchResult(JSON.parse(JSON.stringify(snapshot))),
    snapshot,
  );
  assert.deepEqual(activeDirectoryUsers[0].status, {
    availability: "online",
    text: "Helping customers",
    emoji: "👋",
    expiresAt: "2026-08-25T23:00:00.000Z",
  });
});

test("accepts bounded unique batch IDs and rejects duplicates or oversized batches", () => {
  assert.deepEqual(
    parseHostDirectoryBatchLookupInput({ userIds: ["host-user-a", "host-user-b"] }),
    { userIds: ["host-user-a", "host-user-b"] },
  );
  assert.throws(
    () => parseHostDirectoryBatchLookupInput({ userIds: ["host-user-a", "host-user-a"] }),
    hasCode("duplicate_user_id"),
  );
  assert.throws(
    () =>
      parseHostDirectoryBatchLookupInput({
        userIds: Array.from(
          { length: MAX_HOST_DIRECTORY_BATCH_SIZE + 1 },
          (_, index) => `host-user-${index}`,
        ),
      }),
    hasCode("batch_limit_exceeded"),
  );

  const result = {
    kind: "host_directory_batch",
    users: [activeDirectoryUsers[0], activeDirectoryUsers[0]],
    _meta: hostDirectoryMetadata,
  };
  assert.throws(
    () => parseHostDirectoryBatchLookupResult(result),
    hasCode("duplicate_user_id"),
  );
  assert.throws(
    () =>
      parseHostDirectoryBatchLookupResult({
        ...result,
        users: Array.from(
          { length: MAX_HOST_DIRECTORY_BATCH_SIZE + 1 },
          (_, index) => ({
            kind: "redacted",
            userId: `host-result-user-${index}`,
          }),
        ),
      }),
    hasCode("batch_limit_exceeded"),
  );
});

test("validates bounded search input and query-bound opaque cursors", () => {
  assert.deepEqual(decodeHostDirectorySearchCursor(cursor), {
    query: "av",
    continuation: "opaque-provider-page-2",
  });
  assert.deepEqual(parseHostDirectorySearchInput({ query: "av", cursor, limit: 25 }), {
    query: "av",
    cursor,
    limit: 25,
  });
  assert.throws(
    () => parseHostDirectorySearchInput({ query: "different", cursor }),
    hasCode("cursor_query_mismatch"),
  );
  assert.throws(
    () => parseHostDirectorySearchInput({ query: "x".repeat(MAX_HOST_DIRECTORY_QUERY_LENGTH + 1) }),
    hasCode("query_limit_exceeded"),
  );
  assert.throws(
    () => parseHostDirectorySearchInput({ query: "av", limit: 101 }),
    hasCode("query_limit_exceeded"),
  );
});

test("rejects malformed and unsupported directory cursors", () => {
  const malformed = [
    "",
    "not-a-cursor",
    "handrail-host-directory.v1.%",
    `handrail-host-directory.v1.${encodeURIComponent(JSON.stringify(["av"]))}`,
    `handrail-host-directory.v1.${encodeURIComponent(JSON.stringify(["", "page-2"]))}`,
  ];
  for (const value of malformed) {
    assert.throws(() => decodeHostDirectorySearchCursor(value), hasCode("malformed_cursor"));
  }

  assert.throws(
    () =>
      decodeHostDirectorySearchCursor(
        `handrail-host-directory.v2.${encodeURIComponent(JSON.stringify(["av", "page-2"]))}`,
      ),
    hasCode("unsupported_cursor"),
  );
});

test("rejects trusted and sensitive fields in client inputs at any depth", () => {
  const inputs = [
    { userIds: ["host-user-a"], tenantId: "spoofed" },
    { query: "av", actor: { userId: "spoofed" } },
    { query: "av", filters: { organization_id: "spoofed" } },
    { query: "av", accessToken: "secret" },
    { query: "av", profile: { department: "finance" } },
  ];
  for (const input of inputs) {
    const parser = "userIds" in input
      ? parseHostDirectoryBatchLookupInput
      : parseHostDirectorySearchInput;
    assert.throws(() => parser(input), hasCode("forbidden_field"));
  }
});

test("never emits trusted or sensitive result fields at top or nested levels", () => {
  const base = {
    kind: "host_directory_batch",
    users: [activeDirectoryUsers[0]],
    _meta: hostDirectoryMetadata,
  };
  const snapshots = [
    { ...base, tenantId: "tenant-1" },
    { ...base, roles: ["admin"] },
    { ...base, users: [{ ...activeDirectoryUsers[0], email: "private@example.test" }] },
    {
      ...base,
      users: [{
        ...activeDirectoryUsers[0],
        avatar: { ...activeDirectoryUsers[0].avatar, metadata: { source: "host" } },
      }],
    },
    {
      ...base,
      users: [{
        ...activeDirectoryUsers[0],
        status: { ...activeDirectoryUsers[0].status, capabilities: ["manage_users"] },
      }],
    },
  ];
  for (const snapshot of snapshots) {
    assert.throws(
      () => parseHostDirectoryBatchLookupResult(snapshot),
      hasCode("forbidden_field"),
    );
  }
});

test("strictly rejects unsupported result fields and unsafe avatar URLs", () => {
  const snapshotWithUser = (user) => ({
    kind: "host_directory_batch",
    users: [user],
    _meta: hostDirectoryMetadata,
  });
  assert.throws(
    () =>
      parseHostDirectoryBatchLookupResult(
        snapshotWithUser({ ...activeDirectoryUsers[0], department: "Support" }),
      ),
    hasCode("malformed_snapshot"),
  );
  for (const url of ["javascript:alert(1)", "http://assets.example.test/a.png", "//evil.test/a.png"]) {
    assert.throws(
      () =>
        parseHostDirectoryBatchLookupResult(
          snapshotWithUser({
            ...activeDirectoryUsers[0],
            avatar: { kind: "image", url },
          }),
        ),
      hasCode("malformed_snapshot"),
    );
  }
});

test("exports aligned metadata and identical codecs through client and server entries", () => {
  const metadata = createHostDirectorySnapshotMetadata({
    packageVersion: "0.1.2",
    protocolVersion: 1,
    schemaVersion: 0,
    enabledFeatures: { directorySearch: true },
  });
  assert.deepEqual(metadata.feature, {
    name: HOST_DIRECTORY_SNAPSHOT_FEATURE,
    version: HOST_DIRECTORY_SNAPSHOT_VERSION,
  });
  assert.equal(
    serverContracts.parseHostDirectorySearchResult,
    parseHostDirectorySearchResult,
  );
  assert.equal(
    serverContracts.encodeHostDirectorySearchCursor,
    encodeHostDirectorySearchCursor,
  );
});

function hasCode(code) {
  return (error) =>
    error instanceof HostDirectorySnapshotParseError && error.code === code;
}
