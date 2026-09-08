import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ChatHuddleMediaSession,
  type ChatHuddleMediaAdapter,
  type ChatRealtimeSessionState,
} from "@handrail/chat/client";
import type { ConversationReadState, HostDirectoryUserStatus } from "@handrail/chat";
import { ChatProvider, useChat } from "@handrail/chat/react";
import {
  ChatWorkspace,
  ReplyStyleSettings,
  UserStatusSelector,
  type ChatWorkspaceProps,
} from "@handrail/chat/ui";

import { ChatLabActorChooser, ChatLabShell } from "./ChatLabShell";
import { ChatLabPrivateStateHydration } from "./ChatLabPrivateStateHydration";
import {
  chatLabActors,
  replyStyleLabActors,
  createChatLabConfig,
  isChatLabActorId,
  type ChatLabActorId,
} from "./chat-lab-config";
import { ChatLabThemeSettings, useChatLabTheme } from "./chat-lab-theme";

export { chatLabThemeStorageKey } from "./chat-lab-theme";

// This text-only scenario has no huddle session to retain a channel subscription.
// Keep its selected parent in managed snapshots while opening child discussions.
function ReplyScenarioSubscription({ conversationId }: {
  readonly conversationId: ChatWorkspaceProps["conversationId"];
}) {
  const chat = useChat();
  useEffect(() => {
    if (!chat?.isReady || conversationId === undefined || conversationId === null) return;
    const unsubscribe = chat.client.realtime?.subscribeConversation(conversationId);
    return () => unsubscribe?.();
  }, [chat?.client, chat?.isReady, conversationId]);
  return null;
}

const actorStorageKey = "handrail-chat-lab:actor";
const organizationScope = { type: "organization" } as const;
const chatLabWorkspaceIdentity = Object.freeze({
  id: "chat-lab-development",
  name: "Development workspace",
}) satisfies NonNullable<ChatWorkspaceProps["workspaceIdentity"]>;
const reactionKeys = Object.freeze(["👍", "👀"] as const);
const idleRealtimeState = Object.freeze({ state: "idle" } as const);
const failClosedCreationAvailability = Object.freeze({
  channel: Object.freeze({ canCreate: false }),
  direct: Object.freeze({ canCreate: false }),
  groupDirect: Object.freeze({ canCreate: false }),
});
const failClosedMemberManagementAvailability = Object.freeze({ canView: false });
const failClosedHuddlePermissions = Object.freeze({
  canStart: false,
  canJoin: false,
  canLeave: false,
  canControlMicrophone: false,
  canShareScreen: false,
  canSelectDevices: false,
  canRetry: false,
  canRejoin: false,
  canEnd: false,
});
const embeddedWorkspaceWidths = Object.freeze([960, 720, 480] as const);

function EmbeddedChatWorkspaceFixture({ children }: { readonly children: ReactNode }) {
  const [width, setWidth] = useState<(typeof embeddedWorkspaceWidths)[number]>(960);

  return (
    <section
      aria-label="Resizable embedded ChatWorkspace fixture"
      className="chat-lab__embedded-fixture"
      data-chat-lab-embedded-fixture="true"
    >
      <div
        aria-label="Embedded workspace width"
        className="chat-lab__embedded-controls"
        role="group"
      >
        <span>Host width</span>
        {embeddedWorkspaceWidths.map((candidate) => (
          <button
            aria-pressed={candidate === width}
            key={candidate}
            onClick={() => setWidth(candidate)}
            type="button"
          >
            {candidate}px
          </button>
        ))}
      </div>
      <div
        aria-label={`Embedded ChatWorkspace host at ${width} pixels`}
        className="chat-lab__embedded-host"
        data-embedded-workspace-width={width}
        style={{ inlineSize: `${width}px` }}
      >
        {children}
      </div>
    </section>
  );
}

const readInitialActor = (): ChatLabActorId => {
  try {
    const stored = globalThis.localStorage?.getItem(actorStorageKey);
    return stored !== null && isChatLabActorId(stored) ? stored : "ada";
  } catch {
    return "ada";
  }
};

export interface ChatLabAppProps {
  /** Optional host-owned media boundary; omitted previews fail closed. */
  readonly huddleMediaAdapter?: ChatHuddleMediaAdapter;
  readonly huddleMediaView?: ReactNode;
  /** Optional initial fixture identity; normal Chat Lab visits retain persistence. */
  readonly initialActorId?: ChatLabActorId;
  /** Opt-in development fixture for exercising root-container responsiveness. */
  readonly embeddedWorkspaceFixture?: boolean;
  /** Dev-only real-stack receipt fixture used by the focused visual baseline. */
  readonly directMessageVisualFixture?: boolean;
  /** Isolates browser cache and cross-tab state from prior backend instances. */
  readonly instanceId?: string;
  readonly replyStylesScenario?: boolean;
}

interface ActiveActorSession {
  readonly actorId: ChatLabActorId;
  readonly mediaSession?: ChatHuddleMediaSession;
}

export function ChatLabApp({
  replyStylesScenario = false,
  directMessageVisualFixture = false,
  embeddedWorkspaceFixture = false,
  huddleMediaAdapter,
  huddleMediaView,
  initialActorId,
  instanceId,
}: ChatLabAppProps = {}) {
  const [mediaAdapter] = useState<ChatHuddleMediaAdapter | undefined>(
    () => replyStylesScenario ? undefined : huddleMediaAdapter,
  );
  const [activeActorSession, setActiveActorSession] = useState<ActiveActorSession>(
    () => Object.freeze({
      actorId: replyStylesScenario
        ? (replyStyleLabActors.find(({ id }) => id === initialActorId)?.id ?? "alice")
        : (chatLabActors.find(({ id }) => id === initialActorId)?.id) ??
          (chatLabActors.some(({ id }) => id === readInitialActor()) ? readInitialActor() : "ada"),
      ...(mediaAdapter === undefined
        ? {}
        : { mediaSession: new ChatHuddleMediaSession(mediaAdapter) }),
    }),
  );
  const activeActorSessionRef = useRef(activeActorSession);
  const requestedActorIdRef = useRef(activeActorSession.actorId);
  const actorTransitionRef = useRef(Promise.resolve());
  const mountedRef = useRef(false);
  const lifecycleGenerationRef = useRef(0);
  const actorId = activeActorSession.actorId;
  const { effectiveTheme, selectTheme, themePreference } = useChatLabTheme();
  const [realtimeStates, setRealtimeStates] = useState<
    Partial<Record<ChatLabActorId, ChatRealtimeSessionState>>
  >({});
  const [selectedConversationIds, setSelectedConversationIds] = useState<
    Partial<
      Record<ChatLabActorId, NonNullable<ChatWorkspaceProps["defaultConversationId"]>>
    >
  >({});
  const [selectionOwnerSession, setSelectionOwnerSession] = useState<ActiveActorSession>();
  const [directMessageVisualReadState, setDirectMessageVisualReadState] =
    useState<ConversationReadState>();
  const [userStatuses, setUserStatuses] = useState<
    Partial<Record<ChatLabActorId, HostDirectoryUserStatus>>
  >({});

  useEffect(() => {
    if (!directMessageVisualFixture) return;
    const controller = new AbortController();
    void fetch("/__chat-lab/direct-message-visual-read-state", {
      cache: "no-store",
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Direct-message visual read state failed: ${response.status}`);
      }
      setDirectMessageVisualReadState(await response.json() as ConversationReadState);
    });
    return () => controller.abort();
  }, [directMessageVisualFixture]);

  useEffect(() => {
    mountedRef.current = true;
    lifecycleGenerationRef.current += 1;
    return () => {
      mountedRef.current = false;
      const cleanupGeneration = ++lifecycleGenerationRef.current;
      globalThis.queueMicrotask(() => {
        // React Strict Mode immediately runs a replacement setup. Only an
        // actual app teardown leaves this cleanup generation current.
        if (lifecycleGenerationRef.current !== cleanupGeneration) return;
        void activeActorSessionRef.current.mediaSession?.close().catch(() => undefined);
      });
    };
  }, []);

  const config = useMemo(
    () => createChatLabConfig(actorId, (state) => {
      setRealtimeStates((current) => ({ ...current, [actorId]: state }));
    }, instanceId),
    [actorId, instanceId],
  );
  const actors = replyStylesScenario ? replyStyleLabActors : chatLabActors;
  const actor = actors.find(({ id }) => id === actorId);
  const creationAvailability = actor?.creationAvailability ?? failClosedCreationAvailability;
  const memberManagementAvailability = actor?.memberManagementAvailability ??
    failClosedMemberManagementAvailability;
  const huddlePermissions = actor?.huddlePermissions ?? failClosedHuddlePermissions;
  const currentUserId = actorId as NonNullable<ChatWorkspaceProps["currentUserId"]>;
  const selectedConversationId = selectedConversationIds[actorId];
  const saveUserStatus = useCallback((status: HostDirectoryUserStatus | undefined) => {
    setUserStatuses((current) => {
      if (status === undefined) {
        const { [actorId]: _cleared, ...remaining } = current;
        return remaining;
      }
      return { ...current, [actorId]: status };
    });
  }, [actorId]);
  const saveSelectedConversation = useCallback<
    NonNullable<ChatWorkspaceProps["onConversationChange"]>
  >((conversationId) => {
    setSelectedConversationIds((current) => current[actorId] === conversationId
      ? current
      : { ...current, [actorId]: conversationId });
    setSelectionOwnerSession(activeActorSession);
  }, [activeActorSession, actorId]);
  const selectActor = (nextActorId: string) => {
    if (!isChatLabActorId(nextActorId) || !actors.some(({ id }) => id === nextActorId)) return;
    if (nextActorId === requestedActorIdRef.current) return;
    requestedActorIdRef.current = nextActorId;
    try {
      globalThis.localStorage?.setItem(actorStorageKey, nextActorId);
    } catch {
      // Storage is only a convenience; the selected actor still changes.
    }
    actorTransitionRef.current = actorTransitionRef.current.then(async () => {
      const targetActorId = requestedActorIdRef.current;
      const previous = activeActorSessionRef.current;
      if (targetActorId === previous.actorId) return;

      // The next actor receives a fresh host-owned session only after the old
      // identity's provider connection and every local track are gone.
      await previous.mediaSession?.handleIdentityChange().catch(() => undefined);
      await previous.mediaSession?.close().catch(() => undefined);
      if (!mountedRef.current) return;

      const replacement = Object.freeze({
        actorId: targetActorId,
        ...(mediaAdapter === undefined
          ? {}
          : { mediaSession: new ChatHuddleMediaSession(mediaAdapter) }),
      });
      activeActorSessionRef.current = replacement;
      setRealtimeStates((current) => ({
        ...current,
        [targetActorId]: idleRealtimeState,
      }));
      setActiveActorSession(replacement);
    });
  };
  const workspace = (
    <ChatProvider config={config} key={actorId}>
      <ChatLabPrivateStateHydration />
      {replyStylesScenario && <ReplyScenarioSubscription conversationId={selectedConversationId} />}
      <ChatWorkspace
        ariaLabel="Handrail Chat Lab workspace"
        channelCreationAvailability={creationAvailability.channel}
        className="chat-lab__chat"
        currentUserId={currentUserId}
        {...(replyStylesScenario ? {
          threadLifecycleAvailability: {
            canManage: actorId === "alice" || actorId === "bob", canSend: actorId !== "dave",
          },
        } : {})}
        {...(selectedConversationId === undefined
          ? {}
          : selectionOwnerSession === activeActorSession
            ? { conversationId: selectedConversationId }
            : { defaultConversationId: selectedConversationId })}
        directCreationAvailability={creationAvailability.direct}
        groupDirectCreationAvailability={creationAvailability.groupDirect}
        {...(activeActorSession.mediaSession === undefined
          ? {}
          : {
              huddleMediaSession: activeActorSession.mediaSession,
              huddlePermissions,
            })}
        memberManagementAvailability={memberManagementAvailability}
        mode="full-screen"
        navigationLabel="Conversations"
        onConversationChange={saveSelectedConversation}
        {...(directMessageVisualReadState === undefined
          ? {}
          : { otherMemberReadState: directMessageVisualReadState })}
        reactionKeys={reactionKeys}
        scope={organizationScope}
        workspaceIdentity={chatLabWorkspaceIdentity}
        workspaceMenuContent={(
          <div className="chat-lab__workspace-user-controls">
            <UserStatusSelector
              onStatusChange={saveUserStatus}
              status={userStatuses[actorId]}
            />
            <ChatLabActorChooser
              actors={actors}
              activeActorId={actorId}
              onActorChange={selectActor}
            />
          </div>
        )}
        workspaceSettingsContent={(
          <>
            <ChatLabThemeSettings onThemeChange={selectTheme} themePreference={themePreference} />
            {replyStylesScenario && <details className="chat-lab__reply-settings">
              <summary>Reply settings</summary>
              <ReplyStyleSettings />
            </details>}
          </>
        )}
        {...(themePreference === "system" ? {} : { theme: themePreference })}
      />
    </ChatProvider>
  );
  const scenarioWorkspace = replyStylesScenario ? (
    <div className="chat-lab__reply-scenario">
      <section aria-label="Mixed reply styles scenario" className="chat-lab__scenario-guide">
        <strong>Alice + Bob · Launch planning</strong>
        <p>Current Reply opens a separate thread. Discord-style Reply stays in the current conversation with a source reference.
          Explicit named threads remain separate discussions. Switching style does not convert history.</p>
        <p>Closing/reopening is shared lifecycle state. Join/Leave changes your subscription and retains authorized history.
          Notification preferences remain separate. Use Reply settings to change only your choice.</p>
      </section>
      {workspace}
    </div>
  ) : workspace;
  return (
    <ChatLabShell
      activeActorName={actor?.displayName ?? "unknown actor"}
      effectiveTheme={effectiveTheme}
      huddleMediaConfigured={activeActorSession.mediaSession !== undefined}
      realtimeState={realtimeStates[actorId] ?? idleRealtimeState}
      themePreference={themePreference}
      workspace={embeddedWorkspaceFixture
        ? <EmbeddedChatWorkspaceFixture>{workspace}</EmbeddedChatWorkspaceFixture>
        : replyStylesScenario ? scenarioWorkspace : huddleMediaView === undefined ? workspace : <div className="chat-lab-media-layout">
            {huddleMediaView}{workspace}
          </div>}
    />
  );
}
