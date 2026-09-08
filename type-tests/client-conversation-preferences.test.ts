import {
  createChatClient,
  selectCurrentUserPreferenceState,
  type ChatUpdateConversationPreferenceInput,
  type NormalizedChatCacheState,
} from "@handrail/chat/client";

const conversationId = "conversation-1" as never;
const input = {
  conversationId,
  notificationPreference: "mentions",
  isStarred: false,
  mute: {
    muted: true,
    mutedUntil: "2035-01-01T00:00:00.000Z" as never,
  },
} as const satisfies ChatUpdateConversationPreferenceInput;

const client = createChatClient({
  endpoint: "/chat",
  getAccessToken: () => "token",
});
void client.updateConversationPreference(input);

declare const state: NormalizedChatCacheState;
const selected = selectCurrentUserPreferenceState(state, input.conversationId);
selected.authoritativeRevision satisfies number;
selected.pending?.idempotencyKey satisfies string | undefined;

void client.updateConversationPreference({
  ...input,
  // @ts-expect-error trusted user identity is never caller-authored
  userId: "user-1",
});

void client.updateConversationPreference({
  ...input,
  // @ts-expect-error revision is derived from authoritative private cache state
  expectedPreferenceRevision: 3,
});
