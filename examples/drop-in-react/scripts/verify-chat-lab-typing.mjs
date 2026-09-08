import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { CHAT_PROTOCOL_VERSION } from "@handrail/chat";
import { CHAT_CLIENT_PACKAGE_VERSION } from "../../../dist/client/generated/package-version.js";
import { chatLabBackendProvenance } from "./chat-lab-provenance.mjs";

// Exercise the supervised server with browser WebSockets and its served reducer.
// No replacement server, shared clock changes, or durable chat writes.
const origin = process.argv[2] ?? "http://127.0.0.1:4167";
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});
try {
  const page = await browser.newPage();
  page.on("console", message => { if (message.text().startsWith("typing QA:")) console.log(message.text()); });
  await page.goto(new URL("/chat-lab.html", origin).href);
  const before = await page.evaluate(async () => (await fetch("/__chat-lab/instance")).json());
  assert.equal(before.backend.fingerprint, chatLabBackendProvenance.fingerprint,
    "Live loaded backend must equal the completed disk build before testing");
  // Resolve the same SDK module URL that Vite serves to Chat Lab.
  const config = await (await page.request.get(new URL("/src/chat-lab-config.ts", origin).href)).text();
  const clientUrl = config.match(/from "([^"]+\/dist\/client\/index\.js[^"]*)"/u)?.[1];
  assert.ok(clientUrl, "Chat Lab's served client module URL");
  const report = await page.evaluate(async ({ clientUrl, protocolVersion, packageVersion }) => {
    const { EMPTY_EPHEMERAL_SIGNAL_STATE, reduceEphemeralSignal, typingSignalKey } = await import(clientUrl);
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async (predicate, label) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const result = predicate();
        if (result) return result;
        await delay(20);
      }
      throw new Error(`Timed out: ${label}`);
    };
    const get = async (url, token) => {
      const response = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      check(response.ok, `${url}: ${response.status}`);
      return response;
    };
    const sockets = [];
    let sequence = 0;
    const connect = async actor => {
      const token = await (await get(`/__chat-lab/session?actor=${actor}`)).text();
      const url = new URL("/api/chat/_realtime", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(token)))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
      const socket = new WebSocket(url, ["handrail-chat.v1", `handrail-chat.bearer.${encoded}`]);
      sockets.push(socket);
      const connection = { socket, token, events: [], state: EMPTY_EPHEMERAL_SIGNAL_STATE };
      socket.onmessage = ({ data }) => {
        const frame = JSON.parse(data);
        connection.events.push(frame);
        if (["typing.signal", "presence.signal"].includes(frame.type)) {
          connection.state = reduceEphemeralSignal(connection.state, frame, Date.now());
        }
      };
      connection.send = frame => socket.send(JSON.stringify(frame));
      await wait(() => socket.readyState === WebSocket.OPEN, "socket open");
      connection.send({ clientPackageVersion: packageVersion, protocolVersion });
      connection.identity = await wait(() => connection.events.find(e => e.type === "chat.session.accepted"), "handshake");
      check(connection.identity.actorStreamId === `user:${actor}`, "actor identity");
      return connection;
    };
    const subscribe = async (connection, streamId, allowed = true) => {
      const requestId = `typing-qa-${++sequence}`;
      connection.send({ type: "chat.subscribe", requestId, streamId });
      const result = await wait(() => connection.events.find(e => e.requestId === requestId), "subscribe");
      check((result.type === "chat.subscription.accepted") === allowed, "audience authorization");
    };
    const disconnect = async connection => {
      connection.socket.close();
      await wait(() => connection.socket.readyState === WebSocket.CLOSED, "disconnect");
    };
    const scenarios = [];
    try {
      const observer = await connect("grace");
      const ada = await connect("ada");
      const outsider = await connect("margaret");
      const listing = await (await get("/api/chat/conversations?scope=organization&limit=20", observer.token)).json();
      const conversation = listing.items.find(item => item.visibility === "private");
      check(conversation, "private conversation exists");
      await subscribe(observer, conversation.id);
      await subscribe(observer, "user:grace");
      await subscribe(ada, conversation.id);
      await subscribe(outsider, conversation.id, false);
      await subscribe(ada, "user:grace", false);
      const signal = (connection, type, state) => {
        const identity = connection.identity;
        const typing = type === "typing.signal";
        const sentAtMs = Date.now() + ++sequence;
        connection.send({
          eventId: `typing-qa-${sequence}`, protocolVersion, tenantId: identity.tenantId,
          streamId: typing ? conversation.id : "user:grace", type,
          occurredAt: new Date(sentAtMs).toISOString(),
          payload: {
            capability: typing ? "typing" : "presence", durability: "ephemeral", actorUserId: "grace",
            deviceId: identity.deviceId, sessionId: identity.sessionId, sequence,
            sentAt: new Date(sentAtMs).toISOString(),
            expiresAt: new Date(sentAtMs + (typing ? 10000 : 60000)).toISOString(), state,
            scope: typing ? { type: "conversation", conversationId: conversation.id, visibility: "private", audience: "members" }
              : { type: "user_private", userId: "grace" },
          },
        });
      };
      const latest = (connection, owner) => connection.events.findLast(e => e.type === "typing.signal"
        && e.payload.sessionId === owner.identity.sessionId);
      const emit = async (owner, type, state) => {
        const offset = observer.events.length;
        signal(owner, type, state);
        await wait(() => observer.events.slice(offset).find(e => e.type === type
          && e.payload.sessionId === owner.identity.sessionId && e.payload.state === state), `${type} ${state}`);
      };
      const active = (connection, pair) => Object.values(connection.state.typing).filter(e =>
        pair.some(owner => e.payload.sessionId === owner.identity.sessionId) && e.payload.state === "start");
      for (const combined of [false, true]) for (const cleanup of ["stop", "disconnect", "expiry"]) for (const first of [0, 1]) {
        // Respect the server's per-actor 20 signals/second bucket between cases.
        await delay(1100);
        console.log(`typing QA: ${combined ? "combined" : "typing"} ${cleanup}, ${first === 0 ? "A" : "B"} first`);
        const pair = [await connect("grace"), await connect("grace")];
        const departing = pair[first];
        const survivor = pair[1 - first];
        for (const owner of pair) {
          if (combined) await emit(owner, "presence.signal", owner === pair[0] ? "online" : "away");
          await emit(owner, "typing.signal", "start");
        }
        for (const viewer of [observer, ada]) await wait(() => active(viewer, pair).length === 2, "both starts reduced");
        const initial = latest(observer, departing);
        const started = Date.now();
        if (cleanup === "stop") await emit(departing, "typing.signal", "stop");
        else if (cleanup === "disconnect") await disconnect(departing);
        else {
          for (let refresh = 1; refresh <= 6; refresh++) {
            await delay(Math.max(0, started + refresh * 2000 - Date.now()));
            await emit(survivor, "typing.signal", "start");
          }
          await delay(Math.max(0, started + 13000 - Date.now()));
          check(pair.every(owner => owner.socket.readyState === WebSocket.OPEN), "expiry sockets stay open");
        }
        const snapshots = [];
        for (const viewer of [observer, ada]) {
          const stop = await wait(() => latest(viewer, departing)?.payload.state === "stop" && latest(viewer, departing), "departing wire stop");
          const peer = latest(viewer, survivor);
          check(viewer.state.typing[typingSignalKey(stop)] === stop, "departing stop reaches reducer");
          check(peer.payload.state === "start" && viewer.state.typing[typingSignalKey(peer)] === peer, "peer remains start");
          check(active(viewer, pair).length === 1, "only peer active");
          if (cleanup !== "expiry") check(Date.now() < Date.parse(initial.payload.expiresAt), "cleanup before initial TTL");
          else check(Date.parse(stop.payload.sentAt) >= Date.parse(initial.payload.expiresAt), "natural server expiry");
          snapshots.push({ viewer: viewer === observer ? "grace" : "ada", stop, peer });
        }
        if (cleanup === "disconnect") await disconnect(survivor);
        else await emit(survivor, "typing.signal", "stop");
        for (const viewer of [observer, ada]) {
          await wait(() => latest(viewer, survivor)?.payload.state === "stop", "final wire stop");
          check(active(viewer, pair).length === 0, "zero active typing after both depart");
        }
        for (const owner of pair) if (owner.socket.readyState === WebSocket.OPEN) await disconnect(owner);
        scenarios.push({ combined, cleanup, first: first === 0 ? "A" : "B", elapsedMs: Date.now() - started, snapshots });
      }
      await delay(150);
      check(!outsider.events.some(e => ["typing.signal", "presence.signal"].includes(e.type)), "outsider receives no private signals");
      check(!ada.events.some(e => e.type === "presence.signal"), "Ada receives no Grace private presence");
      const events = observer.events.filter(e => ["typing.signal", "presence.signal"].includes(e.type));
      const owners = new Set(scenarios.flatMap(s => s.snapshots.slice(0, 1).flatMap(v => [v.stop.payload.sessionId, v.peer.payload.sessionId])));
      const wire = events.filter(e => owners.has(e.payload.sessionId));
      const timestamps = new Map();
      for (const event of wire) {
        const p = event.payload;
        const sentAt = Date.parse(p.sentAt);
        check(sentAt > (timestamps.get(p.sessionId) ?? -Infinity), "strict owner timestamp order across types");
        check(event.occurredAt === p.sentAt, "occurredAt matches sentAt");
        check(Date.parse(p.expiresAt) - sentAt === (event.type === "typing.signal" ? 10000 : 60000), "wire TTL unchanged");
        timestamps.set(p.sessionId, sentAt);
      }
      return { clientUrl, backendPackageVersion: listing._meta.packageVersion, scenarios, events: wire,
        checks: ["12 typing cleanup scenarios pass through both browser reducers", "Private audience isolation", "Strict per-owner timestamp order and unchanged TTLs"] };
    } finally {
      for (const socket of sockets) socket.close();
    }
  }, { clientUrl, protocolVersion: CHAT_PROTOCOL_VERSION, packageVersion: CHAT_CLIENT_PACKAGE_VERSION });
  assert.equal(report.backendPackageVersion, CHAT_CLIENT_PACKAGE_VERSION, "Live package metadata matches build");
  const after = await page.evaluate(async () => (await fetch("/__chat-lab/instance")).json());
  assert.deepEqual(after, before, "Same supervised instance throughout verification");
  const result = { checkedAt: new Date().toISOString(), origin, instance: before, ...report };
  if (process.argv[3]) await writeFile(process.argv[3], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ instance: before, checks: report.checks, scenarios: report.scenarios.length, events: report.events.length }, null, 2));
} finally {
  await browser.close();
}
