import {
  createHostDirectorySnapshotMetadata,
  encodeHostDirectorySearchCursor,
  parseHostDirectoryBatchLookupInput,
  parseHostDirectorySearchResult,
  type ActiveHostDirectoryUserSummary,
  type HostDirectoryBatchLookupInput,
  type HostDirectoryBatchLookupResult,
  type HostDirectorySearchInput,
  type HostDirectorySearchResult,
  type HostDirectoryUserSummary,
  type UserId,
} from "../src/index.js";
import {
  parseHostDirectorySearchInput as parseFromClient,
  type HostDirectoryUserSummary as ClientDirectoryUserSummary,
} from "../src/client/index.js";
import {
  parseHostDirectoryBatchLookupResult as parseFromServer,
  type HostDirectorySearchResult as ServerDirectorySearchResult,
} from "../src/server/index.js";

const userId = "host-user-1" as UserId;
const cursor = encodeHostDirectorySearchCursor({
  query: "avery",
  continuation: "opaque-host-page",
});
const metadata = createHostDirectorySnapshotMetadata({
  packageVersion: "0.1.2",
  protocolVersion: 1,
  schemaVersion: 0,
  enabledFeatures: { directorySearch: true },
});

const active: ActiveHostDirectoryUserSummary = {
  kind: "active",
  userId,
  displayName: "Avery",
  avatar: { kind: "image", url: "/api/users/avery/avatar", altText: "Avery" },
  status: { availability: "online", text: "Available", emoji: "👋" },
};
const redacted: HostDirectoryUserSummary = { kind: "redacted", userId };
const missing: HostDirectoryUserSummary = {
  kind: "unavailable",
  userId,
  reason: "missing",
};

const batchInput: HostDirectoryBatchLookupInput = { userIds: [userId] };
const searchInput: HostDirectorySearchInput = {
  query: "avery",
  cursor,
  limit: 20,
};
const batchResult: HostDirectoryBatchLookupResult<"directorySearch"> = {
  kind: "host_directory_batch",
  users: [active, redacted, missing],
  _meta: metadata,
};
const searchResult: HostDirectorySearchResult<"directorySearch"> = {
  kind: "host_directory_search",
  users: [active],
  page: { nextCursor: cursor },
  _meta: metadata,
};

const inputWithTenant: HostDirectorySearchInput = {
  query: "avery",
  // @ts-expect-error Tenant context is resolved from the trusted server actor.
  tenantId: "tenant-1",
};
const inputWithActor: HostDirectoryBatchLookupInput = {
  userIds: [userId],
  // @ts-expect-error Current actor identity cannot be client-authored.
  actor: { userId },
};
const inputWithCredential: HostDirectorySearchInput = {
  query: "avery",
  // @ts-expect-error Credentials are never directory request fields.
  accessToken: "secret",
};
const activeWithEmail: ActiveHostDirectoryUserSummary = {
  ...active,
  // @ts-expect-error Email is not part of the browser-shareable summary.
  email: "private@example.test",
};
const activeWithProfile: ActiveHostDirectoryUserSummary = {
  ...active,
  // @ts-expect-error Unrestricted host profile fields cannot be emitted.
  profile: { department: "Support" },
};
const activeWithStatusMetadata: ActiveHostDirectoryUserSummary = {
  ...active,
  status: {
    availability: "away",
    // @ts-expect-error Status accepts only the explicit bounded fields.
    metadata: { source: "host" },
  },
};
// @ts-expect-error Redacted users cannot expose profile display fields.
const redactedWithProfile: HostDirectoryUserSummary = {
  kind: "redacted",
  userId,
  displayName: "Private name",
};
const missingWithAvatar: HostDirectoryUserSummary = {
  kind: "unavailable",
  userId,
  reason: "missing",
  // @ts-expect-error Missing users cannot expose an avatar fallback.
  avatar: { kind: "none" },
};

const clientSummary: ClientDirectoryUserSummary = active;
const serverResult: ServerDirectorySearchResult<"directorySearch"> = searchResult;

parseHostDirectoryBatchLookupInput(batchInput);
parseHostDirectorySearchResult(searchResult);
parseFromClient(searchInput);
parseFromServer(batchResult);

void [
  inputWithTenant,
  inputWithActor,
  inputWithCredential,
  activeWithEmail,
  activeWithProfile,
  activeWithStatusMetadata,
  redactedWithProfile,
  missingWithAvatar,
  clientSummary,
  serverResult,
];
