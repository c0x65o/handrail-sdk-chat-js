import type {
  ChatHuddleMediaAdapter, ChatHuddleMediaAdapterConnection,
  ChatHuddleMediaAdapterState, ChatHuddleMediaDeviceKind,
  HuddleMediaJoinDescriptor,
} from "@handrail/chat/client";

export interface LabRemoteMedia {
  readonly id: string;
  readonly userId: string;
  readonly audio: MediaStream;
  readonly video: MediaStream;
  readonly screenShareActive: boolean;
  readonly connectionState: RTCPeerConnectionState;
}
export interface LabMediaView {
  readonly connected: boolean;
  readonly peers: readonly LabRemoteMedia[];
  readonly localScreen?: MediaStream;
  readonly error?: string;
  readonly outputDeviceId?: string;
}
interface Peer {
  id: string;
  userId: string;
  pc: RTCPeerConnection;
  audio: MediaStream;
  video: MediaStream;
  audioSender: RTCRtpSender;
  videoSender: RTCRtpSender;
  makingOffer: boolean;
  ignoreOffer: boolean;
  settingAnswer: boolean;
  screenShareActive: boolean;
  tail: Promise<void>;
}

/** Browser WebRTC adapter used only by the real-stack development lab. */
export class ChatLabWebRtcAdapter implements ChatHuddleMediaAdapter {
  #view: LabMediaView = { connected: false, peers: [] };
  #listeners = new Set<() => void>();
  getView = (): LabMediaView => this.#view;
  subscribeView = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  async connect(descriptor: HuddleMediaJoinDescriptor): Promise<ChatHuddleMediaAdapterConnection> {
    if (!globalThis.isSecureContext || typeof RTCPeerConnection === "undefined") {
      throw new Error("Browser media requires a secure context and WebRTC.");
    }
    const credential = JSON.parse(descriptor.descriptor) as { version?: unknown; token?: unknown };
    if (credential.version !== 1 || typeof credential.token !== "string") throw new Error("Invalid media credential");
    const connection = new LabWebRtcConnection((view) => {
      this.#view = view;
      for (const listener of this.#listeners) listener();
    });
    await connection.open(credential.token);
    return connection;
  }
}

class LabWebRtcConnection implements ChatHuddleMediaAdapterConnection {
  #socket: WebSocket | undefined;
  #self = "";
  #iceServers: RTCIceServer[] = [];
  #peers = new Map<string, Peer>();
  #listeners = new Set<() => void>();
  #tracks = new Set<MediaStreamTrack>();
  #microphone: MediaStreamTrack | undefined;
  #screen: MediaStream | undefined;
  #closed = false;
  #error: string | undefined;
  #state: ChatHuddleMediaAdapterState = {
    connectionStatus: "reconnecting", microphoneMuted: true, screenShareActive: false,
    devices: { devices: [] }, activeSpeakers: [],
  };
  constructor(private readonly publishView: (view: LabMediaView) => void) {}
  getState = (): ChatHuddleMediaAdapterState => this.#state;
  getLocalTracks = (): readonly MediaStreamTrack[] => [...this.#tracks];
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #publish(change: Partial<ChatHuddleMediaAdapterState> = {}): void {
    this.#state = { ...this.#state, ...change };
    this.publishView({
      connected: !this.#closed && this.#state.connectionStatus === "connected",
      peers: [...this.#peers.values()].map((peer) => ({
        id: peer.id, userId: peer.userId, audio: peer.audio, video: peer.video,
        screenShareActive: peer.screenShareActive, connectionState: peer.pc.connectionState,
      })),
      ...(this.#screen ? { localScreen: this.#screen } : {}),
      ...(this.#error ? { error: this.#error } : {}),
      ...(this.#state.devices.selectedAudioOutputId
        ? { outputDeviceId: this.#state.devices.selectedAudioOutputId } : {}),
    });
    for (const listener of this.#listeners) listener();
  }
  #send(packet: object): void {
    if (this.#socket?.readyState === WebSocket.OPEN) this.#socket.send(JSON.stringify(packet));
  }
  #signal(peer: Peer, payload: object): void {
    this.#send({ type: "signal", target: peer.id, payload });
  }
  #shareState(peer: Peer): void {
    this.#signal(peer, { state: { screenShareActive: this.#state.screenShareActive } });
  }
  async open(token: string): Promise<void> {
    const url = new URL("/__chat-lab/media", globalThis.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.#socket = socket;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Media connection timed out")), 10_000);
        let welcomed = false;
        const failed = () => {
          clearTimeout(timer);
          if (!welcomed) reject(new Error("Media connection unavailable"));
          if (!this.#closed) {
            this.#error = welcomed
              ? "The media connection closed. Leave and join the huddle again."
              : "The huddle connection failed before microphone access could be requested. Leave and join the huddle again.";
            void this.disconnect();
          }
        };
        socket.onopen = () => { this.#send({ type: "authenticate", token }); token = ""; };
        socket.onerror = failed;
        socket.onclose = failed;
        socket.onmessage = (event) => {
          try {
            const packet = JSON.parse(String(event.data));
            if (packet.type === "welcome" && !welcomed) {
              welcomed = true;
              clearTimeout(timer);
              this.#self = packet.peerId;
              this.#iceServers = packet.iceServers;
              this.#publish({ connectionStatus: "connected" });
              for (const peer of packet.peers) this.#addPeer(peer.id, peer.userId);
              resolve();
            } else if (packet.type === "peer-joined") {
              this.#addPeer(packet.peer.id, packet.peer.userId);
            } else if (packet.type === "peer-left") {
              this.#removePeer(packet.peerId);
            } else if (packet.type === "signal") {
              const peer = this.#peers.get(packet.from);
              if (peer) {
                peer.tail = peer.tail.then(() => this.#receive(peer, packet.payload)).catch(() => {
                  if (!this.#closed) {
                    this.#error = "A participant could not connect. Rejoin, or check the network relay configuration.";
                    this.#publish();
                  }
                });
              }
            } else if (packet.type === "ended") {
              void this.disconnect();
            }
          } catch { failed(); }
        };
      });
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }
  #addPeer(id: string, userId: string): void {
    if (this.#closed || this.#peers.has(id)) return;
    const pc = new RTCPeerConnection({ iceServers: this.#iceServers });
    const peer: Peer = {
      id, userId, pc, audio: new MediaStream(), video: new MediaStream(),
      audioSender: pc.addTransceiver("audio", { direction: "sendrecv" }).sender,
      videoSender: pc.addTransceiver("video", { direction: "sendrecv" }).sender,
      makingOffer: false, ignoreOffer: false, settingAnswer: false,
      screenShareActive: false, tail: Promise.resolve(),
    };
    this.#peers.set(id, peer);
    pc.ontrack = ({ track }) => {
      const stream = track.kind === "audio" ? peer.audio : peer.video;
      stream.addTrack(track);
      track.onunmute = () => this.#publish();
      track.onended = () => { stream.removeTrack(track); this.#publish(); };
      this.#publish();
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.#signal(peer, { candidate: candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.#error = "A participant's media connection failed. Rejoin, or configure a TURN relay for this network.";
      }
      this.#publish();
    };
    // Perfect negotiation handles simultaneous joins without offer collisions.
    pc.onnegotiationneeded = async () => {
      // Both fixed transceivers exist up front. Choose one initial offerer so
      // joining a room does not race two initial offers/transceiver rollbacks.
      if (this.#self < peer.id && pc.remoteDescription === null) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.#signal(peer, { description: pc.localDescription });
      } catch {
        if (!this.#closed) { this.#error = "Media negotiation failed. Leave and join again."; this.#publish(); }
      } finally { peer.makingOffer = false; }
    };
    void peer.audioSender.replaceTrack(this.#microphone ?? null).catch(() => {});
    void peer.videoSender.replaceTrack(this.#state.screenShareActive ? this.#screen?.getVideoTracks()[0] ?? null : null).catch(() => {});
    this.#shareState(peer);
    this.#publish();
  }
  async #receive(peer: Peer, payload: {
    description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit;
    state?: { screenShareActive?: boolean };
  }): Promise<void> {
    if (this.#closed || peer.pc.connectionState === "closed") return;
    const pc = peer.pc;
    if (payload.state) {
      peer.screenShareActive = payload.state.screenShareActive === true;
      this.#publish();
    } else if (payload.description) {
      const description = payload.description;
      const ready = !peer.makingOffer && (pc.signalingState === "stable" || peer.settingAnswer);
      const collision = description.type === "offer" && !ready;
      peer.ignoreOffer = this.#self < peer.id && collision;
      if (peer.ignoreOffer) return;
      peer.settingAnswer = description.type === "answer";
      try { await pc.setRemoteDescription(description); } finally { peer.settingAnswer = false; }
      if (description.type === "offer") {
        await pc.setLocalDescription();
        this.#signal(peer, { description: pc.localDescription });
      }
    } else if (payload.candidate) {
      try { await pc.addIceCandidate(payload.candidate); } catch (error) {
        if (!peer.ignoreOffer) throw error;
      }
    }
  }
  #removePeer(id: string): void {
    const peer = this.#peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.#peers.delete(id);
    this.#publish();
  }
  async #refreshDevices(): Promise<void> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (this.#closed) return;
    this.#publish({ devices: {
      ...this.#state.devices,
      devices: devices.filter((device) => device.deviceId !== "").map((device) => ({
        id: device.deviceId, label: device.label || "Media device", isDefault: device.deviceId === "default",
        kind: device.kind === "audioinput" ? "audio_input" : device.kind === "audiooutput" ? "audio_output" : "video_input",
      })),
    } });
  }
  async #acquireMicrophone(deviceId?: string): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true,
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
    });
    const track = stream.getAudioTracks()[0];
    if (!track || this.#closed) {
      stream.getTracks().forEach((item) => item.stop());
      throw new DOMException("Media connection closed", "AbortError");
    }
    track.enabled = !this.#state.microphoneMuted;
    this.#tracks.add(track);
    try { await Promise.all([...this.#peers.values()].map((peer) => peer.audioSender.replaceTrack(track))); }
    catch (error) { track.stop(); throw error; }
    if (this.#closed) { track.stop(); throw new DOMException("Media connection closed", "AbortError"); }
    this.#microphone?.stop();
    this.#microphone = track;
    track.onended = () => { if (!this.#closed) this.#publish({ microphoneMuted: true }); };
    await this.#refreshDevices();
  }
  async setMicrophoneMuted(muted: boolean): Promise<void> {
    if (!muted && (!this.#microphone || this.#microphone.readyState === "ended")) {
      await this.#acquireMicrophone(this.#state.devices.selectedAudioInputId);
    }
    if (this.#closed) return;
    if (this.#microphone) this.#microphone.enabled = !muted;
    this.#publish({ microphoneMuted: muted });
  }
  async prepareScreenShare(): Promise<void> {
    if (typeof navigator.mediaDevices?.getDisplayMedia !== "function") {
      this.#error = "This browser does not support screen sharing. Join from a browser with display capture support.";
      this.#publish();
      throw new DOMException("Screen sharing is unavailable in this browser", "NotSupportedError");
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    stream.getTracks().forEach((track) => this.#tracks.add(track));
    const track = stream.getVideoTracks()[0];
    if (this.#closed || !track) {
      stream.getTracks().forEach((item) => item.stop());
      throw new DOMException("Media connection closed", "AbortError");
    }
    this.#screen = stream;
    track.onended = () => { void this.stopScreenShare(); };
  }
  async startScreenShare(): Promise<void> {
    if (!this.#screen) await this.prepareScreenShare();
    const track = this.#screen?.getVideoTracks()[0];
    if (this.#closed || !track || track.readyState === "ended") {
      throw new DOMException("Screen capture ended", "AbortError");
    }
    try { await Promise.all([...this.#peers.values()].map((peer) => peer.videoSender.replaceTrack(track))); }
    catch (error) { await this.stopScreenShare(); throw error; }
    if (this.#closed || (track.readyState as MediaStreamTrackState) === "ended") {
      await this.stopScreenShare();
      throw new DOMException("Screen capture ended", "AbortError");
    }
    this.#publish({ screenShareActive: true });
    for (const peer of this.#peers.values()) this.#shareState(peer);
  }
  async stopScreenShare(): Promise<void> {
    this.#screen?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
    this.#screen = undefined;
    await Promise.all([...this.#peers.values()].map((peer) => peer.videoSender.replaceTrack(null).catch(() => {})));
    this.#publish({ screenShareActive: false });
    for (const peer of this.#peers.values()) this.#shareState(peer);
  }
  async selectDevice(kind: ChatHuddleMediaDeviceKind, deviceId: string | null): Promise<void> {
    if (kind === "audio_input") {
      await this.#acquireMicrophone(deviceId ?? undefined);
      this.#publish({ devices: { ...this.#state.devices, selectedAudioInputId: deviceId ?? "default" } });
    } else if (kind === "audio_output") {
      this.#publish({ devices: { ...this.#state.devices, selectedAudioOutputId: deviceId ?? "default" } });
    } else { throw new DOMException("Camera selection is not part of this huddle", "NotSupportedError"); }
  }
  async disconnect(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const track of this.#tracks) { track.onended = null; track.stop(); }
    this.#screen = undefined;
    for (const peer of this.#peers.values()) peer.pc.close();
    this.#peers.clear();
    this.#socket?.close();
    this.#publish({ connectionStatus: "disconnected", microphoneMuted: true, screenShareActive: false });
    this.#listeners.clear();
  }
}
