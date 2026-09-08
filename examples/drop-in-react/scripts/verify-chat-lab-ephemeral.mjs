import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { EMPTY_EPHEMERAL_SIGNAL_STATE, reduceEphemeralSignal, presenceSignalKey } from "@handrail/chat/client";
import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import { chatLabBackendProvenance } from "./chat-lab-provenance.mjs";

// Run against the supervised dev instance, without starting a fixture server
// or changing its clock. The observer never contributes presence/typing support.
const origin = process.argv[2] ?? "http://127.0.0.1:4167";
const actor = process.argv[4] ?? "grace";
const sockets = [];
const events = [];
const checks = [];
let reducer = EMPTY_EPHEMERAL_SIGNAL_STATE;
const get = async (pathname, token) => {
  const response = await fetch(new URL(pathname, origin), {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, 200, pathname);
  return response;
};
const waitFor = async (predicate, label) => {
  for (let attempt = 0; attempt < 250; attempt++) {
    const result = predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
};
let sequence = 0;
const connect = async (token, observe = false, expectedActor = actor) => {
  const url = new URL("/api/chat/_realtime", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  sockets.push(socket);
  const messages = [];
  let error;
  socket.on("error", (value) => { error = value; });
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString());
    messages.push(frame);
    if (observe && ["typing.signal", "presence.signal"].includes(frame.type)) {
      events.push(frame);
      reducer = reduceEphemeralSignal(reducer, frame, Date.now());
    }
  });
  await waitFor(() => {
    if (error) throw error;
    return socket.readyState === WebSocket.OPEN;
  }, "socket open");
  const send = (frame) => socket.send(JSON.stringify(frame));
  send({ clientPackageVersion: "0.1.76", protocolVersion: CHAT_PROTOCOL_VERSION });
  const accepted = await waitFor(() => messages.find((frame) => frame.type === "chat.session.accepted"), "handshake");
  assert.equal(accepted.actorStreamId, `user:${expectedActor}`);
  accepted.userId = accepted.actorStreamId.slice("user:".length);
  return { socket, send, accepted, messages };
};
const subscribe = async (connection, streamId) => {
  const requestId = `provenance-${++sequence}`;
  connection.send({ type: "chat.subscribe", requestId, streamId });
  await waitFor(() => connection.messages.find((frame) =>
    frame.type === "chat.subscription.accepted" && frame.requestId === requestId), "subscription");
};
const disconnect = async (connection) => {
  connection.socket.close();
  await waitFor(() => connection.socket.readyState === WebSocket.CLOSED, "disconnect");
};

try {
  const before = await (await get("/__chat-lab/instance")).json();
  assert.match(before.instanceId, /^[a-f0-9]{32}$/u);
  assert.equal(before.backend?.scheme, chatLabBackendProvenance.scheme);
  assert.equal(before.backend?.fingerprint, chatLabBackendProvenance.fingerprint,
    "Live loaded functions must match a fresh process importing the completed disk build");
  checks.push("Live loaded backend fingerprint matches fresh disk-build imports");
  const token = await (await get(`/__chat-lab/session?actor=${encodeURIComponent(actor)}`)).text();
  const listing = await (await get("/api/chat/conversations?scope=organization&limit=20", token)).json();
  const conversation = listing.items.find((item) => item.visibility === "private");
  assert.ok(conversation);
  const observer = await connect(token, true);
  await subscribe(observer, `user:${observer.accepted.userId}`);
  await subscribe(observer, conversation.id);
  const emit = async (connection, type, state) => {
    const typing = type === "typing.signal";
    const sentAtMs = Date.now() + ++sequence;
    const sentAt = new Date(sentAtMs).toISOString();
    const count = events.length;
    connection.send({
      eventId: `provenance-${sequence}`, protocolVersion: CHAT_PROTOCOL_VERSION,
      tenantId: connection.accepted.tenantId,
      streamId: typing ? conversation.id : `user:${connection.accepted.userId}`,
      type, occurredAt: sentAt,
      payload: {
        capability: typing ? "typing" : "presence", durability: "ephemeral",
        actorUserId: connection.accepted.userId,
        deviceId: connection.accepted.deviceId, sessionId: connection.accepted.sessionId,
        sequence, sentAt, expiresAt: new Date(sentAtMs + (typing ? 10_000 : 60_000)).toISOString(), state,
        scope: typing
          ? { type: "conversation", conversationId: conversation.id, visibility: "private", audience: "members" }
          : { type: "user_private", userId: connection.accepted.userId },
      },
    });
    await waitFor(() => events.length > count, `${type} ${state}`);
    assert.equal(events.at(-1).type, type);
    assert.equal(events.at(-1).payload.state, state);
    assert.equal(events.at(-1).payload.sessionId, connection.accepted.sessionId);
  };
  const outsiderActor = actor === "grace" ? "margaret" : "grace";
  const outsiderToken = await (await get(`/__chat-lab/session?actor=${outsiderActor}`)).text();
  const outsider = await connect(outsiderToken, false, outsiderActor);
  await subscribe(outsider, `user:${outsiderActor}`);
  const deniedRequest = `private-denied-${++sequence}`;
  outsider.send({ type: "chat.subscribe", requestId: deniedRequest, streamId: `user:${actor}` });
  const denied = await waitFor(() => outsider.messages.find(frame => frame.requestId === deniedRequest), "private subscription denial");
  assert.notEqual(denied.type, "chat.subscription.accepted");
  const active = (pair) => Object.values(reducer.presence)
    .filter(event => pair.some(owner => owner.accepted.sessionId === event.payload.sessionId)
      && event.payload.state !== "offline").map(event => event.payload.sessionId).sort();
  for (const cleanup of ["explicit offline", "disconnect", "expiry"]) {
    for (const departingIndex of [0, 1]) {
      const pair = [await connect(token), await connect(token)];
      const departing = pair[departingIndex];
      const survivor = pair[1 - departingIndex];
      const presenceState = owner => owner === pair[0] ? "online" : "away";
      for (const owner of pair) {
        await emit(owner, "presence.signal", presenceState(owner));
        if (cleanup === "disconnect") await emit(owner, "typing.signal", "start");
      }
      assert.deepEqual(active(pair), pair.map(owner => owner.accepted.sessionId).sort());
      const start = events.length;
      let survivorEvent = events.findLast(event => event.type === "presence.signal"
        && event.payload.sessionId === survivor.accepted.sessionId);
      if (cleanup === "explicit offline") await emit(departing, "presence.signal", "offline");
      else if (cleanup === "disconnect") await disconnect(departing);
      else {
        // Real server timers: leave the departing socket open for 63 seconds,
        // refreshing only its peer every 15 seconds.
        const started = Date.now();
        for (let refresh = 0; refresh < 4; refresh++) {
          await delay(Math.max(0, started + (refresh + 1) * 15_000 - Date.now()));
          await emit(survivor, "presence.signal", presenceState(survivor));
          survivorEvent = events.at(-1);
        }
        await delay(Math.max(0, started + 63_000 - Date.now()));
        assert.equal(departing.socket.readyState, WebSocket.OPEN);
      }
      const offline = await waitFor(() => events.slice(start).find(event => event.type === "presence.signal"
        && event.payload.sessionId === departing.accepted.sessionId && event.payload.state === "offline"), "departing owner offline");
      assert.equal(offline.payload.deviceId, departing.accepted.deviceId);
      assert.equal(reducer.presence[presenceSignalKey(survivorEvent)], survivorEvent);
      assert.deepEqual(active(pair), [survivor.accepted.sessionId]);
      if (cleanup === "disconnect") {
        await waitFor(() => events.slice(start).find(event => event.type === "typing.signal"
          && event.payload.sessionId === departing.accepted.sessionId && event.payload.state === "stop"), "departing typing stop");
        assert.ok(Object.values(reducer.typing).some(event => event.payload.sessionId === survivor.accepted.sessionId
          && event.payload.state === "start"));
      }
      const finalStart = events.length;
      if (cleanup === "disconnect") await disconnect(survivor);
      else await emit(survivor, "presence.signal", "offline");
      await waitFor(() => events.slice(finalStart).find(event => event.type === "presence.signal"
        && event.payload.sessionId === survivor.accepted.sessionId && event.payload.state === "offline"), "final owner offline");
      assert.deepEqual(active(pair), []);
      for (const owner of pair) if (owner.socket.readyState === WebSocket.OPEN) await disconnect(owner);
      checks.push(`${cleanup}, ${departingIndex === 0 ? "A" : "B"} first: owner offline, peer unchanged, then zero active sessions`);
      console.log(checks.at(-1));
    }
  }
  await delay(150);
  assert.equal(outsider.messages.filter(frame => frame.type === "presence.signal").length, 0);
  checks.push("Private audience: outsider subscription denied and no presence delivered");
  const owners = new Map();
  for (const event of events) {
    const payload = event.payload;
    const key = JSON.stringify([event.tenantId, payload.actorUserId, payload.deviceId, payload.sessionId]);
    const sentAt = Date.parse(payload.sentAt);
    assert.ok(sentAt > (owners.get(key) ?? -Infinity), "sentAt strictly increases across both signal types per owner");
    assert.equal(event.occurredAt, payload.sentAt);
    assert.equal(Date.parse(payload.expiresAt) - sentAt, event.type === "typing.signal" ? 10_000 : 60_000);
    owners.set(key, sentAt);
  }
  assert.equal(owners.size, 12);
  checks.push("Strict per-owner sentAt across both types; occurredAt equals sentAt; TTLs stay 10000/60000 ms");
  const after = await (await get("/__chat-lab/instance")).json();
  assert.deepEqual(after, before, "QA must finish on the same backend instance");
  const report = { checkedAt: new Date().toISOString(), origin, instance: before,
    backendPackageVersion: listing._meta.packageVersion, checks, events };
  if (process.argv[3]) await writeFile(process.argv[3], `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ instanceId: before.instanceId, fingerprint: before.backend.fingerprint,
    checks, eventCount: events.length }, null, 2));
} finally {
  for (const socket of sockets) {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}
