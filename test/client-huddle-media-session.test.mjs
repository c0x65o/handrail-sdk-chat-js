import assert from "node:assert/strict";
import test from "node:test";

import {
  ChatHuddleMediaError,
  ChatHuddleMediaSession,
} from "../dist/client/index.js";

const descriptorSentinel = "OPAQUE_BROWSER_MEDIA_DESCRIPTOR_SENTINEL";
const descriptor = (suffix = "") => ({
  kind: "opaque_media_join",
  descriptor: `${descriptorSentinel}${suffix}`,
  expiresAt: "2030-01-01T00:04:00.000Z",
  toJSON() {
    throw new Error("join descriptors must never be serialized");
  },
});

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

class FakeTrack {
  stopCount = 0;

  stop() {
    this.stopCount += 1;
  }
}

class FakeConnection {
  state = {
    connectionStatus: "connected",
    microphoneMuted: true,
    screenShareActive: false,
    devices: {
      devices: [
        { id: "microphone-1", kind: "audio_input", label: "Built in", isDefault: true },
        { id: "speaker-1", kind: "audio_output", label: "Speakers", isDefault: true },
      ],
      selectedAudioInputId: "microphone-1",
      selectedAudioOutputId: "speaker-1",
    },
    activeSpeakers: [],
  };
  tracks = [new FakeTrack()];
  calls = [];
  listeners = new Set();
  errorListeners = new Set();
  unsubscribeCount = 0;
  disconnectCount = 0;
  subscribeError;
  microphoneError;
  screenShareStart;

  getState() {
    return this.state;
  }

  getLocalTracks() {
    return this.tracks;
  }

  subscribe(listener, onError) {
    if (this.subscribeError) throw this.subscribeError;
    this.listeners.add(listener);
    if (onError) this.errorListeners.add(onError);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.unsubscribeCount += 1;
      this.listeners.delete(listener);
      if (onError) this.errorListeners.delete(onError);
    };
  }

  emit() {
    for (const listener of this.listeners) listener();
  }

  emitError(error) {
    for (const listener of this.errorListeners) listener(error);
  }

  async setMicrophoneMuted(muted) {
    this.calls.push(`microphone:${muted}`);
    if (this.microphoneError) throw this.microphoneError;
    this.state = { ...this.state, microphoneMuted: muted };
    this.emit();
  }

  async startScreenShare() {
    this.calls.push("screenShare:start");
    if (this.screenShareStart) await this.screenShareStart.promise;
    this.tracks.push(new FakeTrack());
    this.state = { ...this.state, screenShareActive: true };
    this.emit();
  }

  async stopScreenShare() {
    this.calls.push("screenShare:stop");
    this.state = { ...this.state, screenShareActive: false };
    this.emit();
  }

  async selectDevice(kind, deviceId) {
    this.calls.push(`device:${kind}:${deviceId}`);
    const selected = kind === "audio_input"
      ? { selectedAudioInputId: deviceId ?? undefined }
      : kind === "audio_output"
        ? { selectedAudioOutputId: deviceId ?? undefined }
        : { selectedVideoInputId: deviceId ?? undefined };
    this.state = {
      ...this.state,
      devices: { ...this.state.devices, ...selected },
    };
    this.emit();
  }

  async disconnect() {
    this.calls.push("disconnect");
    this.disconnectCount += 1;
  }
}

class FakeAdapter {
  constructor(...connections) {
    this.connections = connections;
  }

  calls = 0;
  received = [];

  connect(joinDescriptor) {
    this.calls += 1;
    this.received.push(joinDescriptor);
    const connection = this.connections.shift();
    if (connection instanceof Promise) return connection;
    if (connection?.promise instanceof Promise) return connection.promise;
    return connection;
  }
}

test("connects and projects immutable mute, screen-share, device, and active-speaker state", async () => {
  const connection = new FakeConnection();
  const adapter = new FakeAdapter(connection);
  const session = new ChatHuddleMediaSession(adapter);
  const states = [];
  const unsubscribe = session.subscribe((state) => states.push(state));
  const joinDescriptor = descriptor();

  await session.connect(joinDescriptor);
  assert.strictEqual(adapter.received[0], joinDescriptor);
  await session.unmuteMicrophone();
  await session.muteMicrophone();
  await session.startScreenShare();
  await session.stopScreenShare();
  await session.selectAudioInput("microphone-2");
  await session.selectAudioOutput("speaker-2");

  connection.state = {
    ...connection.state,
    devices: {
      devices: [
        { id: "microphone-2", kind: "audio_input", label: "USB microphone", isDefault: false },
      ],
      selectedAudioInputId: "microphone-2",
      selectedAudioOutputId: "speaker-2",
    },
    activeSpeakers: [
      { participantId: "participant-alice", isSpeaking: true, audioLevel: 0.75 },
    ],
  };
  connection.emit();

  assert.deepEqual(connection.calls.slice(0, 6), [
    "microphone:false",
    "microphone:true",
    "screenShare:start",
    "screenShare:stop",
    "device:audio_input:microphone-2",
    "device:audio_output:speaker-2",
  ]);
  assert.equal(session.state.connectionStatus, "connected");
  assert.equal(session.state.microphoneMuted, true);
  assert.equal(session.state.screenShareActive, false);
  assert.equal(session.state.devices.selectedAudioInputId, "microphone-2");
  assert.deepEqual(session.state.activeSpeakers, [
    { participantId: "participant-alice", isSpeaking: true, audioLevel: 0.75 },
  ]);
  assert.ok(Object.isFrozen(session.state));
  assert.ok(Object.isFrozen(session.state.devices));
  assert.ok(Object.isFrozen(session.state.devices.devices));
  assert.ok(Object.isFrozen(session.state.activeSpeakers));
  assert.ok(states.length >= 8);

  unsubscribe();
  await session.close();
});

test("rejoin, leave, identity change, and close stop every track and unsubscribe once", async () => {
  const first = new FakeConnection();
  const second = new FakeConnection();
  const third = new FakeConnection();
  const adapter = new FakeAdapter(first, second, third);
  const session = new ChatHuddleMediaSession(adapter);

  await session.connect(descriptor("-first"));
  await session.startScreenShare();
  await session.rejoin(descriptor("-second"));
  assert.equal(first.disconnectCount, 1);
  assert.equal(first.unsubscribeCount, 1);
  assert.ok(first.tracks.every((track) => track.stopCount === 1));

  await session.leave();
  assert.equal(second.disconnectCount, 1);
  assert.equal(second.unsubscribeCount, 1);
  assert.ok(second.tracks.every((track) => track.stopCount === 1));
  assert.equal(session.state.connectionStatus, "idle");

  await session.connect(descriptor("-third"));
  await session.handleIdentityChange();
  assert.equal(third.disconnectCount, 1);
  assert.equal(third.unsubscribeCount, 1);
  assert.ok(third.tracks.every((track) => track.stopCount === 1));

  await session.close();
  await session.close();
  assert.equal(session.state.connectionStatus, "closed");
});

test("maps arbitrary provider failures without raw error or descriptor leakage", async () => {
  const connection = new FakeConnection();
  const rawSentinel = `RAW_PROVIDER_FAILURE_${descriptorSentinel}`;
  const providerError = new Error(rawSentinel);
  providerError.name = "NotAllowedError";
  connection.microphoneError = providerError;
  const adapter = new FakeAdapter(connection);
  const session = new ChatHuddleMediaSession(adapter);

  await session.connect(descriptor("-failure"));
  await assert.rejects(
    session.unmuteMicrophone(),
    (error) => {
      assert.ok(error instanceof ChatHuddleMediaError);
      assert.equal(error.failure.code, "permission_denied");
      assert.equal(error.failure.operation, "microphone");
      assert.equal(error.failure.retryable, false);
      assert.doesNotMatch(String(error), new RegExp(rawSentinel));
      return true;
    },
  );
  connection.emitError(new Error(rawSentinel));
  assert.equal(session.state.lastFailure.code, "provider_failure");
  assert.equal(session.state.lastFailure.operation, "device_change");

  const printable = JSON.stringify({
    session,
    state: session.state,
    failure: session.state.lastFailure,
  });
  assert.doesNotMatch(printable, new RegExp(descriptorSentinel));
  assert.doesNotMatch(printable, new RegExp(rawSentinel));
  assert.deepEqual(Object.keys(session), []);
  await session.close();

  const failedConnection = new FakeConnection();
  failedConnection.subscribeError = new Error(rawSentinel);
  const failedSession = new ChatHuddleMediaSession(new FakeAdapter(failedConnection));
  await assert.rejects(
    failedSession.connect(descriptor("-failed-connect")),
    (error) => {
      assert.ok(error instanceof ChatHuddleMediaError);
      assert.equal(error.failure.code, "provider_failure");
      assert.doesNotMatch(String(error), new RegExp(rawSentinel));
      return true;
    },
  );
  assert.equal(failedConnection.disconnectCount, 1);
  assert.ok(failedConnection.tracks.every((track) => track.stopCount === 1));
  assert.doesNotMatch(JSON.stringify(failedSession), new RegExp(descriptorSentinel));
  await failedSession.close();
});

test("superseded connects and late operations cannot resurrect provider tracks or listeners", async () => {
  const lateConnect = deferred();
  const lateConnection = new FakeConnection();
  const currentConnection = new FakeConnection();
  const adapter = new FakeAdapter(lateConnect, currentConnection);
  const session = new ChatHuddleMediaSession(adapter);

  const firstConnect = session.connect(descriptor("-late"));
  const replacement = session.rejoin(descriptor("-fresh"));
  await replacement;
  lateConnect.resolve(lateConnection);
  await assert.rejects(
    firstConnect,
    (error) => error instanceof ChatHuddleMediaError && error.failure.code === "superseded",
  );
  assert.equal(lateConnection.disconnectCount, 1);
  assert.equal(lateConnection.unsubscribeCount, 0);
  assert.ok(lateConnection.tracks.every((track) => track.stopCount === 1));
  assert.equal(session.state.connectionStatus, "connected");

  currentConnection.screenShareStart = deferred();
  const lateScreenShare = session.startScreenShare();
  await flush();
  await session.leave();
  currentConnection.screenShareStart.resolve();
  await assert.rejects(
    lateScreenShare,
    (error) => error instanceof ChatHuddleMediaError && error.failure.code === "superseded",
  );
  assert.equal(currentConnection.disconnectCount, 1);
  assert.equal(currentConnection.unsubscribeCount, 1);
  assert.ok(currentConnection.tracks.every((track) => track.stopCount === 1));
  assert.equal(session.state.connectionStatus, "idle");

  await session.close();
});
