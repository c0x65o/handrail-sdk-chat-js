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
  iceServers = [],
  trustHandrailLoopbackProxy = false,
} = {}) {
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
    broadcast(peer.room, { type: "peer-left", peerId: peer.id });
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
      rooms.set(roomId, { roomId, tenantId: actor.tenantId, conversationId, peers: new Map() });
      return { roomId };
    },
    async createParticipantToken({ actor, roomId, permissions }) {
      prune();
      const room = rooms.get(roomId);
      if (closed || !room || room.tenantId !== actor.tenantId || credentials.size >= 300) {
        throw new Error("Media room unavailable");
      }
      const token = randomBytes(32).toString("base64url");
      const expiresAt = now() + tokenTtlMs;
      credentials.set(token, {
        roomId, tenantId: actor.tenantId, userId: actor.userId, permissions, expiresAt,
      });
      return {
        token: JSON.stringify({ version: 1, token }),
        expiresAt: new Date(expiresAt).toISOString(),
      };
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
          credentials.delete(packet.token);
          const room = rooms.get(grant.roomId);
          if (!room || !(await authorizeParticipant(grant))) throw new Error("Admission denied");
          // A fresh join replaces this user's prior connection, never a different user.
          for (const previous of room.peers.values()) {
            if (previous.userId === grant.userId) {
              remove(previous);
              previous.socket.close(1000, "Media connection replaced");
            }
          }
          if (room.peers.size >= 3 || !rooms.has(room.roomId) || socket.readyState !== WebSocket.OPEN) {
            throw new Error("Room unavailable");
          }
          peer = { id: randomUUID(), userId: grant.userId, room, grant, socket };
          const others = [...room.peers.values()].map(({ id, userId }) => ({ id, userId }));
          room.peers.set(peer.id, peer);
          clearTimeout(authTimer);
          send(socket, { type: "welcome", peerId: peer.id, userId: peer.userId, peers: others, iceServers });
          broadcast(room, { type: "peer-joined", peer: { id: peer.id, userId: peer.userId } }, peer.id);
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

  // Revoke disconnected/removed members even if they stop sending signaling.
  let checking = false;
  const heartbeat = setInterval(async () => {
    if (checking || closed) return;
    checking = true;
    try {
      prune();
      for (const room of rooms.values()) {
        for (const peer of room.peers.values()) {
          if (!(await authorizeParticipant(peer.grant).catch(() => false))) {
            remove(peer);
            peer.socket.close(1008, "Huddle membership ended");
          }
        }
      }
    } finally { checking = false; }
  }, 5_000);
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
      for (const roomId of [...rooms.keys()]) destroyRoom(roomId);
      credentials.clear();
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
