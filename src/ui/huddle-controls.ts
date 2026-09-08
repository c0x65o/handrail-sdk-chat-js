import {
  createElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react";

import type {
  ChatHuddleMediaDeviceKind,
  ChatHuddleMediaSession,
  ChatHuddleMediaSessionState,
} from "../client/index.js";
import type {
  ConversationId,
  HuddleMediaJoinDescriptor,
  HuddleParticipant,
  UserId,
} from "../contracts/index.js";
import {
  useChat,
  useChatActions,
  useHuddle,
} from "../react/index.js";

/** Authorization projected by the host; HuddleControls never derives it from roles. */
export interface HuddleControlsPermissions {
  readonly canStart: boolean;
  readonly canJoin: boolean;
  readonly canLeave: boolean;
  readonly canControlMicrophone: boolean;
  readonly canShareScreen: boolean;
  readonly canSelectDevices: boolean;
  readonly canRetry: boolean;
  readonly canRejoin: boolean;
  readonly canEnd: boolean;
}

/**
 * Deliberately narrow customization boundary for ephemeral provider join
 * material. When present, it takes descriptor-handoff precedence over the
 * default media session and HuddleControls does not retain or render it.
 */
export interface HuddleMediaRenderer {
  readonly receiveHuddleMediaJoinDescriptor: (
    descriptor: HuddleMediaJoinDescriptor,
  ) => void;
}

export interface HuddleControlsProps {
  readonly conversationId: ConversationId;
  /** Required to interpret canonical participant and screen-share ownership. */
  readonly currentUserId: UserId;
  readonly permissions: HuddleControlsPermissions;
  /** Host-owned reusable session. HuddleControls disconnects but never closes it. */
  readonly mediaSession?: ChatHuddleMediaSession;
  /** Custom descriptor handoff override; takes precedence over mediaSession. */
  readonly mediaRenderer?: HuddleMediaRenderer;
  readonly participantLabel?: (participant: HuddleParticipant) => string;
  /** Render only an available Start/Join affordance for a conversation header. */
  readonly presentation?: "default" | "header";
  readonly disabled?: boolean;
  readonly className?: string;
  readonly ariaLabel?: string;
}

const controlLabelByOperation = Object.freeze({
  start_huddle: "Starting huddle",
  join_huddle: "Joining huddle",
  leave_huddle: "Leaving huddle",
  set_huddle_screen_share: "Updating screen sharing",
  end_huddle: "Ending huddle",
});

const lifecycleMessage = (status: string | undefined): string => {
  switch (status) {
    case "inactive": return "No huddle is active.";
    case "starting": return "Huddle is starting.";
    case "active": return "Huddle is active.";
    case "ended": return "Huddle ended.";
    default: return "Loading huddle.";
  }
};

const connectionMessage = (
  status: ChatHuddleMediaSessionState["connectionStatus"],
): string => {
  switch (status) {
    case "connecting": return "Media connection: Connecting.";
    case "connected": return "Media connection: Connected.";
    case "reconnecting": return "Media connection: Reconnecting.";
    case "disconnecting": return "Media connection: Disconnecting.";
    case "closed": return "Media connection: Closed.";
    default: return "Media connection: Disconnected.";
  }
};

const defaultParticipantLabel = (participant: HuddleParticipant): string =>
  participant.userId;

// Servers advertise provider availability as `media`; the UI exposes that
// same capability as `huddles`, with an explicit UI flag taking precedence.
const huddlesEnabled = (
  enabledFeatures: Readonly<Record<string, boolean>>,
): boolean => enabledFeatures.huddles ?? enabledFeatures.media ?? false;

interface HuddleButtonProps {
  readonly label: string;
  readonly permitted: boolean;
  readonly unavailable: boolean;
  readonly unavailableReason?: string;
  readonly onPress: () => Promise<unknown>;
}

const HuddleButton = ({
  label,
  permitted,
  unavailable,
  unavailableReason,
  onPress,
}: HuddleButtonProps): ReactElement => createElement(
  "button",
  {
    "aria-label": label,
    className: "handrail-chat__button handrail-chat__huddle-button",
    disabled: unavailable || !permitted,
    onClick: () => { void onPress().catch(() => undefined); },
    title: !permitted
      ? "You do not have permission for this action."
      : unavailable
        ? unavailableReason ?? "This action is temporarily unavailable."
        : undefined,
    type: "button",
  },
  label,
);

const useMediaState = (
  mediaSession: ChatHuddleMediaSession | undefined,
): ChatHuddleMediaSessionState | undefined => {
  const [state, setState] = useState<ChatHuddleMediaSessionState | undefined>(
    () => mediaSession?.getState(),
  );
  useEffect(() => {
    if (mediaSession === undefined) {
      setState(undefined);
      return;
    }
    setState(mediaSession.getState());
    return mediaSession.subscribe((next) => setState(next));
  }, [mediaSession]);
  return state;
};

const stopLocalScreenShare = async (
  mediaSession: ChatHuddleMediaSession,
): Promise<void> => {
  try {
    await mediaSession.stopScreenShare();
  } catch {
    await mediaSession.disconnect().catch(() => undefined);
    throw new Error("Screen sharing could not be stopped.");
  }
};

interface DeviceSelectProps {
  readonly kind: ChatHuddleMediaDeviceKind;
  readonly label: string;
  readonly mediaState: ChatHuddleMediaSessionState;
  readonly permitted: boolean;
  readonly unavailable: boolean;
  readonly unavailableReason?: string;
  readonly onSelect: (
    kind: ChatHuddleMediaDeviceKind,
    deviceId: string | null,
  ) => Promise<void>;
}

const selectedDeviceId = (
  state: ChatHuddleMediaSessionState,
  kind: ChatHuddleMediaDeviceKind,
): string => {
  switch (kind) {
    case "audio_input": return state.devices.selectedAudioInputId ?? "";
    case "audio_output": return state.devices.selectedAudioOutputId ?? "";
    case "video_input": return state.devices.selectedVideoInputId ?? "";
  }
};

const DeviceSelect = ({
  kind,
  label,
  mediaState,
  permitted,
  unavailable,
  unavailableReason,
  onSelect,
}: DeviceSelectProps): ReactElement | null => {
  const devices = mediaState.devices.devices.filter((device) => device.kind === kind);
  if (devices.length === 0) return null;
  return createElement(
    "label",
    { className: "handrail-chat__huddle-device" },
    label,
    createElement(
      "select",
      {
        "aria-label": label,
        disabled: unavailable || !permitted,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          const value = event.currentTarget.value;
          void onSelect(kind, value.length === 0 ? null : value).catch(() => undefined);
        },
        title: !permitted
          ? "You do not have permission for this action."
          : unavailable
            ? unavailableReason ?? "Connect to huddle media to select a device."
            : undefined,
        value: selectedDeviceId(mediaState, kind),
      },
      createElement("option", { value: "" }, "System default"),
      devices.map((device) => createElement(
        "option",
        { key: device.id, value: device.id },
        device.label.length === 0 ? "Unnamed device" : device.label,
      )),
    ),
  );
};

interface ConnectedHuddleControlsProps extends HuddleControlsProps {
  readonly providerReady: boolean;
}

function ConnectedHuddleControls(
  props: ConnectedHuddleControlsProps,
): ReactElement | null {
  const context = useChat();
  const query = useHuddle(props.conversationId, { enabled: props.providerReady });
  const actions = useChatActions(props.conversationId);
  const view = query.data;
  const canonical = view?.canonicalState;
  const participants = canonical !== undefined && canonical.status !== "inactive"
    ? canonical.participants
    : [];
  const joinedParticipants = participants.filter(
    (participant) => participant.status === "joined",
  );
  const isJoined = joinedParticipants.some(
    (participant) => participant.userId === props.currentUserId,
  );
  const screenShareOwnerUserId = canonical !== undefined &&
      (canonical.status === "starting" || canonical.status === "active")
    ? canonical.screenShareOwnerUserId
    : null;
  const labelParticipant = props.participantLabel ?? defaultParticipantLabel;
  const pending = view?.pendingOperation;
  const mediaSession = props.mediaRenderer === undefined ? props.mediaSession : undefined;
  const mediaState = useMediaState(mediaSession);
  const [mediaOperation, setMediaOperation] = useState<
    "microphone" | "screen_share" | "device" | undefined
  >();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsId = useId();
  const detailsTitleId = useId();
  const detailsRef = useRef<HTMLDivElement | null>(null);
  const detailsCloseRef = useRef<HTMLButtonElement | null>(null);
  const detailsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const mediaOperationRef = useRef(mediaOperation);
  const mountedRef = useRef(true);
  const handoffMarkerRef = useRef<string | undefined>(undefined);
  const handoffBoundaryRef = useRef<object | undefined>(undefined);
  const hasConnectedRef = useRef(false);
  const previousLocalShareRef = useRef(false);
  const closeDetails = useCallback(() => {
    setDetailsOpen(false);
    const trigger = detailsTriggerRef.current;
    if (trigger?.isConnected === true) trigger.focus();
  }, []);

  const runMediaOperation = async <Value,>(
    operation: "microphone" | "screen_share" | "device",
    action: () => Promise<Value>,
  ): Promise<Value | undefined> => {
    if (mediaOperationRef.current !== undefined) return undefined;
    mediaOperationRef.current = operation;
    setMediaOperation(operation);
    try {
      return await action();
    } finally {
      if (mediaOperationRef.current === operation) {
        mediaOperationRef.current = undefined;
        if (mountedRef.current) setMediaOperation(undefined);
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    setDetailsOpen(false);
  }, [props.conversationId, props.currentUserId]);

  useEffect(() => {
    if (!detailsOpen) return;
    detailsCloseRef.current?.focus();

    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      closeDetails();
    };
    const handlePointerDown = (event: PointerEvent): void => {
      if (!(event.target instanceof Node)) return;
      if (
        detailsRef.current?.contains(event.target) === true ||
        detailsTriggerRef.current?.contains(event.target) === true
      ) return;
      closeDetails();
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [closeDetails, detailsOpen]);

  useEffect(() => {
    if (mediaSession === undefined) return;
    return () => {
      handoffMarkerRef.current = undefined;
      hasConnectedRef.current = false;
      void mediaSession.handleIdentityChange().catch(() => undefined);
    };
  }, [mediaSession, props.conversationId, props.currentUserId]);

  useEffect(() => {
    if (mediaSession === undefined || canonical === undefined) return;
    const isLive = canonical.status === "starting" || canonical.status === "active";
    if (!isLive || !isJoined) void mediaSession.leave().catch(() => undefined);
  }, [canonical?.status, isJoined, mediaSession]);

  useEffect(() => {
    if (
      mediaSession === undefined ||
      mediaState?.screenShareActive !== true ||
      canonical === undefined ||
      mediaOperationRef.current === "screen_share" ||
      screenShareOwnerUserId === props.currentUserId
    ) return;
    void stopLocalScreenShare(mediaSession).catch(() => undefined);
  }, [
    canonical,
    mediaSession,
    mediaState?.screenShareActive,
    props.currentUserId,
    screenShareOwnerUserId,
  ]);

  useEffect(() => {
    const wasSharing = previousLocalShareRef.current;
    previousLocalShareRef.current = mediaState?.screenShareActive === true;
    if (wasSharing && mediaState?.screenShareActive === false && isJoined && pending === undefined &&
        screenShareOwnerUserId === props.currentUserId &&
        mediaOperationRef.current === undefined) {
      // The browser's own Stop sharing control must release canonical ownership.
      void actions.clearHuddleScreenShare().catch(() => undefined);
    }
  }, [mediaState?.screenShareActive, screenShareOwnerUserId, props.currentUserId, actions, isJoined, pending]);

  useEffect(() => {
    if (view?.media.state !== "ready" || pending !== undefined || context === null || !isJoined) return;
    const boundary = props.mediaRenderer ?? mediaSession;
    if (boundary === undefined) return;
    if (handoffBoundaryRef.current !== boundary) {
      handoffBoundaryRef.current = boundary;
      handoffMarkerRef.current = undefined;
    }
    const marker = `${view.media.huddleSessionId}:${view.media.expiresAt}`;
    if (handoffMarkerRef.current === marker) return;
    let descriptor: HuddleMediaJoinDescriptor | undefined;
    try {
      descriptor = context.client.getHuddleMediaJoinDescriptor(props.conversationId);
    } catch {
      return;
    }
    if (descriptor === undefined) return;
    handoffMarkerRef.current = marker;
    if (props.mediaRenderer !== undefined) {
      props.mediaRenderer.receiveHuddleMediaJoinDescriptor(descriptor);
      return;
    }
    if (mediaSession === undefined) return;
    const currentStatus = mediaSession.getState().connectionStatus;
    const replacing = hasConnectedRef.current ||
      (currentStatus !== "idle" && currentStatus !== "closed");
    hasConnectedRef.current = true;
    const handoff = replacing
      ? mediaSession.rejoin(descriptor)
      : mediaSession.connect(descriptor);
    void handoff.catch(() => undefined);
  }, [
    context,
    mediaSession,
    pending,
    props.conversationId,
    props.mediaRenderer,
    view?.media,
    isJoined,
  ]);

  if (view?.media.state === "unavailable") return null;

  const sessionConnected = mediaState?.connectionStatus === "connected";
  const unavailable = props.disabled === true ||
    pending !== undefined ||
    mediaOperation !== undefined;
  const statusMessage = pending === undefined
    ? lifecycleMessage(canonical?.status)
    : controlLabelByOperation[pending];
  const unavailableReason = props.disabled === true
    ? "Huddle controls are unavailable."
    : pending !== undefined
      ? `${statusMessage}`
      : mediaOperation !== undefined
        ? "Another media action is in progress."
        : undefined;
  if (props.presentation === "header") {
    const action = canonical?.status === "inactive" && props.permissions.canStart
      ? { label: "Start huddle", onPress: actions.startHuddle }
      : (canonical?.status === "starting" || canonical?.status === "active") &&
          !isJoined && props.permissions.canJoin
        ? { label: "Join huddle", onPress: actions.joinHuddle }
        : undefined;
    if (!props.providerReady || unavailable || action === undefined) return null;
    return createElement(
      "button",
      {
        "aria-label": action.label,
        className: [
          "handrail-chat__huddle-header-button",
          props.className,
        ].filter(Boolean).join(" "),
        "data-handrail-huddle-header-control": "",
        "data-huddle-status": canonical?.status,
        onClick: () => { void action.onPress().catch(() => undefined); },
        title: action.label,
        type: "button",
      },
      createElement(
        "svg",
        {
          "aria-hidden": true,
          className: "handrail-chat__huddle-header-icon",
          fill: "none",
          focusable: "false",
          stroke: "currentColor",
          strokeLinecap: "round",
          strokeLinejoin: "round",
          strokeWidth: 2,
          viewBox: "0 0 24 24",
        },
        createElement("path", { d: "M4 13v-1a8 8 0 0 1 16 0v1" }),
        createElement("path", { d: "M6 12H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v-7Z" }),
        createElement("path", { d: "M18 12h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2v-7Z" }),
      ),
    );
  }
  const primaryControls: ReactElement[] = [];
  const detailControls: ReactElement[] = [];
  const addControl = (
    target: ReactElement[],
    key: string,
    label: string,
    permitted: boolean,
    onPress: () => Promise<unknown>,
    additionallyUnavailable = false,
    additionalUnavailableReason?: string,
  ) => {
    const resolvedUnavailableReason = additionallyUnavailable
      ? additionalUnavailableReason
      : unavailableReason;
    target.push(createElement(HuddleButton, {
      key,
      label,
      permitted,
      unavailable: unavailable || additionallyUnavailable,
      ...(resolvedUnavailableReason === undefined
        ? {}
        : { unavailableReason: resolvedUnavailableReason }),
      onPress,
    }));
  };

  const leaveHuddle = async (): Promise<unknown> => {
    const result = actions.leaveHuddle();
    await mediaSession?.leave().catch(() => undefined);
    return result;
  };
  const endHuddle = async (): Promise<unknown> => {
    const result = actions.endHuddle();
    await mediaSession?.leave().catch(() => undefined);
    return result;
  };
  const rejoinHuddle = async (): Promise<unknown> => {
    handoffMarkerRef.current = undefined;
    return actions.rejoinHuddle();
  };
  const setMicrophoneMuted = async (muted: boolean): Promise<void> => {
    if (mediaSession === undefined) return;
    await runMediaOperation("microphone", () => mediaSession.setMicrophoneMuted(muted));
  };
  const updateScreenShare = async (stop: boolean): Promise<unknown> => {
    if (mediaSession === undefined) {
      return stop ? actions.clearHuddleScreenShare() : actions.setHuddleScreenShare();
    }
    return runMediaOperation("screen_share", async () => {
      if (stop) {
        if (screenShareOwnerUserId === props.currentUserId) {
          const result = await actions.clearHuddleScreenShare();
          if (result.status !== "success") return result;
        }
        await stopLocalScreenShare(mediaSession);
        return undefined;
      }

      // Request browser capture while the user's click still has activation;
      // an awaited HTTP ownership request can consume that activation.
      await mediaSession.prepareScreenShare();
      let result;
      try {
        result = await actions.setHuddleScreenShare();
      } catch (error) {
        await stopLocalScreenShare(mediaSession).catch(() => undefined);
        throw error;
      }
      const resultOwnsShare = result.status === "success" &&
        (result.state.status === "starting" || result.state.status === "active") &&
        result.state.screenShareOwnerUserId === props.currentUserId;
      if (!resultOwnsShare) {
        await stopLocalScreenShare(mediaSession).catch(() => undefined);
        return result;
      }
      try {
        await mediaSession.startScreenShare();
      } catch {
        await actions.clearHuddleScreenShare().catch(() => undefined);
        await stopLocalScreenShare(mediaSession).catch(() => undefined);
        throw new Error("Screen sharing could not be started.");
      }
      return result;
    });
  };

  switch (canonical?.status) {
    case "inactive":
      addControl(
        primaryControls,
        "start",
        "Start huddle",
        props.permissions.canStart,
        actions.startHuddle,
      );
      break;
    case "starting":
      if (!isJoined) {
        addControl(
          primaryControls,
          "join",
          "Join huddle",
          props.permissions.canJoin,
          actions.joinHuddle,
        );
      }
      addControl(detailControls, "end", "End huddle", props.permissions.canEnd, endHuddle);
      break;
    case "active":
      if (isJoined) {
        addControl(
          primaryControls,
          "leave",
          "Leave huddle",
          props.permissions.canLeave,
          leaveHuddle,
        );
        if (view?.media.state === "rejoin_required") {
          addControl(
            primaryControls,
            "rejoin",
            "Rejoin huddle",
            props.permissions.canRejoin,
            rejoinHuddle,
          );
        }
        if (mediaSession !== undefined && mediaState !== undefined) {
          addControl(
            primaryControls,
            mediaState.microphoneMuted ? "unmute" : "mute",
            mediaState.microphoneMuted ? "Unmute microphone" : "Mute microphone",
            props.permissions.canControlMicrophone,
            () => setMicrophoneMuted(!mediaState.microphoneMuted),
            !sessionConnected,
            "Connect to huddle media to control the microphone.",
          );
        }
        const ownsScreenShare = screenShareOwnerUserId === props.currentUserId;
        const shouldStopScreenShare = ownsScreenShare || mediaState?.screenShareActive === true;
        addControl(
          detailControls,
          shouldStopScreenShare ? "stop-sharing" : "start-sharing",
          shouldStopScreenShare ? "Stop screen sharing" : "Start screen sharing",
          props.permissions.canShareScreen,
          () => updateScreenShare(shouldStopScreenShare),
          (mediaSession !== undefined && !sessionConnected) ||
            (screenShareOwnerUserId !== null && !ownsScreenShare),
          screenShareOwnerUserId !== null && !ownsScreenShare
            ? "Another participant is already sharing their screen."
            : "Connect to huddle media to share your screen.",
        );
      } else {
        addControl(
          primaryControls,
          "join",
          "Join huddle",
          props.permissions.canJoin,
          actions.joinHuddle,
        );
      }
      addControl(detailControls, "end", "End huddle", props.permissions.canEnd, endHuddle);
      break;
    default:
      break;
  }

  const retryableRuntimeError = query.status === "error" &&
    query.error.retryable &&
    view !== undefined &&
    (view.hydrationStatus === "error" || view.media.state === "error");
  if (retryableRuntimeError) {
    addControl(
      primaryControls,
      "retry",
      "Retry huddle",
      props.permissions.canRetry,
      view.hydrationStatus === "error" ? actions.hydrateHuddle : actions.retryHuddle,
    );
  }

  const owner = screenShareOwnerUserId === null
    ? undefined
    : participants.find((participant) => participant.userId === screenShareOwnerUserId);
  const screenShareMessage = owner === undefined
    ? "No one is sharing their screen."
    : `${labelParticipant(owner)} is sharing their screen.`;
  const speakingParticipantIds = new Set(
    mediaState?.activeSpeakers
      .filter((speaker) => speaker.isSpeaking)
      .map((speaker) => speaker.participantId) ?? [],
  );
  const rootClassName = [
    "handrail-chat",
    "handrail-chat--huddle-controls",
    canonical?.status === "inactive"
      ? "handrail-chat--huddle-inactive"
      : "handrail-chat--huddle-live",
    props.className,
  ].filter(Boolean).join(" ");
  const deviceUnavailable = unavailable || !sessionConnected;
  const selectDevice = (
    kind: ChatHuddleMediaDeviceKind,
    deviceId: string | null,
  ): Promise<void> => runMediaOperation(
    "device",
    () => mediaSession?.selectDevice(kind, deviceId) ?? Promise.resolve(),
  ).then(() => undefined);
  const joinedParticipantCount = joinedParticipants.length;
  const participantSummary = `${joinedParticipantCount} ${
    joinedParticipantCount === 1 ? "participant" : "participants"
  }`;
  const speakingLabels = joinedParticipants
    .filter((participant) => speakingParticipantIds.has(participant.userId))
    .map(labelParticipant);
  const hasDetails = canonical !== undefined && canonical.status !== "inactive";

  return createElement(
    "section",
    {
      "aria-busy": query.status === "loading" ||
        pending !== undefined ||
        mediaOperation !== undefined ||
        mediaState?.connectionStatus === "connecting" ||
        mediaState?.connectionStatus === "disconnecting",
      "aria-label": props.ariaLabel ?? "Huddle controls",
      className: rootClassName,
      "data-handrail-huddle-controls": "",
      "data-huddle-status": canonical?.status ?? "loading",
    },
    createElement(
      "div",
      { className: "handrail-chat__huddle-summary" },
      createElement(
        "span",
        { "aria-hidden": true, className: "handrail-chat__huddle-mark" },
        createElement(
          "svg",
          {
            "aria-hidden": true,
            className: "handrail-chat__huddle-icon handrail-chat__huddle-mark-icon",
            fill: "none",
            focusable: "false",
            stroke: "currentColor",
            strokeLinecap: "round",
            strokeLinejoin: "round",
            strokeWidth: 2,
            viewBox: "0 0 24 24",
          },
          createElement("path", { d: "M4 13v-1a8 8 0 0 1 16 0v1" }),
          createElement("path", { d: "M6 12H5a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h2v-7Z" }),
          createElement("path", { d: "M18 12h1a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-2v-7Z" }),
        ),
      ),
      createElement(
        "div",
        { className: "handrail-chat__huddle-summary-copy" },
        createElement("h2", { className: "handrail-chat__huddle-title" }, "Huddle"),
        createElement(
          "p",
          {
            "aria-live": "polite",
            className: "handrail-chat__huddle-status",
            role: "status",
          },
          statusMessage,
        ),
      ),
      canonical === undefined || canonical.status === "inactive"
        ? null
        : createElement(
            "div",
            {
              "aria-label": participantSummary,
              className: "handrail-chat__huddle-participant-summary",
            },
            createElement(
              "span",
              { "aria-hidden": true, className: "handrail-chat__huddle-avatars" },
              joinedParticipants.slice(0, 3).map((participant) => createElement(
                "span",
                {
                  className: "handrail-chat__huddle-avatar",
                  key: participant.userId,
                },
                labelParticipant(participant).trim().charAt(0).toUpperCase() || "?",
              )),
            ),
            createElement("span", null, participantSummary),
          ),
      mediaState === undefined
        ? null
        : createElement(
            "p",
            {
              className: "handrail-chat__huddle-connection",
              role: "status",
            },
            connectionMessage(mediaState.connectionStatus),
          ),
      primaryControls.length === 0
        ? null
        : createElement(
            "div",
            {
              "aria-label": "Primary huddle actions",
              className: "handrail-chat__huddle-actions handrail-chat__huddle-actions--primary",
              role: "group",
            },
            primaryControls,
          ),
      !hasDetails
        ? null
        : createElement(
            "button",
            {
              "aria-controls": detailsId,
              "aria-expanded": detailsOpen,
              "aria-haspopup": "dialog",
              "aria-label": "Open huddle details",
              className: "handrail-chat__huddle-details-trigger",
              onClick: () => {
                if (detailsOpen) {
                  closeDetails();
                  return;
                }
                setDetailsOpen(true);
              },
              ref: detailsTriggerRef,
              type: "button",
            },
            createElement(
              "svg",
              {
                "aria-hidden": true,
                className: "handrail-chat__huddle-icon handrail-chat__huddle-details-icon",
                fill: "none",
                focusable: "false",
                stroke: "currentColor",
                strokeLinecap: "round",
                strokeLinejoin: "round",
                strokeWidth: 2,
                viewBox: "0 0 24 24",
              },
              createElement("path", { d: "M5 12h.01M12 12h.01M19 12h.01" }),
            ),
            createElement("span", { className: "handrail-chat__sr-only" }, "Open huddle details"),
          ),
    ),
    query.status !== "error" &&
      mediaState?.lastFailure === undefined &&
      view?.media.state !== "rejoin_required"
      ? null
      : createElement(
          "div",
          {
            "aria-label": "Huddle attention required",
            className: "handrail-chat__huddle-attention",
          },
          query.status === "error"
            ? createElement(
                "p",
                { className: "handrail-chat__error", role: "alert" },
                query.error.message,
              )
            : null,
          mediaState?.lastFailure === undefined
            ? null
            : createElement(
                "p",
                { className: "handrail-chat__error", role: "alert" },
                mediaState.lastFailure.message,
              ),
          view?.media.state === "rejoin_required"
            ? createElement(
                "p",
                { className: "handrail-chat__huddle-rejoin", role: "status" },
                "Media rejoin required.",
              )
            : null,
        ),
    speakingLabels.length === 0
      ? null
      : createElement(
          "p",
          {
            "aria-atomic": true,
            "aria-live": "polite",
            className: "handrail-chat__sr-only",
            role: "status",
          },
          `${speakingLabels.join(", ")} ${
            speakingLabels.length === 1 ? "is" : "are"
          } speaking.`,
        ),
    !hasDetails
      ? null
      : createElement(
          "div",
          {
            "aria-labelledby": detailsTitleId,
            className: "handrail-chat__huddle-details",
            hidden: !detailsOpen,
            id: detailsId,
            ref: detailsRef,
            role: "dialog",
          },
          createElement(
            "div",
            { className: "handrail-chat__huddle-details-header" },
            createElement(
              "h3",
              { className: "handrail-chat__huddle-details-title", id: detailsTitleId },
              "Huddle details",
            ),
            createElement(
              "button",
              {
                "aria-label": "Close huddle details",
                className: "handrail-chat__huddle-details-close",
                onClick: closeDetails,
                ref: detailsCloseRef,
                type: "button",
              },
              createElement(
                "svg",
                {
                  "aria-hidden": true,
                  className: "handrail-chat__huddle-icon handrail-chat__huddle-details-close-icon",
                  fill: "none",
                  focusable: "false",
                  stroke: "currentColor",
                  strokeLinecap: "round",
                  strokeLinejoin: "round",
                  strokeWidth: 2,
                  viewBox: "0 0 24 24",
                },
                createElement("path", { d: "m6 6 12 12M18 6 6 18" }),
              ),
            ),
          ),
          mediaState === undefined
            ? null
            : createElement(
                "div",
                {
                  "aria-label": "Huddle media state",
                  className: "handrail-chat__huddle-media-state",
                },
                createElement(
                  "p",
                  null,
                  mediaState.microphoneMuted ? "Microphone muted." : "Microphone unmuted.",
                ),
                mediaState.devices.devices.length === 0
                  ? createElement("p", null, "No media devices are available.")
                  : createElement(
                      "div",
                      { "aria-label": "Media devices" },
                      createElement(DeviceSelect, {
                        kind: "audio_input",
                        label: "Microphone device",
                        mediaState,
                        permitted: props.permissions.canSelectDevices,
                        unavailable: deviceUnavailable,
                        ...(unavailableReason === undefined
                          ? {}
                          : { unavailableReason }),
                        onSelect: selectDevice,
                      }),
                      createElement(DeviceSelect, {
                        kind: "audio_output",
                        label: "Speaker device",
                        mediaState,
                        permitted: props.permissions.canSelectDevices,
                        unavailable: deviceUnavailable,
                        ...(unavailableReason === undefined
                          ? {}
                          : { unavailableReason }),
                        onSelect: selectDevice,
                      }),
                      createElement(DeviceSelect, {
                        kind: "video_input",
                        label: "Camera device",
                        mediaState,
                        permitted: props.permissions.canSelectDevices,
                        unavailable: deviceUnavailable,
                        ...(unavailableReason === undefined
                          ? {}
                          : { unavailableReason }),
                        onSelect: selectDevice,
                      }),
                    ),
              ),
          createElement("h4", null, "Participants"),
          createElement(
            "ul",
            { "aria-label": "Huddle participants" },
            participants.map((participant) => {
              const participantLabel = labelParticipant(participant);
              return createElement(
                "li",
                { key: participant.userId },
                participantLabel,
                participant.status === "left" ? " (left)" : null,
                participant.status === "joined" && speakingParticipantIds.has(participant.userId)
                  ? createElement(
                      "span",
                      {
                        "aria-label": `${participantLabel} is speaking`,
                        className: "handrail-chat__huddle-active-speaker",
                      },
                      " (speaking)",
                    )
                  : null,
              );
            }),
          ),
          createElement(
            "p",
            { className: "handrail-chat__huddle-screen-share" },
            screenShareMessage,
          ),
          detailControls.length === 0
            ? null
            : createElement(
                "div",
                {
                  "aria-label": "Additional huddle actions",
                  className: "handrail-chat__huddle-actions handrail-chat__huddle-actions--details",
                  role: "group",
                },
                detailControls,
              ),
        ),
  );
}

/** Accessible provider-neutral huddle lifecycle and session media controls. */
export function HuddleControls(props: HuddleControlsProps): ReactElement | null {
  const context = useChat();
  if (
    context?.state.state === "ready" &&
    !huddlesEnabled(context.state.enabledFeatures)
  ) return null;
  if (context === null) {
    if (props.presentation === "header") return null;
    return createElement(
      "section",
      {
        "aria-label": props.ariaLabel ?? "Huddle controls",
        className: [
          "handrail-chat",
          "handrail-chat--huddle-controls",
          props.className,
        ].filter(Boolean).join(" "),
        "data-handrail-huddle-controls": "",
      },
      createElement(
        "p",
        { className: "handrail-chat__error", role: "alert" },
        "Huddle controls must be rendered inside ChatProvider.",
      ),
    );
  }
  return createElement(ConnectedHuddleControls, { ...props, providerReady: context.isReady });
}
