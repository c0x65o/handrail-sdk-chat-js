import type {
  ChatAuthAdapter,
  ChatHostAdapters,
  ChatNotificationInput,
  ChatNotificationTarget,
  ChatProtectedPushToken,
  ChatPushTokenProtectInput,
  ChatPushTokenProtector,
  ChatPushTokenUnprotectInput,
  TrustedChatActorContext,
  TrustedChatMutationRequest,
  UntrustedChatMutationInput,
} from "../src/server/index.js";
import {
  MAX_CHAT_PUSH_TOKEN_CIPHERTEXT_UTF8_BYTES,
  MAX_CHAT_PUSH_TOKEN_KEY_ID_UTF8_BYTES,
  finalizeAttachment,
  type ChatStorageObjectVerification,
} from "../src/server/index.js";
import type {
  AttachmentId,
  ConversationId,
  DeviceId,
  OpaquePushToken,
  TenantId,
  UserId,
} from "../src/index.js";

const tenantId = "tenant-1" as TenantId;
const userId = "user-1" as UserId;
const attachmentId = "attachment-1" as AttachmentId;
const conversationId = "conversation-1" as ConversationId;
const deviceId = "device-1" as DeviceId;
const providerToken = "opaque-provider-token" as OpaquePushToken;
const actor: TrustedChatActorContext = {
  tenantId,
  userId,
  roles: ["employee"],
};
const verifiedObject: ChatStorageObjectVerification = {
  status: "verified",
  exists: true,
  sizeBytes: 42,
  checksum: `sha256:${"a".repeat(64)}`,
  contentType: "application/pdf",
  safetyDisposition: "accepted",
};
const maximumCiphertextBytes: 4_096 =
  MAX_CHAT_PUSH_TOKEN_CIPHERTEXT_UTF8_BYTES;
const maximumKeyIdBytes: 255 = MAX_CHAT_PUSH_TOKEN_KEY_ID_UTF8_BYTES;
const protectedToken: ChatProtectedPushToken = {
  ciphertext: "opaque-encrypted-envelope",
  keyId: "kms-key-1",
};
const protectInput: ChatPushTokenProtectInput = {
  tenantId,
  userId,
  deviceId,
  token: providerToken,
};
const unprotectInput: ChatPushTokenUnprotectInput = {
  tenantId,
  userId,
  deviceId,
  protectedToken,
};

// @ts-expect-error Trusted tenant and user context is required for protection.
const missingTrustedProtectionContext: ChatPushTokenProtectInput = {
  deviceId,
  token: providerToken,
};
const pushTokenProtector: ChatPushTokenProtector = {
  async protect(input) {
    const trustedContext: readonly [TenantId, UserId, DeviceId] = [
      input.tenantId,
      input.userId,
      input.deviceId,
    ];
    const token: OpaquePushToken = input.token;
    void [trustedContext, token];
    return protectedToken;
  },
  async unprotect(input) {
    const trustedContext: readonly [TenantId, UserId, DeviceId] = [
      input.tenantId,
      input.userId,
      input.deviceId,
    ];
    const encrypted: ChatProtectedPushToken = input.protectedToken;
    void [trustedContext, encrypted];
    return providerToken;
  },
};

// @ts-expect-error A protector must provide both protect and unprotect.
const missingProtect: ChatPushTokenProtector = {
  async unprotect() {
    return providerToken;
  },
};

// @ts-expect-error A protector must provide both protect and unprotect.
const missingUnprotect: ChatPushTokenProtector = {
  async protect() {
    return protectedToken;
  },
};

const protectedTokenCannotContainProviderToken: ChatProtectedPushToken = {
  ciphertext: "opaque-encrypted-envelope",
  keyId: "kms-key-1",
  // @ts-expect-error Protected values cannot carry the raw provider token.
  token: providerToken,
};

declare const notificationInput: ChatNotificationInput;
const notificationTarget: ChatNotificationTarget = notificationInput.targets[0]!;
const notificationProviderToken: OpaquePushToken = notificationTarget.token;
// @ts-expect-error Provider-target arrays are deeply readonly.
notificationInput.targets.push(notificationTarget);
// @ts-expect-error Provider-target fields are readonly.
notificationTarget.environment = "sandbox";

const minimalAdapters = {
  auth: {
    async resolveActor() {
      return actor;
    },
  },
  directory: {
    async getUser({ actor: trustedActor, userId: requestedUserId }) {
      return {
        tenantId: trustedActor.tenantId,
        userId: requestedUserId,
        displayName: "Ada Lovelace",
      };
    },
    async searchUsers({ actor: trustedActor }) {
      return [
        {
          tenantId: trustedActor.tenantId,
          userId,
          displayName: "Ada Lovelace",
        },
      ];
    },
  },
  permissions: {
    async getCapabilities() {
      return ["message.send", "conversation.read"];
    },
    async authorizeEntity() {
      return true;
    },
  },
  storage: {
    async createUploadUrl({ attachmentId: requestedAttachmentId }) {
      return {
        objectKey: `attachments/${requestedAttachmentId}`,
        method: "PUT" as const,
        url: "https://storage.example/upload",
        expiresAt: "2026-08-25T23:00:00.000Z",
      };
    },
    async verifyObject() {
      return {
        status: "verified" as const,
        exists: true as const,
        sizeBytes: 42,
        checksum: `sha256:${"a".repeat(64)}`,
        contentType: "application/pdf",
        safetyDisposition: "accepted" as const,
      };
    },
    async createDownloadUrl() {
      return {
        url: "https://storage.example/download",
        expiresAt: "2026-08-25T23:00:00.000Z",
      };
    },
    async deleteObject() {},
  },
} satisfies ChatHostAdapters;

const fullAdapters = {
  ...minimalAdapters,
  admission: {
    async admit({ method, routeTemplate }) {
      const boundedMethod: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" =
        method;
      const stableTemplate: string = routeTemplate;
      void [boundedMethod, stableTemplate];
      return { decision: "allow" as const };
    },
  },
  notifications: {
    async send(input) {
      const targets: readonly ChatNotificationTarget[] = input.targets;
      void targets;
    },
  },
  pushTokenProtector,
  audit: {
    async record() {},
  },
  realtime: {
    async publish() {},
  },
  media: {
    async createRoom() {
      return { roomId: "media-room-1" };
    },
    async createParticipantToken({ permissions }) {
      const canShareScreen: boolean = permissions.screenShare;
      void canShareScreen;

      return {
        token: "provider-token",
        expiresAt: "2026-08-25T23:00:00.000Z",
      };
    },
    async terminateRoom() {},
  },
} satisfies ChatHostAdapters;

const trustedRequest: TrustedChatMutationRequest<{
  readonly conversationId: ConversationId;
  readonly body: string;
}> = {
  actor,
  input: { conversationId, body: "Hello" },
};

const missingTenantAuth: ChatAuthAdapter = {
  // @ts-expect-error Trusted auth results must include a tenantId.
  async resolveActor() {
    return { userId, roles: [] };
  },
};

const missingUserAuth: ChatAuthAdapter = {
  // @ts-expect-error Trusted auth results must include a userId.
  async resolveActor() {
    return { tenantId, roles: [] };
  },
};

const tenantSpoof: UntrustedChatMutationInput<{ readonly body: string }> = {
  body: "Hello",
  // @ts-expect-error Tenant identity comes from the trusted host session.
  tenantId,
};

const userSpoof: UntrustedChatMutationInput<{ readonly body: string }> = {
  body: "Hello",
  // @ts-expect-error User identity comes from the trusted host session.
  userId,
};

const actorSpoof: UntrustedChatMutationInput<{ readonly body: string }> = {
  body: "Hello",
  // @ts-expect-error Resolved actor context cannot be caller-authored.
  actor,
};

const roleSpoof: UntrustedChatMutationInput<{ readonly body: string }> = {
  body: "Hello",
  // @ts-expect-error Host roles cannot be caller-authored.
  roles: ["admin"],
};

void [
  attachmentId,
  maximumCiphertextBytes,
  maximumKeyIdBytes,
  protectInput,
  unprotectInput,
  missingTrustedProtectionContext,
  missingProtect,
  missingUnprotect,
  protectedTokenCannotContainProviderToken,
  notificationProviderToken,
  minimalAdapters,
  fullAdapters,
  trustedRequest,
  missingTenantAuth,
  missingUserAuth,
  tenantSpoof,
  userSpoof,
  actorSpoof,
  roleSpoof,
];
void [finalizeAttachment, verifiedObject];
