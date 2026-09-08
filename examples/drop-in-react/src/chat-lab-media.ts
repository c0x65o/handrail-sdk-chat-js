import type {
  ChatHuddleLocalMediaTrack,
  ChatHuddleMediaAdapter,
  ChatHuddleMediaAdapterConnection,
  ChatHuddleMediaAdapterState,
  ChatHuddleMediaDeviceKind,
  HuddleMediaJoinDescriptor,
} from "@handrail/chat/client";

export interface ChatLabMediaTrackSnapshot {
  readonly kind: "microphone" | "screen_share";
  readonly stopped: boolean;
}

export interface ChatLabMediaConnectionSnapshot {
  readonly id: number;
  readonly connectionStatus: ChatHuddleMediaAdapterState["connectionStatus"];
  readonly disconnectCount: number;
  readonly tracks: readonly ChatLabMediaTrackSnapshot[];
}

export interface ChatLabMediaAdapterSnapshot {
  readonly connectionCount: number;
  readonly connections: readonly ChatLabMediaConnectionSnapshot[];
}

export type ChatLabFixtureConnectionStatus = "connected" | "reconnecting";

export const isChatLabHuddleFixtureEnabled = (url: string | URL): boolean =>
  new URL(url).searchParams.get("chatLabHuddleFixture") === "enabled";

class DeterministicLocalTrack implements ChatHuddleLocalMediaTrack {
  #stopped = false;

  constructor(readonly kind: ChatLabMediaTrackSnapshot["kind"]) {}

  get stopped(): boolean {
    return this.#stopped;
  }

  stop(): void {
    this.#stopped = true;
  }
}

const devices = Object.freeze({
  devices: Object.freeze([
    Object.freeze({
      id: "chat-lab-microphone",
      kind: "audio_input" as const,
      label: "Development microphone",
      isDefault: true,
    }),
    Object.freeze({
      id: "chat-lab-speaker",
      kind: "audio_output" as const,
      label: "Development speaker",
      isDefault: true,
    }),
  ]),
  selectedAudioInputId: "chat-lab-microphone",
  selectedAudioOutputId: "chat-lab-speaker",
});

class DeterministicChatLabMediaConnection
  implements ChatHuddleMediaAdapterConnection {
  readonly #listeners = new Set<() => void>();
  readonly #tracks: DeterministicLocalTrack[] = [
    new DeterministicLocalTrack("microphone"),
  ];
  #state: ChatHuddleMediaAdapterState = Object.freeze({
    connectionStatus: "connected",
    microphoneMuted: true,
    screenShareActive: false,
    devices,
    activeSpeakers: Object.freeze([]),
  });
  #disconnectCount = 0;

  constructor(readonly id: number) {}

  getState(): ChatHuddleMediaAdapterState {
    return this.#state;
  }

  getLocalTracks(): readonly ChatHuddleLocalMediaTrack[] {
    return this.#tracks;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  setMicrophoneMuted(muted: boolean): void {
    this.#publish({ microphoneMuted: muted });
  }

  startScreenShare(): void {
    if (!this.#state.screenShareActive) {
      this.#tracks.push(new DeterministicLocalTrack("screen_share"));
    }
    this.#publish({ screenShareActive: true });
  }

  stopScreenShare(): void {
    for (const track of this.#tracks) {
      if (track.kind === "screen_share") track.stop();
    }
    this.#publish({ screenShareActive: false });
  }

  selectDevice(kind: ChatHuddleMediaDeviceKind, deviceId: string | null): void {
    const current = this.#state.devices;
    this.#state = Object.freeze({
      ...this.#state,
      devices: Object.freeze({
        devices: current.devices,
        ...(kind === "audio_input"
          ? (deviceId === null ? {} : { selectedAudioInputId: deviceId })
          : (current.selectedAudioInputId === undefined
              ? {}
              : { selectedAudioInputId: current.selectedAudioInputId })),
        ...(kind === "audio_output"
          ? (deviceId === null ? {} : { selectedAudioOutputId: deviceId })
          : (current.selectedAudioOutputId === undefined
              ? {}
              : { selectedAudioOutputId: current.selectedAudioOutputId })),
        ...(kind === "video_input"
          ? (deviceId === null ? {} : { selectedVideoInputId: deviceId })
          : (current.selectedVideoInputId === undefined
              ? {}
              : { selectedVideoInputId: current.selectedVideoInputId })),
      }),
    });
    this.#emit();
  }

  disconnect(): void {
    this.#disconnectCount += 1;
    for (const track of this.#tracks) track.stop();
    this.#publish({
      connectionStatus: "disconnected",
      microphoneMuted: true,
      screenShareActive: false,
    });
    this.#listeners.clear();
  }

  setFixtureConnectionStatus(status: ChatLabFixtureConnectionStatus): boolean {
    if (this.#state.connectionStatus === "disconnected") return false;
    this.#publish({ connectionStatus: status });
    return true;
  }

  snapshot(): ChatLabMediaConnectionSnapshot {
    return Object.freeze({
      id: this.id,
      connectionStatus: this.#state.connectionStatus,
      disconnectCount: this.#disconnectCount,
      tracks: Object.freeze(this.#tracks.map((track) => Object.freeze({
        kind: track.kind,
        stopped: track.stopped,
      }))),
    });
  }

  #publish(change: Partial<ChatHuddleMediaAdapterState>): void {
    this.#state = Object.freeze({ ...this.#state, ...change });
    this.#emit();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/**
 * Fixture-only synthetic Chat Lab media boundary. It must only be installed by
 * the explicit huddle lifecycle fixture. The opaque descriptor is deliberately
 * ignored: it is never retained, inspected, logged, serialized, or sent on.
 */
export class DeterministicChatLabMediaAdapter implements ChatHuddleMediaAdapter {
  readonly #connections: DeterministicChatLabMediaConnection[] = [];

  connect(_descriptor: HuddleMediaJoinDescriptor): ChatHuddleMediaAdapterConnection {
    const connection = new DeterministicChatLabMediaConnection(
      this.#connections.length + 1,
    );
    this.#connections.push(connection);
    return connection;
  }

  /**
   * Publishes a bounded test-fixture transition on the current live connection.
   * It deliberately does not reconnect, replace the connection, or touch tracks.
   */
  setCurrentConnectionStatus(status: ChatLabFixtureConnectionStatus): boolean {
    if (status !== "connected" && status !== "reconnecting") {
      throw new TypeError("Chat Lab fixture connection status is unsupported");
    }
    for (let index = this.#connections.length - 1; index >= 0; index -= 1) {
      const connection = this.#connections[index];
      if (connection?.getState().connectionStatus !== "disconnected") {
        return connection?.setFixtureConnectionStatus(status) ?? false;
      }
    }
    return false;
  }

  snapshot(): ChatLabMediaAdapterSnapshot {
    return Object.freeze({
      connectionCount: this.#connections.length,
      connections: Object.freeze(this.#connections.map((connection) =>
        connection.snapshot())),
    });
  }
}

export const createChatLabHuddleFixtureMediaAdapter =
  (): DeterministicChatLabMediaAdapter =>
  new DeterministicChatLabMediaAdapter();
