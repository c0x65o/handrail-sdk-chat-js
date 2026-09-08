import type { HuddleMediaJoinDescriptor } from "../contracts/huddle-session.js";

export type ChatHuddleMediaConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnecting"
  | "closed";

export type ChatHuddleMediaDeviceKind =
  | "audio_input"
  | "audio_output"
  | "video_input";

export interface ChatHuddleMediaDevice {
  readonly id: string;
  readonly kind: ChatHuddleMediaDeviceKind;
  readonly label: string;
  readonly isDefault: boolean;
}

export interface ChatHuddleMediaDeviceState {
  readonly devices: readonly ChatHuddleMediaDevice[];
  readonly selectedAudioInputId?: string;
  readonly selectedAudioOutputId?: string;
  readonly selectedVideoInputId?: string;
}

export interface ChatHuddleMediaActiveSpeaker {
  readonly participantId: string;
  readonly isSpeaking: boolean;
  readonly audioLevel?: number;
}

export type ChatHuddleMediaOperation =
  | "connect"
  | "disconnect"
  | "microphone"
  | "screen_share"
  | "device"
  | "device_change"
  | "active_speaker_change";

export type ChatHuddleMediaErrorCode =
  | "permission_denied"
  | "device_not_found"
  | "device_unavailable"
  | "operation_aborted"
  | "provider_failure"
  | "not_connected"
  | "superseded"
  | "closed";

export interface ChatHuddleMediaFailure {
  readonly code: ChatHuddleMediaErrorCode;
  readonly operation: ChatHuddleMediaOperation;
  /** Stable renderer-safe text. Provider and descriptor text is discarded. */
  readonly message: string;
  readonly retryable: boolean;
}

export interface ChatHuddleMediaState {
  readonly connectionStatus: ChatHuddleMediaConnectionStatus;
  readonly microphoneMuted: boolean;
  readonly screenShareActive: boolean;
  readonly devices: ChatHuddleMediaDeviceState;
  readonly activeSpeakers: readonly ChatHuddleMediaActiveSpeaker[];
  readonly lastFailure?: ChatHuddleMediaFailure;
}

/** Minimal browser track ownership boundary needed for deterministic teardown. */
export interface ChatHuddleLocalMediaTrack {
  stop(): void;
}

/** Provider state is copied into renderer-safe immutable session state. */
export interface ChatHuddleMediaAdapterState {
  readonly connectionStatus: "connected" | "reconnecting" | "disconnected";
  readonly microphoneMuted: boolean;
  readonly screenShareActive: boolean;
  readonly devices: ChatHuddleMediaDeviceState;
  readonly activeSpeakers: readonly ChatHuddleMediaActiveSpeaker[];
}

export type ChatHuddleMediaAdapterUnsubscribe = () => void;

export interface ChatHuddleMediaAdapterConnection {
  getState(): ChatHuddleMediaAdapterState;
  /** Returns every browser track created locally for this connection. */
  getLocalTracks(): readonly ChatHuddleLocalMediaTrack[];
  subscribe(
    listener: () => void,
    onError?: (error: unknown) => void,
  ): ChatHuddleMediaAdapterUnsubscribe;
  setMicrophoneMuted(muted: boolean): void | Promise<void>;
  /** Capture with user activation without publishing until ownership is granted. */
  prepareScreenShare?(): void | Promise<void>;
  startScreenShare(): void | Promise<void>;
  stopScreenShare(): void | Promise<void>;
  selectDevice(
    kind: ChatHuddleMediaDeviceKind,
    deviceId: string | null,
  ): void | Promise<void>;
  disconnect(): void | Promise<void>;
}

/**
 * Host-selected WebRTC/SFU boundary. Implementations must treat the descriptor
 * as secret, short-lived material and must not retain, log, stringify, or
 * serialize it.
 */
export interface ChatHuddleMediaAdapter {
  connect(
    descriptor: HuddleMediaJoinDescriptor,
  ): ChatHuddleMediaAdapterConnection | Promise<ChatHuddleMediaAdapterConnection>;
}

export type ChatHuddleMediaStateListener = (
  state: ChatHuddleMediaState,
  previous: ChatHuddleMediaState,
) => void;

const EMPTY_DEVICES: ChatHuddleMediaDeviceState = Object.freeze({
  devices: Object.freeze([]),
});

const INITIAL_STATE: ChatHuddleMediaState = Object.freeze({
  connectionStatus: "idle",
  microphoneMuted: true,
  screenShareActive: false,
  devices: EMPTY_DEVICES,
  activeSpeakers: Object.freeze([]),
});

const FAILURE_MESSAGES: Readonly<Record<ChatHuddleMediaErrorCode, string>> =
  Object.freeze({
    permission_denied: "The required media permission was not granted.",
    device_not_found: "The selected media device is unavailable.",
    device_unavailable: "The media device could not be started.",
    operation_aborted: "The media operation was interrupted.",
    provider_failure: "The media provider could not complete the operation.",
    not_connected: "The media session is not connected.",
    superseded: "The media operation was replaced by a newer session.",
    closed: "The media session is closed.",
  });

const isDeviceKind = (value: unknown): value is ChatHuddleMediaDeviceKind =>
  value === "audio_input" || value === "audio_output" || value === "video_input";

const optionalString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const immutableDeviceState = (value: unknown): ChatHuddleMediaDeviceState => {
  if (typeof value !== "object" || value === null) return EMPTY_DEVICES;
  try {
    const candidate = value as Partial<ChatHuddleMediaDeviceState>;
    const devices = Array.isArray(candidate.devices)
      ? candidate.devices.flatMap((device) => {
          if (typeof device !== "object" || device === null) return [];
          const input = device as Partial<ChatHuddleMediaDevice>;
          if (typeof input.id !== "string" || !isDeviceKind(input.kind)) return [];
          return [Object.freeze({
            id: input.id,
            kind: input.kind,
            label: typeof input.label === "string" ? input.label : "",
            isDefault: input.isDefault === true,
          })];
        })
      : [];
    const selectedAudioInputId = optionalString(candidate.selectedAudioInputId);
    const selectedAudioOutputId = optionalString(candidate.selectedAudioOutputId);
    const selectedVideoInputId = optionalString(candidate.selectedVideoInputId);
    return Object.freeze({
      devices: Object.freeze(devices),
      ...(selectedAudioInputId === undefined ? {} : { selectedAudioInputId }),
      ...(selectedAudioOutputId === undefined ? {} : { selectedAudioOutputId }),
      ...(selectedVideoInputId === undefined ? {} : { selectedVideoInputId }),
    });
  } catch {
    return EMPTY_DEVICES;
  }
};

const immutableSpeakers = (value: unknown): readonly ChatHuddleMediaActiveSpeaker[] => {
  if (!Array.isArray(value)) return Object.freeze([]);
  try {
    return Object.freeze(value.flatMap((speaker) => {
      if (typeof speaker !== "object" || speaker === null) return [];
      const input = speaker as Partial<ChatHuddleMediaActiveSpeaker>;
      if (typeof input.participantId !== "string") return [];
      const audioLevel = typeof input.audioLevel === "number" &&
          Number.isFinite(input.audioLevel)
        ? Math.max(0, Math.min(1, input.audioLevel))
        : undefined;
      return [Object.freeze({
        participantId: input.participantId,
        isSpeaking: input.isSpeaking === true,
        ...(audioLevel === undefined ? {} : { audioLevel }),
      })];
    }));
  } catch {
    return Object.freeze([]);
  }
};

const errorName = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    return typeof (error as { readonly name?: unknown }).name === "string"
      ? (error as { readonly name: string }).name
      : undefined;
  } catch {
    return undefined;
  }
};

const mapProviderErrorCode = (error: unknown): ChatHuddleMediaErrorCode => {
  switch (errorName(error)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "permission_denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "device_not_found";
    case "NotReadableError":
    case "TrackStartError":
      return "device_unavailable";
    case "AbortError":
      return "operation_aborted";
    default:
      return "provider_failure";
  }
};

const failureFor = (
  code: ChatHuddleMediaErrorCode,
  operation: ChatHuddleMediaOperation,
): ChatHuddleMediaFailure => Object.freeze({
  code,
  operation,
  message: FAILURE_MESSAGES[code],
  retryable: code === "device_not_found" ||
    code === "device_unavailable" ||
    code === "operation_aborted" ||
    code === "provider_failure",
});

export class ChatHuddleMediaError extends Error {
  readonly failure: ChatHuddleMediaFailure;

  constructor(failure: ChatHuddleMediaFailure) {
    super(failure.message);
    this.name = "ChatHuddleMediaError";
    this.failure = failure;
  }
}

const mediaError = (
  code: ChatHuddleMediaErrorCode,
  operation: ChatHuddleMediaOperation,
): ChatHuddleMediaError => new ChatHuddleMediaError(failureFor(code, operation));

const mappedProviderError = (
  error: unknown,
  operation: ChatHuddleMediaOperation,
): ChatHuddleMediaError => {
  if (error instanceof ChatHuddleMediaError &&
      Object.hasOwn(FAILURE_MESSAGES, error.failure.code)) {
    return mediaError(error.failure.code, operation);
  }
  return mediaError(mapProviderErrorCode(error), operation);
};

/**
 * Provider-neutral ownership boundary for browser huddle tracks and devices.
 * Opaque join material is handed directly to the adapter and is never stored.
 */
export class ChatHuddleMediaSession {
  readonly #adapter: ChatHuddleMediaAdapter;
  readonly #listeners = new Set<ChatHuddleMediaStateListener>();
  readonly #tracks = new WeakMap<
    ChatHuddleMediaAdapterConnection,
    Set<ChatHuddleLocalMediaTrack>
  >();
  readonly #stoppedTracks = new WeakSet<ChatHuddleLocalMediaTrack>();
  readonly #unsubscribes = new WeakMap<
    ChatHuddleMediaAdapterConnection,
    ChatHuddleMediaAdapterUnsubscribe
  >();
  readonly #cleanup = new WeakMap<ChatHuddleMediaAdapterConnection, Promise<void>>();
  readonly #pendingConnections = new Set<Promise<void>>();
  readonly #pendingCleanups = new Set<Promise<void>>();
  #state = INITIAL_STATE;
  #connection: ChatHuddleMediaAdapterConnection | undefined;
  #operationTail: Promise<void> = Promise.resolve();
  #generation = 0;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(adapter: ChatHuddleMediaAdapter) {
    if (typeof adapter !== "object" || adapter === null ||
        typeof adapter.connect !== "function") {
      throw new TypeError("Huddle media adapter is invalid");
    }
    this.#adapter = adapter;
  }

  get state(): ChatHuddleMediaState {
    return this.#state;
  }

  getState(): ChatHuddleMediaState {
    return this.#state;
  }

  subscribe(listener: ChatHuddleMediaStateListener): () => void {
    if (typeof listener !== "function") {
      throw new TypeError("Huddle media listener is invalid");
    }
    this.#listeners.add(listener);
    listener(this.#state, this.#state);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  /** Starts or replaces a connection without retaining the descriptor. */
  connect(descriptor: HuddleMediaJoinDescriptor): Promise<void> {
    return this.#startConnection(descriptor);
  }

  /** Replaces the provider connection using freshly issued join material. */
  rejoin(descriptor: HuddleMediaJoinDescriptor): Promise<void> {
    return this.#startConnection(descriptor);
  }

  setMicrophoneMuted(muted: boolean): Promise<void> {
    if (typeof muted !== "boolean") {
      return Promise.reject(new TypeError("Microphone mute state is invalid"));
    }
    return this.#enqueue("microphone", (connection) =>
      connection.setMicrophoneMuted(muted));
  }

  muteMicrophone(): Promise<void> {
    return this.setMicrophoneMuted(true);
  }

  unmuteMicrophone(): Promise<void> {
    return this.setMicrophoneMuted(false);
  }

  startScreenShare(): Promise<void> {
    return this.#enqueue("screen_share", (connection) =>
      connection.startScreenShare());
  }

  /** Optional provider preparation before awaiting server screen-share ownership. */
  prepareScreenShare(): Promise<void> {
    return this.#enqueue("screen_share", (connection) => connection.prepareScreenShare?.());
  }

  stopScreenShare(): Promise<void> {
    return this.#enqueue("screen_share", (connection) =>
      connection.stopScreenShare());
  }

  selectDevice(
    kind: ChatHuddleMediaDeviceKind,
    deviceId: string | null,
  ): Promise<void> {
    if (!isDeviceKind(kind) ||
        (deviceId !== null && (typeof deviceId !== "string" || deviceId.length === 0))) {
      return Promise.reject(new TypeError("Media device selection is invalid"));
    }
    return this.#enqueue("device", (connection) =>
      connection.selectDevice(kind, deviceId));
  }

  selectAudioInput(deviceId: string | null): Promise<void> {
    return this.selectDevice("audio_input", deviceId);
  }

  selectAudioOutput(deviceId: string | null): Promise<void> {
    return this.selectDevice("audio_output", deviceId);
  }

  selectVideoInput(deviceId: string | null): Promise<void> {
    return this.selectDevice("video_input", deviceId);
  }

  /** Tears down media after the canonical huddle leave succeeds or begins. */
  leave(): Promise<void> {
    return this.disconnect();
  }

  /** Tears down all media when the owning chat identity changes. */
  handleIdentityChange(): Promise<void> {
    return this.disconnect();
  }

  disconnect(): Promise<void> {
    return this.#disconnect(false);
  }

  close(): Promise<void> {
    return this.#closePromise ??= this.#disconnect(true);
  }

  #startConnection(descriptor: HuddleMediaJoinDescriptor): Promise<void> {
    if (this.#closed) return Promise.reject(mediaError("closed", "connect"));
    if (typeof descriptor !== "object" || descriptor === null) {
      return Promise.reject(new TypeError("Huddle media join descriptor is invalid"));
    }

    const generation = ++this.#generation;
    const previous = this.#connection;
    this.#connection = undefined;
    this.#publish({
      connectionStatus: "connecting",
      microphoneMuted: true,
      screenShareActive: false,
      devices: EMPTY_DEVICES,
      activeSpeakers: Object.freeze([]),
    });

    let candidate: Promise<ChatHuddleMediaAdapterConnection>;
    try {
      // This is the only descriptor handoff. It is not copied into a field,
      // closure, diagnostic, renderer state, or provider error.
      candidate = Promise.resolve(this.#adapter.connect(descriptor));
    } catch (error) {
      candidate = Promise.reject(error);
    }

    const attempt = this.#finishConnection(generation, previous, candidate);
    this.#pendingConnections.add(attempt);
    void attempt.then(
      () => this.#pendingConnections.delete(attempt),
      () => this.#pendingConnections.delete(attempt),
    );
    return attempt;
  }

  async #finishConnection(
    generation: number,
    previous: ChatHuddleMediaAdapterConnection | undefined,
    candidate: Promise<ChatHuddleMediaAdapterConnection>,
  ): Promise<void> {
    if (previous !== undefined) {
      await this.#cleanupConnection(previous).catch(() => undefined);
    }

    let connection: ChatHuddleMediaAdapterConnection;
    try {
      connection = await candidate;
      if (typeof connection !== "object" || connection === null) throw new TypeError();
    } catch (error) {
      if (generation !== this.#generation || this.#closed) {
        throw mediaError(this.#closed ? "closed" : "superseded", "connect");
      }
      const mapped = mappedProviderError(error, "connect");
      this.#publishIdle(mapped.failure);
      throw mapped;
    }

    this.#rememberTracks(connection);
    if (generation !== this.#generation || this.#closed) {
      await this.#cleanupConnection(connection).catch(() => undefined);
      throw mediaError(this.#closed ? "closed" : "superseded", "connect");
    }

    try {
      const unsubscribe = connection.subscribe(
        () => this.#handleAdapterChange(connection, generation),
        (error) => this.#handleAdapterError(connection, generation, error),
      );
      if (typeof unsubscribe !== "function") throw new TypeError();
      this.#unsubscribes.set(connection, unsubscribe);
      this.#connection = connection;
      this.#applyAdapterState(connection, generation);
    } catch (error) {
      await this.#cleanupConnection(connection).catch(() => undefined);
      if (generation !== this.#generation || this.#closed) {
        throw mediaError(this.#closed ? "closed" : "superseded", "connect");
      }
      const mapped = mappedProviderError(error, "connect");
      this.#publishIdle(mapped.failure);
      throw mapped;
    }
  }

  #enqueue(
    operation: ChatHuddleMediaOperation,
    action: (connection: ChatHuddleMediaAdapterConnection) => void | Promise<void>,
  ): Promise<void> {
    if (this.#closed) return Promise.reject(mediaError("closed", operation));
    const result = this.#operationTail.then(async () => {
      if (this.#closed) throw mediaError("closed", operation);
      const connection = this.#connection;
      const generation = this.#generation;
      if (connection === undefined ||
          (this.#state.connectionStatus !== "connected" &&
            this.#state.connectionStatus !== "reconnecting")) {
        throw mediaError("not_connected", operation);
      }
      try {
        await action(connection);
      } catch (error) {
        this.#rememberTracks(connection);
        if (generation !== this.#generation || connection !== this.#connection) {
          this.#stopTracks(connection);
          await this.#cleanupConnection(connection).catch(() => undefined);
          throw mediaError(this.#closed ? "closed" : "superseded", operation);
        }
        const mapped = mappedProviderError(error, operation);
        this.#publish({ ...this.#state, lastFailure: mapped.failure });
        throw mapped;
      }
      this.#rememberTracks(connection);
      if (generation !== this.#generation || connection !== this.#connection) {
        this.#stopTracks(connection);
        await this.#cleanupConnection(connection).catch(() => undefined);
        throw mediaError(this.#closed ? "closed" : "superseded", operation);
      }
      this.#applyAdapterState(connection, generation);
    });
    this.#operationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async #disconnect(closing: boolean): Promise<void> {
    if (closing && this.#closed) return;
    const generation = ++this.#generation;
    const connection = this.#connection;
    this.#connection = undefined;
    if (closing) this.#closed = true;
    this.#publish({
      ...this.#state,
      connectionStatus: "disconnecting",
      activeSpeakers: Object.freeze([]),
    });

    let failure: ChatHuddleMediaError | undefined;
    if (connection !== undefined) {
      try {
        await this.#cleanupConnection(connection);
      } catch (error) {
        failure = mappedProviderError(error, "disconnect");
      }
    }
    if (closing) {
      await Promise.allSettled([
        ...this.#pendingConnections,
        ...this.#pendingCleanups,
        this.#operationTail,
      ]);
    }
    if (generation === this.#generation) {
      if (closing) {
        this.#publish({
          connectionStatus: "closed",
          microphoneMuted: true,
          screenShareActive: false,
          devices: EMPTY_DEVICES,
          activeSpeakers: Object.freeze([]),
          ...(failure === undefined ? {} : { lastFailure: failure.failure }),
        });
        this.#listeners.clear();
      } else {
        this.#publishIdle(failure?.failure);
      }
    }
    if (failure !== undefined) throw failure;
  }

  #handleAdapterChange(
    connection: ChatHuddleMediaAdapterConnection,
    generation: number,
  ): void {
    this.#rememberTracks(connection);
    if (generation !== this.#generation || connection !== this.#connection) {
      this.#stopTracks(connection);
      void this.#cleanupConnection(connection).catch(() => undefined);
      return;
    }
    this.#applyAdapterState(connection, generation);
  }

  #handleAdapterError(
    connection: ChatHuddleMediaAdapterConnection,
    generation: number,
    error: unknown,
  ): void {
    if (generation !== this.#generation || connection !== this.#connection) return;
    const mapped = mappedProviderError(error, "device_change");
    this.#publish({ ...this.#state, lastFailure: mapped.failure });
  }

  #applyAdapterState(
    connection: ChatHuddleMediaAdapterConnection,
    generation: number,
  ): void {
    if (generation !== this.#generation || connection !== this.#connection) return;
    let providerState: ChatHuddleMediaAdapterState;
    try {
      providerState = connection.getState();
    } catch (error) {
      const mapped = mappedProviderError(error, "device_change");
      this.#publish({ ...this.#state, lastFailure: mapped.failure });
      return;
    }
    this.#publish({
      connectionStatus: providerState.connectionStatus === "reconnecting"
        ? "reconnecting"
        : providerState.connectionStatus === "disconnected"
          ? "idle"
          : "connected",
      microphoneMuted: providerState.microphoneMuted === true,
      screenShareActive: providerState.screenShareActive === true,
      devices: immutableDeviceState(providerState.devices),
      activeSpeakers: immutableSpeakers(providerState.activeSpeakers),
    });
  }

  #rememberTracks(connection: ChatHuddleMediaAdapterConnection): void {
    let owned = this.#tracks.get(connection);
    if (owned === undefined) {
      owned = new Set();
      this.#tracks.set(connection, owned);
    }
    try {
      const tracks = connection.getLocalTracks();
      if (!Array.isArray(tracks)) return;
      for (const track of tracks) {
        if (typeof track === "object" && track !== null && typeof track.stop === "function") {
          owned.add(track);
        }
      }
    } catch {
      // Provider inspection failures cannot prevent known-track cleanup.
    }
  }

  #cleanupConnection(connection: ChatHuddleMediaAdapterConnection): Promise<void> {
    const active = this.#cleanup.get(connection);
    if (active !== undefined) return active;
    const cleanup = (async () => {
      const unsubscribe = this.#unsubscribes.get(connection);
      this.#unsubscribes.delete(connection);
      try {
        unsubscribe?.();
      } catch {
        // Listener cleanup continues through track and provider teardown.
      }
      this.#rememberTracks(connection);
      this.#stopTracks(connection);
      let disconnectError: unknown;
      try {
        await connection.disconnect();
      } catch (error) {
        disconnectError = error;
      }
      this.#rememberTracks(connection);
      this.#stopTracks(connection);
      this.#tracks.delete(connection);
      if (disconnectError !== undefined) throw disconnectError;
    })();
    this.#cleanup.set(connection, cleanup);
    this.#pendingCleanups.add(cleanup);
    void cleanup.then(
      () => this.#pendingCleanups.delete(cleanup),
      () => this.#pendingCleanups.delete(cleanup),
    );
    return cleanup;
  }

  #stopTracks(connection: ChatHuddleMediaAdapterConnection): void {
    const tracks = this.#tracks.get(connection);
    if (tracks === undefined) return;
    for (const track of tracks) {
      if (this.#stoppedTracks.has(track)) continue;
      this.#stoppedTracks.add(track);
      try {
        track.stop();
      } catch {
        // One provider track cannot prevent the rest from stopping.
      }
    }
    tracks.clear();
  }

  #publishIdle(lastFailure?: ChatHuddleMediaFailure): void {
    this.#publish({
      connectionStatus: "idle",
      microphoneMuted: true,
      screenShareActive: false,
      devices: EMPTY_DEVICES,
      activeSpeakers: Object.freeze([]),
      ...(lastFailure === undefined ? {} : { lastFailure }),
    });
  }

  #publish(input: ChatHuddleMediaState): void {
    const previous = this.#state;
    const next: ChatHuddleMediaState = Object.freeze({
      connectionStatus: input.connectionStatus,
      microphoneMuted: input.microphoneMuted,
      screenShareActive: input.screenShareActive,
      devices: immutableDeviceState(input.devices),
      activeSpeakers: immutableSpeakers(input.activeSpeakers),
      ...(input.lastFailure === undefined ? {} : { lastFailure: input.lastFailure }),
    });
    this.#state = next;
    for (const listener of [...this.#listeners]) {
      try {
        listener(next, previous);
      } catch {
        // Renderer failures do not cross the media ownership boundary.
      }
    }
  }
}
