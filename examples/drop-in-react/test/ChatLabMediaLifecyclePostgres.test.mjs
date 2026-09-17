import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { startChatLabBackend } from '../scripts/chat-lab-backend.mjs';
import { createChatLabWebRtcServer } from '../scripts/chat-lab-webrtc-server.mjs';
import { createChatLabMediaLifecycle } from '../scripts/chat-lab-media-lifecycle.mjs';
const { startHuddle, joinHuddle, leaveHuddle, setHuddleScreenShare } = await import('@handrail/chat/server');
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.CHAT_LAB_DATABASE_CHECK_URL;
assert.ok(databaseUrl, 'Use the existing owned disposable PostgreSQL runner');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, label, timeout = 5_000) {
  const began = Date.now();
  do { if (await check()) return Date.now() - began; await pause(20); } while (Date.now() - began < timeout);
  assert.fail(`Timed out: ${label}`);
}

async function setup(t) {
  let backend;
  const lifecycle = createChatLabMediaLifecycle(() => backend);
  const released = [], admitted = [];
  const provider = createChatLabWebRtcServer({ ...lifecycle, heartbeatMs: 100, cleanupGraceMs: 80, tokenTtlMs: 1_500,
    authorizeParticipant: async grant => { const result = await lifecycle.authorizeParticipant(grant); if (result) admitted.push(grant); return result; },
    releaseParticipation: async grant => { await lifecycle.releaseParticipation(grant); released.push(grant); },
  });
  const server = createServer(); const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    try { await provider.close(); }
    finally {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await backend?.harness.teardown();
    }
  });
  backend = await startChatLabBackend({ databaseUrl, media: provider.adapter });
  provider.attach(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const actor = backend.actors.find(value => value.id === 'ada').actor;
  const common = { database: backend.harness.pool, schema: backend.harness.schema, permissions: backend.harness.adapters.permissions, actor };
  let seq = 0;
  const started = await startHuddle({ ...common, media: provider.adapter, mediaEnabled: true, input: { operation: 'start_huddle', conversationId: backend.conversationIds.publicChannel, idempotencyKey: `qa-start-${++seq}` } });
  const id = started.state.huddleSessionId;
  const join = () => joinHuddle({ ...common, media: provider.adapter, mediaEnabled: true, input: { operation: 'join_huddle', huddleSessionId: id, idempotencyKey: `qa-join-${++seq}` } });
  const leave = () => leaveHuddle({ ...common, input: { operation: 'leave_huddle', huddleSessionId: id, idempotencyKey: `qa-leave-${++seq}` } });
  const share = () => setHuddleScreenShare({ ...common, maxActiveScreenSharers: 1, input: { operation: 'set_huddle_screen_share', huddleSessionId: id, intent: 'set', idempotencyKey: `qa-share-${++seq}` } });
  const state = async () => (await backend.harness.pool.query(`SELECT p.joined_at::text, p.left_at::text, p.leave_reason, s.active_screen_share_owner_user_id AS owner FROM chat_huddle_participants p JOIN chat_huddle_sessions s ON s.id=p.huddle_session_id AND s.tenant_id=p.tenant_id WHERE p.huddle_session_id=$1 AND p.user_id='ada'`, [id])).rows[0];
  const events = async () => (await backend.harness.pool.query("SELECT event_id,payload FROM chat_outbox_events WHERE payload->>'operation'='leave_huddle' AND payload->'state'->>'huddleSessionId'=$1", [id])).rows;
  const connect = async (material, options = {}) => {
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/__chat-lab/media`, { origin, ...options }); sockets.push(socket);
    await once(socket, 'open');
    const welcome = new Promise((resolve, reject) => {
      socket.once('message', bytes => { const value = JSON.parse(bytes); if (value.type === 'welcome') resolve(value); else reject(new Error('No welcome')); });
      socket.once('close', () => reject(new Error('Admission closed')));
    });
    socket.send(JSON.stringify({ type: 'authenticate', token: JSON.parse(material.descriptor ?? material.token).token }));
    await welcome; return socket;
  };
  const anotherGrant = async () => {
    const roomId = (await backend.harness.pool.query('SELECT provider_room_reference FROM chat_huddle_sessions WHERE id=$1', [id])).rows[0].provider_room_reference;
    return provider.adapter.createParticipantToken({ actor, roomId, permissions: { audio: true, video: true, screenShare: true } });
  };
  return { provider, backend, lifecycle, released, admitted, join, leave, share, state, events, connect, anotherGrant, started, id };
}

test('same-user surviving authenticated peer retains canonical share; final duplicate disconnect leaves once', async t => {
  const f = await setup(t), first = await f.connect((await f.join()).mediaJoin), second = await f.connect(await f.anotherGrant());
  await f.share(); const before = await f.state(); first.terminate(); first.terminate();
  await pause(450); const surviving = await f.state();
  assert.equal(second.readyState, WebSocket.OPEN); assert.equal(surviving.left_at, null); assert.equal(surviving.owner, 'ada'); assert.equal(surviving.joined_at, before.joined_at); assert.equal((await f.events()).length, 0);
  second.terminate(); await eventually(async () => (await f.state()).left_at !== null, 'last peer cleanup');
  assert.equal((await f.state()).owner, null); assert.equal((await f.state()).leave_reason, 'disconnect'); assert.equal((await f.events()).length, 1);
  await f.lifecycle.releaseParticipation(f.admitted[0]); assert.equal((await f.events()).length, 1, 'duplicate provider callback remains idempotent');
});

test('delayed old authenticated session cleanup cannot release a newer rejoin or ownership', async t => {
  const f = await setup(t), old = await f.connect((await f.join()).mediaJoin); await f.share();
  const oldSecond = await f.connect(await f.anotherGrant()), oldThird = await f.connect(await f.anotherGrant());
  assert.equal(oldSecond.readyState, WebSocket.OPEN); assert.equal(oldThird.readyState, WebSocket.OPEN);
  const oldGrant = f.admitted[0], before = await f.state();
  await f.leave(); const current = await f.connect((await f.join()).mediaJoin); await f.share();
  const after = await f.state(); assert.notEqual(after.joined_at, before.joined_at);
  await f.lifecycle.releaseParticipation(oldGrant); old.terminate(); await pause(450);
  assert.equal(current.readyState, WebSocket.OPEN); assert.deepEqual(await f.state(), after); assert.equal((await f.events()).length, 1, 'only explicit old leave emitted');
});

test('silent signaling loss without protocol pongs expires canonical participation and ownership', async t => {
  const f = await setup(t); await f.connect((await f.join()).mediaJoin, { autoPong: false }); await f.share();
  const elapsedMs = await eventually(async () => (await f.state()).left_at !== null, 'no-pong expiry');
  assert.equal((await f.state()).owner, null); assert.equal((await f.events()).length, 1);
  t.diagnostic(`Actual protocol ping/pong loss; accelerated100ms heartbeat/80ms grace; observed cleanup${elapsedMs}ms`);
});

test('unused authenticated join grant expires without a socket or unload callback', async t => {
  const f = await setup(t); await f.join(); await f.share();
  const elapsedMs = await eventually(async () => (await f.state()).left_at !== null, 'unused grant expiry');
  assert.equal((await f.state()).owner, null); assert.equal((await f.events()).length, 1);
  t.diagnostic(`Unconsumed grant TTL1500ms; observed cleanup${elapsedMs}ms`);
});

test('provider shutdown releases canonical owner while storage and canonical commands remain live', async t => {
  const f = await setup(t); const socket = await f.connect((await f.join()).mediaJoin); await f.share();
  await f.provider.close(); await eventually(() => socket.readyState === WebSocket.CLOSED, 'provider socket close');
  assert.equal((await f.state()).owner, null); assert.notEqual((await f.state()).left_at, null); assert.equal((await f.events()).length, 1);
  assert.equal((await f.backend.harness.pool.query('SELECT 1 AS available')).rows[0].available, 1);
});
