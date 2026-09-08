import { useMemo } from "react";
import {
  CHAT_CLIENT_PACKAGE_VERSION,
  createNormalizedChatCache,
  type ChatClient,
  type ConversationDetailSnapshotConversation,
  type ConversationListSnapshotSummary,
} from "@handrail/chat/client";
import { ChatProvider } from "@handrail/chat/react";
import { ChatWorkspace } from "@handrail/chat/ui";
import { ChatLabThemeChooser, useChatLabTheme } from "./chat-lab-theme";

export const conversationStateFixtureKinds = Object.freeze([
  "loading",
  "unavailable",
  "error",
  "no-selection",
  "empty",
] as const);

export type ConversationStateFixtureKind =
  (typeof conversationStateFixtureKinds)[number];

const fixtureLabels: Readonly<Record<ConversationStateFixtureKind, string>> =
  Object.freeze({
    loading: "Loading",
    unavailable: "Unavailable",
    error: "Error",
    "no-selection": "No selection",
    empty: "Empty",
  });

const tenantId = "tenant-conversation-state-fixture" as never;
const userId = "user-conversation-state-fixture" as never;
const conversationId = "conversation-state-fixture" as never;
const anchorConversationId = "conversation-state-fixture-anchor" as never;
const scope = Object.freeze({ type: "organization" } as const);
const now = "2038-05-06T07:08:09.000Z";
const metadata = Object.freeze({
  packageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: 4,
  schemaVersion: 1,
  enabledFeatures: Object.freeze({}),
  supportedProtocolRange: Object.freeze({
    minimumVersion: 4,
    maximumVersion: 4,
  }),
  feature: Object.freeze({ name: "conversation_snapshots", version: 1 }),
});
const readyState = Object.freeze({
  state: "ready" as const,
  clientPackageVersion: CHAT_CLIENT_PACKAGE_VERSION,
  protocolVersion: 4,
  metadata,
  enabledFeatures: Object.freeze({}),
});
const conversation: ConversationListSnapshotSummary &
  ConversationDetailSnapshotConversation = Object.freeze({
  id: conversationId,
  tenantId,
  type: "channel" as const,
  name: "Acceptance fixture",
  visibility: "public" as const,
  createdAt: now,
  updatedAt: now,
  activityAt: now,
  latestSequence: 0,
  unreadMentionCount: 0,
  hasActiveHuddle: false,
  activeMemberUserIds: Object.freeze([userId]),
  memberUserIds: Object.freeze([userId]),
  currentMember: Object.freeze({
    tenantId,
    conversationId,
    userId,
    role: "member" as const,
    state: "active" as const,
    joinedAt: now,
    updatedAt: now,
  }),
  currentReadState: Object.freeze({
    conversationId,
    userId,
    lastReadSequence: 0,
    updatedAt: now,
  }),
  currentPreference: Object.freeze({
    conversationId,
    userId,
    notificationPreference: "all" as const,
    mute: Object.freeze({ muted: false as const }),
    updatedAt: now,
  }),
});
const anchorConversation = Object.freeze({
  ...conversation,
  id: anchorConversationId,
  name: "Fixture anchor",
  currentMember: Object.freeze({
    ...conversation.currentMember,
    conversationId: anchorConversationId,
  }),
  currentReadState: Object.freeze({
    ...conversation.currentReadState,
    conversationId: anchorConversationId,
  }),
  currentPreference: Object.freeze({
    ...conversation.currentPreference,
    conversationId: anchorConversationId,
  }),
});

export const resolveConversationStateFixture = (
  search: string,
): ConversationStateFixtureKind => {
  const requested = new URLSearchParams(search).get("state");
  return conversationStateFixtureKinds.find((kind) => kind === requested) ??
    "unavailable";
};

export const createConversationStateFixtureClient = (
  kind: ConversationStateFixtureKind,
): ChatClient => {
  const cache = createNormalizedChatCache({
    tenantId,
    userId,
    sessionId: `session-conversation-state-fixture:${kind}` as never,
  });
  cache.hydrateConversationList({
    kind: "conversation_list",
    scope,
    // The anchor keeps non-empty fixtures populated when the selected entity
    // is absent, while empty exercises a successful zero-item list.
    items: kind === "empty" ? [] : [conversation, anchorConversation],
    page: {},
    _meta: metadata,
  });

  if (kind === "unavailable") {
    cache.hydrateConversationDetail({
      kind: "conversation_detail",
      conversation: {
        ...conversation,
        memberUserIds: [],
        currentPreference: {
          conversationId,
          userId,
          notificationPreference: "all",
          mute: { muted: false },
          updatedAt: now,
        },
      },
      _meta: metadata,
    });
    const canonical = structuredClone(cache.getState());
    Reflect.deleteProperty(canonical.entities.conversations, conversationId);
    Reflect.deleteProperty(
      canonical.metadata.conversationListActiveHuddles,
      conversationId,
    );
    Reflect.deleteProperty(
      canonical.metadata.conversationListParticipantUserIds,
      conversationId,
    );
    Reflect.deleteProperty(
      canonical.metadata.conversationListUnreadMentionCounts,
      conversationId,
    );
    if (!cache.hydrateCanonicalState(canonical)) {
      throw new Error("The unavailable conversation fixture is invalid.");
    }
  }

  const success = () => Promise.resolve({ status: "success", value: {} });
  const client = {
    endpoint: "fixture://conversation-state",
    state: readyState,
    cache,
    start: async () => readyState,
    close() {},
    subscribeLifecycle: () => () => undefined,
    listConversations: success,
    getConversation: () => {
      if (kind === "loading") return new Promise(() => undefined);
      if (kind === "error") {
        return Promise.resolve({
          status: "transport",
          message: "The conversation detail could not be loaded.",
        });
      }
      return success();
    },
    selectDirectoryUser: () => undefined,
    hydrateDirectoryUsers: success,
  };
  return client as unknown as ChatClient;
};

export interface ConversationStateChatLabProps {
  readonly state?: ConversationStateFixtureKind;
}

export function ConversationStateChatLab({
  state = resolveConversationStateFixture(globalThis.location?.search ?? ""),
}: ConversationStateChatLabProps) {
  const { effectiveTheme, selectTheme, themePreference } = useChatLabTheme();
  const client = useMemo(
    () => createConversationStateFixtureClient(state),
    [state],
  );

  return (
    <main
      className="chat-lab handrail-chat"
      data-chat-lab-effective-theme={effectiveTheme}
      data-chat-lab-theme={themePreference}
      data-conversation-state-fixture={state}
      {...(themePreference === "system"
        ? {}
        : { "data-handrail-theme": themePreference })}
    >
      <header className="chat-lab__toolbar">
        <div className="chat-lab__brand">
          <span className="chat-lab__brand-mark" aria-hidden="true">H</span>
          <div>
            <h1>Conversation state fixture</h1>
            <span className="chat-lab__workspace-label">
              Development-only · read-only · {fixtureLabels[state]}
            </span>
          </div>
        </div>
        <div className="chat-lab__toolbar-controls chat-lab__fixture-controls">
          <nav className="chat-lab__fixture-states" aria-label="Conversation fixture state">
            <span className="chat-lab__fixture-state-label" aria-hidden="true">Panel</span>
            {conversationStateFixtureKinds.map((kind) => (
              <a
                aria-current={kind === state ? "page" : undefined}
                className="chat-lab__fixture-state"
                href={`?state=${kind}`}
                key={kind}
              >
                {fixtureLabels[kind]}
              </a>
            ))}
          </nav>
          <ChatLabThemeChooser
            id="conversation-state-chat-lab-theme"
            onThemeChange={selectTheme}
            themePreference={themePreference}
          />
        </div>
      </header>
      <section className="chat-lab__stage" aria-label="Conversation state acceptance fixture">
        <div className="chat-lab__workspace">
          <ChatProvider client={client}>
            <ChatWorkspace
              ariaLabel={`${fixtureLabels[state]} conversation state`}
              className="chat-lab__chat"
              conversationId={
                state === "no-selection" || state === "empty" ? null : conversationId
              }
              mode="full-screen"
              readOnly
              scope={scope}
              {...(themePreference === "system" ? {} : { theme: themePreference })}
            />
          </ChatProvider>
        </div>
      </section>
    </main>
  );
}
