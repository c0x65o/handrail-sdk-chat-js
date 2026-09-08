import {
  createContext,
  createElement,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactElement,
  type ReactNode,
} from "react";

import {
  createChatClient,
  type ChatClient,
  type ChatClientDiagnostic,
  type ChatClientLifecycleState,
  type ChatClientRefreshRequiredState,
  type CreateChatClientConfig,
} from "../client/create-chat-client.js";

export type ChatProviderReadiness =
  | "not_ready"
  | "ready"
  | "refresh_required"
  | "error";

/** The complete public, headless value exposed to provider descendants. */
export interface ChatContextValue<Feature extends string = string> {
  readonly client: ChatClient<Feature>;
  readonly state: ChatClientLifecycleState<Feature>;
  readonly readiness: ChatProviderReadiness;
  readonly isReady: boolean;
  readonly refreshRequired: ChatClientRefreshRequiredState<Feature> | null;
  /** A safe diagnostic only; startup exceptions and response bodies are not exposed. */
  readonly error: ChatClientDiagnostic | null;
}

interface ChatProviderSharedProps {
  readonly children?: ReactNode;
}

export type ChatProviderProps<Feature extends string = string> =
  | (ChatProviderSharedProps & {
      /** Externally owned: the provider neither starts nor closes this client. */
      readonly client: ChatClient<Feature>;
      readonly config?: never;
    })
  | (ChatProviderSharedProps & {
      /** Creates a provider-owned client that is started and closed with the provider. */
      readonly config: CreateChatClientConfig<Feature>;
      readonly client?: never;
    });

interface ChatClientBinding<Feature extends string> {
  readonly client: ChatClient<Feature>;
  readonly owned: boolean;
}

const getReadiness = (
  state: ChatClientLifecycleState,
): ChatProviderReadiness => {
  switch (state.state) {
    case "ready":
      return "ready";
    case "refresh_required":
      return "refresh_required";
    case "error":
      return "error";
    default:
      return "not_ready";
  }
};

const createBinding = <Feature extends string>(
  props: ChatProviderProps<Feature>,
): ChatClientBinding<Feature> => {
  if (props.client !== undefined) {
    if (props.config !== undefined) {
      throw new TypeError("ChatProvider accepts either client or config, not both.");
    }
    return Object.freeze({ client: props.client, owned: false });
  }
  if (props.config === undefined) {
    throw new TypeError("ChatProvider requires either client or config.");
  }
  return Object.freeze({ client: createChatClient(props.config), owned: true });
};

/**
 * Public context for headless consumers. A missing provider yields `null`.
 * Nested providers are supported and normal React nearest-provider semantics apply.
 */
export const ChatContext = createContext<ChatContextValue | null>(null);
ChatContext.displayName = "HandrailChatContext";

/**
 * Binds one client for the lifetime of this provider mount. Remount the provider
 * to replace its `client` or `config` binding.
 */
export function ChatProvider<Feature extends string = string>(
  props: ChatProviderProps<Feature>,
): ReactElement {
  const [binding] = useState<ChatClientBinding<Feature>>(() =>
    createBinding(props),
  );
  const lifecycleStore = useMemo(() => {
    const serverSnapshot = binding.client.state;
    return Object.freeze({
      subscribe: (listener: () => void) =>
        binding.client.subscribeLifecycle(listener),
      getSnapshot: () => binding.client.state,
      getServerSnapshot: () => serverSnapshot,
    });
  }, [binding.client]);
  const observedState = useSyncExternalStore(
    lifecycleStore.subscribe,
    lifecycleStore.getSnapshot,
    lifecycleStore.getServerSnapshot,
  );

  useEffect(() => {
    if (!binding.owned) {
      return;
    }

    void binding.client.start();

    return () => {
      binding.client.close();
    };
  }, [binding]);

  const value = useMemo<ChatContextValue<Feature>>(() => {
    const refreshRequired =
      observedState.state === "refresh_required" ? observedState : null;
    const error =
      observedState.state === "error" ? observedState.diagnostic : null;
    return Object.freeze({
      client: binding.client,
      state: observedState,
      readiness: getReadiness(observedState),
      isReady: observedState.state === "ready",
      refreshRequired,
      error,
    });
  }, [binding.client, observedState]);

  return createElement(ChatContext.Provider, { value }, props.children);
}

export * from "./query-hooks.js";
export * from "./action-hooks.js";
export { useThreadLifecycle } from "./thread-lifecycle-hook.js";

export { useThreadList } from "./thread-list-hook.js";
export { useReplyStyle, useReplyStyleActions, type ReplyStyleActions } from "./reply-style-hooks.js";
