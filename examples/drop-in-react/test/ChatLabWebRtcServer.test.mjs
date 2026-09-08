import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { WebSocket } from "ws";
import { createChatLabWebRtcServer } from "../scripts/chat-lab-webrtc-server.mjs";

async function setup(t, options = {}) {
  const server = createServer();
  const media = createChatLabWebRtcServer({ authorizeParticipant: async () => true, ...options });
  media.attach(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await media.close(); await new Promise((resolve) => server.close(resolve)); });
  const actor = (userId) => ({ tenantId: "tenant", userId, roles: [] });
  const room = await media.adapter.createRoom({ actor: actor("ada"), conversationId: "conversation" });
  const grant = async (userId, roomId = room.roomId) => media.adapter.createParticipantToken({
    actor: actor(userId), roomId, permissions: { audio: true, video: true, screenShare: true },
  });
  const open = async (options = {}) => {
    const socket = new WebSocket(origin.replace("http", "ws") + "/__chat-lab/media", { origin, ...options });
    const packets = [];
    const waiters = [];
    socket.on("message", (data) => {
      const packet = JSON.parse(String(data));
      const waiter = waiters.shift();
      if (waiter) waiter(packet); else packets.push(packet);
    });
    await once(socket, "open");
    return {
      socket, packets,
      next: () => packets.length ? Promise.resolve(packets.shift()) : new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Media packet timed out")), 2_000);
        waiters.push((packet) => { clearTimeout(timer); resolve(packet); });
      }),
    };
  };
  const join = async (userId, roomId) => {
    const token = JSON.parse((await grant(userId, roomId)).token).token;
    const connection = await open();
    connection.socket.send(JSON.stringify({ type: "authenticate", token }));
    const welcome = await connection.next();
    assert.equal(welcome.type, "welcome");
    return { ...connection, welcome, token };
  };
  return { media, actor, room, grant, open, join, origin };
}

test("Handrail loopback proxy upgrades admit credentials with the original HTTPS origin", async (t) => {
  const fixture = await setup(t, { trustHandrailLoopbackProxy: true });
  const origin = "https://h-test.dev.handrail-daas.com";
  const { socket, next } = await fixture.open({ origin, headers: {
    "x-forwarded-host": new URL(origin).host, "x-forwarded-proto": "https",
  } });
  const token = JSON.parse((await fixture.grant("ada")).token).token;
  socket.send(JSON.stringify({ type: "authenticate", token }));
  assert.equal((await next()).type, "welcome");
});

test("forwarded headers cannot bypass origin checks outside the configured Handrail proxy contract", async (t) => {
  for (const trustHandrailLoopbackProxy of [false, true]) {
    const fixture = await setup(t, { trustHandrailLoopbackProxy });
    for (const [origin, forwardedHost, proto] of [
      ...(!trustHandrailLoopbackProxy ? [["https://h-test.dev.handrail-daas.com", "h-test.dev.handrail-daas.com", "https"]] : []),
      ["https://unrelated.example", "unrelated.example", "https"],
      ["https://h-test.dev.handrail-daas.com", "h-other.dev.handrail-daas.com", "https"],
      ["https://h-test.dev.handrail-daas.com", "h-test.dev.handrail-daas.com", "http"],
      ["https://h-test.dev.handrail-daas.com", "h-test.dev.handrail-daas.com, evil.example", "https"],
    ]) {
      const socket = new WebSocket(fixture.origin.replace("http", "ws") + "/__chat-lab/media", {
        origin, headers: { "x-forwarded-host": forwardedHost, "x-forwarded-proto": proto },
      });
      socket.on("error", () => {});
      const [, response] = await once(socket, "unexpected-response");
      assert.equal(response.statusCode, 403);
      response.resume();
      socket.terminate();
    }
  }
});

test("three authenticated participants exchange signaling; leaving and ending remove peers", async (t) => {
  const { media, actor, room, join } = await setup(t);
  const ada = await join("ada");
  const grace = await join("grace");
  const margaret = await join("margaret");
  assert.equal(grace.welcome.peers.length, 1);
  assert.equal(margaret.welcome.peers.length, 2);
  assert.equal((await ada.next()).type, "peer-joined");
  assert.equal((await ada.next()).type, "peer-joined");
  assert.equal((await grace.next()).type, "peer-joined");
  const payload = { description: { type: "offer", sdp: "bounded test SDP" } };
  ada.socket.send(JSON.stringify({ type: "signal", target: grace.welcome.peerId, payload }));
  assert.deepEqual(await grace.next(), { type: "signal", from: ada.welcome.peerId, payload });
  margaret.socket.close();
  assert.deepEqual(await ada.next(), { type: "peer-left", peerId: margaret.welcome.peerId });
  await media.adapter.terminateRoom({ actor: actor("ada"), roomId: room.roomId });
  assert.deepEqual(await ada.next(), { type: "ended" });
});

test("expired, reused, unauthorized, and fourth-participant credentials cannot admit a socket", async (t) => {
  let now = Date.now();
  const fixture = await setup(t, { now: () => now, authorizeParticipant: async ({ userId }) => userId !== "denied" });
  const rejected = async (token) => {
    const { socket } = await fixture.open();
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ type: "authenticate", token }));
    assert.equal((await closed)[0], 1008);
  };
  const expired = JSON.parse((await fixture.grant("ada")).token).token;
  now += 60_001;
  await rejected(expired);
  await rejected(JSON.parse((await fixture.grant("denied")).token).token);
  const ada = await fixture.join("ada");
  await rejected(ada.token);
  await fixture.join("grace");
  await fixture.join("margaret");
  await rejected(JSON.parse((await fixture.grant("fourth")).token).token);
});

test("signaling cannot cross room boundaries and removed members lose signaling access", async (t) => {
  let authorized = true;
  const { media, actor, join } = await setup(t, { authorizeParticipant: async () => authorized });
  const ada = await join("ada");
  const room2 = await media.adapter.createRoom({ actor: actor("grace"), conversationId: "other" });
  const grace = await join("grace", room2.roomId);
  ada.socket.send(JSON.stringify({ type: "signal", target: grace.welcome.peerId, payload: { candidate: {} } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(grace.packets, []);
  authorized = false;
  const closed = once(ada.socket, "close");
  ada.socket.send(JSON.stringify({ type: "signal", target: grace.welcome.peerId, payload: {} }));
  assert.equal((await closed)[0], 1008);
});
