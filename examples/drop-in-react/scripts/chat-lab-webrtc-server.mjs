import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";

export const CHAT_LAB_MEDIA_PATH = "/__chat-lab/media";

function hasSameOrigin(request, trustHandrailLoopbackProxy) {
  try {
    const origin = new URL(request.headers.origin);
    if (origin.host === request.headers.host) return true;
    // Handrail preserves the public host/protocol in forwarded headers, but
    // rewrites Host on WebSocket upgrades. Trust that contract only on the
    // loopback-bound lab, from a loopback peer, for a Handrail HTTPS preview.
    const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
    return trustHandrailLoopbackProxy && loopback.includes(request.socket.remoteAddress) &&
      origin.protocol === "https:" && origin.port === "" &&
      origin.hostname.endsWith(".dev.handrail-daas.com") &&
      request.headers["x-forwarded-proto"] === "https" &&
      request.headers["x-forwarded-host"] === origin.host;
  } catch { return false; }
}

/** Real, bounded three-participant WebRTC signaling for the development lab.
 * Media travels between browsers; this server authenticates room admission and
 * routes SDP/ICE only. Credentials are single-use and never placed in URLs.
 */
export function createChatLabWebRtcServer({
  now = Date.now,
  tokenTtlMs = 60_000,
  authorizeParticipant = async () => false,
  captureParticipation = async () => undefined,
  releaseParticipation = async () => {},
  heartbeatMs = 5_000,
  cleanupGraceMs = 1_000,
  iceServers = [],
  trustHandrailLoopbackProxy = false,
} = {}) {
  for (const value of [tokenTtlMs, heartbeatMs, cleanupGraceMs]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("Media lifecycle intervals must be positive integers");
  }
  if (!Array.isArray(iceServers) || iceServers.some((server) =>
    !server || (typeof server.urls !== "string" &&
      !(Array.isArray(server.urls) && server.urls.every((url) => typeof url === "string"))))) {
    throw new Error("CHAT_LAB_ICE_SERVERS must be a JSON array of RTCIceServer objects");
  }
  const rooms = new Map();
  const credentials = new Map();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  let detach;
  let closed = false;
  // Admission, token renewal and durable cleanup share one room queue. A close
  // callback cannot race a newer admitted connection into losing membership.
  const serial = (room, action) => {
    const result = room.tail.then(action);
    room.tail = result.catch(() => {});
    return result;
  };
  const participationKey = (grant) => JSON.stringify([grant.userId,
    grant.participation?.huddleSessionId, grant.participation?.joinedAt]);
  const prune = () => {
    for (const [token, grant] of credentials) {
      if (grant.expiresAt <= now()) credentials.delete(token);
    }
  };
  const send = (socket, packet) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 256 * 1024) {
      socket.close(1008, "Media signaling backpressure");
      return;
    }
    socket.send(JSON.stringify(packet));
  };
  const broadcast = (room, packet, except) => {
    for (const peer of room.peers.values()) {
      if (peer.id !== except) send(peer.socket, packet);
    }
  };
  const remove = (peer) => {
    if (!peer || !peer.room.peers.delete(peer.id)) return;
    peer.record.cleanupAt = now() + cleanupGraceMs;
    broadcast(peer.room, { type: "peer-left", peerId: peer.id });
  };
  const cleanup = async (room, force = false) => {
    prune();
    for (const [key, record] of room.participations) {
      if (!force && (record.cleanupAt > now() ||
          [...room.peers.values()].some(peer => peer.record === record && peer.socket.readyState === WebSocket.OPEN) ||
          [...credentials.values()].some(grant => grant.roomId === room.roomId && participationKey(grant) === key))) continue;
      await releaseParticipation(record.grant);
      room.participations.delete(key);
    }
  };
  const destroyRoom = (roomId) => {
    const room = rooms.get(roomId);
    if (!room) return;
    rooms.delete(roomId);
    for (const [token, grant] of credentials) {
      if (grant.roomId === roomId) credentials.delete(token);
    }
    for (const peer of room.peers.values()) {
      send(peer.socket, { type: "ended" });
      peer.socket.close(1000, "Huddle ended");
    }
    room.peers.clear();
  };
  const adapter = {
    async createRoom({ actor, conversationId }) {
      if (closed || rooms.size >= 100) throw new Error("Media rooms unavailable");
      const roomId = randomUUID();
      rooms.set(roomId, { roomId, tenantId: actor.tenantId, conversationId, peers: new Map(),
        participations: new Map(), tail: Promise.resolve() });
      return { roomId };
    },
    async createParticipantToken({ actor, roomId, permissions }) {
      prune();
      const room = rooms.get(roomId);
      if (closed || !room || room.tenantId !== actor.tenantId || credentials.size >= 300) {
        throw new Error("Media room unavailable");
      }
      return serial(room, async () => {
        const participation = await captureParticipation({ roomId, actor });
        if (closed || !rooms.has(roomId)) throw new Error("Media room unavailable");
        const token = randomBytes(32).toString("base64url");
        const expiresAt = now() + tokenTtlMs;
        const grant = { roomId, tenantId: actor.tenantId, userId: actor.userId,
          actor: { ...actor, roles: [...actor.roles] }, permissions, expiresAt, participation,
          cleanupId: randomUUID() };
        credentials.set(token, grant);
        const key = participationKey(grant);
        if (!room.participations.has(key)) room.participations.set(key, { grant, cleanupAt: expiresAt });
        return {
          token: JSON.stringify({ version: 1, token }),
          expiresAt: new Date(expiresAt).toISOString(),
        };
      });
    },
    async terminateRoom({ actor, roomId }) {
      const room = rooms.get(roomId);
      if (room && room.tenantId !== actor.tenantId) throw new Error("Media room unavailable");
      destroyRoom(roomId);
    },
  };

  wss.on("connection", (socket) => {
    let peer;
    let tail = Promise.resolve();
    let windowStart = now();
    let packets = 0;
    const authTimer = setTimeout(() => socket.close(1008, "Media admission timed out"), 5_000);
    authTimer.unref();
    socket.on("error", () => {});
    socket.on("pong", () => { if (peer) peer.alive = true; });
    socket.on("close", () => { clearTimeout(authTimer); remove(peer); });
    socket.on("message", (bytes, binary) => {
      if (now() - windowStart > 1_000) { windowStart = now(); packets = 0; }
      if (binary || ++packets > 100) {
        socket.close(1008, "Invalid media signaling");
        return;
      }
      tail = tail.then(async () => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const packet = JSON.parse(bytes.toString());
        if (!peer) {
          prune();
          const grant = packet?.type === "authenticate" && typeof packet.token === "string"
            ? credentials.get(packet.token) : undefined;
          if (!grant) throw new Error("Admission denied");
          const room = rooms.get(grant.roomId);
          if (!room) throw new Error("Admission denied");
          await serial(room, async () => {
            // Consume inside the same queue, including concurrent token reuse.
            if (credentials.get(packet.token) !== grant || grant.expiresAt <= now()) throw new Error("Admission denied");
            credentials.delete(packet.token);
            const record = room.participations.get(participationKey(grant));
            if (!record) throw new Error("Admission denied");
            record.cleanupAt = now() + cleanupGraceMs;
            if (!(await authorizeParticipant(grant))) throw new Error("Admission denied");
            // A canonical Leave→Join supersedes old-incarnation devices. Free
            // their slots before admitting the rejoin; same-incarnation devices
            // remain valid and are never replaced just for sharing an identity.
            for (const previous of room.peers.values()) {
              if (previous.userId === grant.userId && previous.record !== record) {
                remove(previous);
                previous.socket.terminate();
              }
            }
            if (closed || room.peers.size >= 3 || !rooms.has(room.roomId) || socket.readyState !== WebSocket.OPEN) {
              throw new Error("Room unavailable");
            }
            // Canonical participation is user-scoped. Keep surviving devices;
            // only the last authenticated media connection releases that user.
            peer = { id: randomUUID(), userId: grant.userId, room, grant, record, socket, alive: true };
            const others = [...room.peers.values()].map(({ id, userId }) => ({ id, userId }));
            room.peers.set(peer.id, peer);
            clearTimeout(authTimer);
            send(socket, { type: "welcome", peerId: peer.id, userId: peer.userId, peers: others, iceServers });
            broadcast(room, { type: "peer-joined", peer: { id: peer.id, userId: peer.userId } }, peer.id);
          });
          return;
        }
        if (packet?.type !== "signal" || typeof packet.target !== "string" ||
            typeof packet.payload !== "object" || packet.payload === null ||
            !(await authorizeParticipant(peer.grant))) throw new Error("Invalid signaling");
        const target = peer.room.peers.get(packet.target);
        if (!target || target === peer) return;
        send(target.socket, { type: "signal", from: peer.id, payload: packet.payload });
      }).catch(() => socket.close(1008, "Media admission or signaling rejected"));
    });
  });

  // Detect silent transport loss too: WebSocket protocol pongs need no client
  // unload handler or application packet. SQL failure retries on the next tick.
  let checking = false;
  const heartbeat = setInterval(async () => {
    if (checking || closed) return;
    checking = true;
    try {
      prune();
      for (const room of rooms.values()) {
        await serial(room, async () => {
          for (const peer of room.peers.values()) {
            if (!peer.alive || !(await authorizeParticipant(peer.grant).catch(() => false))) {
              remove(peer);
              peer.socket.terminate();
            } else {
              peer.alive = false;
              peer.socket.ping();
            }
          }
          await cleanup(room);
        }).catch(() => { /* Retain cleanup records for the next heartbeat. */ });
      }
    } finally { checking = false; }
  }, heartbeatMs);
  heartbeat.unref();

  return {
    adapter,
    attach(httpServer) {
      if (closed || detach) throw new Error("Media server already attached or closed");
      const upgrade = (request, socket, head) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        if (url.pathname !== CHAT_LAB_MEDIA_PATH) return;
        const sameOrigin = hasSameOrigin(request, trustHandrailLoopbackProxy);
        if (!sameOrigin || url.search !== "" || closed || wss.clients.size >= 320) {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws));
      };
      httpServer.on("upgrade", upgrade);
      detach = () => httpServer.off("upgrade", upgrade);
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      detach?.();
      const closingRooms = [...rooms.values()];
      for (const roomId of [...rooms.keys()]) destroyRoom(roomId);
      credentials.clear();
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
      // Provider shutdown while SQL remains available is also a loss boundary.
      const results = await Promise.allSettled(closingRooms.map(room => serial(room, () => cleanup(room, true))));
      const errors = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, "Media participation cleanup failed");
    },
  };
}
