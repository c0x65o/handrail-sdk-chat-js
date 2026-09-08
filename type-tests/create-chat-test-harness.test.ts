import type {
  DeviceId,
  OpaquePushToken,
  TenantId,
  UserId,
} from "../src/index.js";
import {
  createChatTestHarness,
  type ChatTestActor,
  type ChatTestAdapterBoundary,
  type ChatTestHarness,
} from "../src/testing/index.js";

const tenantId = "tenant-types" as TenantId;
const userId = "user-types" as UserId;

async function useChatHarness(): Promise<void> {
  const harness: ChatTestHarness = await createChatTestHarness({
    schemaPrefix: "handrail_types",
    initialTime: "2030-01-01T00:00:00.000Z",
    actors: [
      {
        credential: "opaque-types-token",
        actor: { tenantId, userId, roles: ["employee"] },
        capabilities: ["conversation.read"],
        user: { tenantId, userId, displayName: "Type User" },
      },
    ],
  });
  const actor: ChatTestActor = harness.addActor({
    credential: "second-opaque-token",
    actor: { tenantId, userId: "second-user" as UserId, roles: [] },
  });
  const boundary: ChatTestAdapterBoundary = "storage.createUploadUrl";
  harness.failures.failNext(boundary);
  harness.failures.queue(boundary, [new Error("first"), "second"]);
  const pending: number = harness.failures.pending(boundary);
  const client = harness.createClient(actor);
  const endpoint: string = client.endpoint;
  const users = harness.directoryUsers(tenantId);
  const deviceId = "device-types" as DeviceId;
  const token = "opaque-push-token" as OpaquePushToken;
  const protectedToken = await harness.adapters.pushTokenProtector.protect({
    tenantId,
    userId,
    deviceId,
    token,
  });
  const unprotectedToken: OpaquePushToken =
    await harness.adapters.pushTokenProtector.unprotect({
      tenantId,
      userId,
      deviceId,
      protectedToken,
    });
  void [pending, endpoint, users, unprotectedToken];
  await harness.teardown();
}

void useChatHarness;

createChatTestHarness({
  actors: [
    {
      credential: "spoof-attempt",
      actor: {
        tenantId,
        userId,
        // @ts-expect-error Trusted actors require host roles.
        roles: undefined,
      },
    },
  ],
});
