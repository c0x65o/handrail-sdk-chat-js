import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createChatTestHarness, createPostgresTestBackend } from '@handrail/chat/testing';
import { handrailChatPostgresMigrations, createPostgresMigrationRunner } from '@handrail/chat/server';
import { manageNativeTokens } from '../dist/server/native-tokens.js';

const actor = (tenant, user, admin) => ({ credential: `${tenant}-${user}`, actor: { tenantId: tenant, userId: user, roles: [] }, capabilities: ['conversation.read', 'message.send', ...(admin ? ['native_tokens.manage'] : [])], user: { tenantId: tenant, userId: user, displayName: user } });
const admin = actor('tenant-a', 'admin', true);
const member = actor('tenant-a', 'member', false);
const otherAdmin = actor('tenant-b', 'admin', true);

test('native token additive migration supports a legacy schema and is immutable', async t => {
  const backend = await createPostgresTestBackend();
  t.after(() => backend.teardown());
  const fixture = await backend.createHarness({ schemaPrefix: 'native_upgrade' });
  const old = handrailChatPostgresMigrations.filter(m => m.id !== '0044-chat-native-tokens');
  await createPostgresMigrationRunner({ database: fixture.pool, schema: fixture.schema, migrations: old }).apply();
  const runner = createPostgresMigrationRunner({ database: fixture.pool, schema: fixture.schema, migrations: handrailChatPostgresMigrations });
  assert.equal((await runner.apply()).applied.length, 1);
  assert.equal((await runner.apply()).applied.length, 0);
});

test('native token HTTP authorization, persistence, delivery, retries and revocation', async t => {
  const harness = await createChatTestHarness({ schemaPrefix: 'native_tokens', actors: [admin, member, otherAdmin] });
  t.after(() => harness.teardown());
  const schema = `"${harness.schema}"`;
  for (const tenant of ['tenant-a', 'tenant-b']) {
    for (const id of ['allowed', 'denied']) {
      await harness.pool.query(`INSERT INTO ${schema}.chat_conversations (tenant_id,id,type,visibility,name) VALUES ($1,$2,'channel','private',$2)`, [tenant, id]);
      for (const user of ['admin', 'member']) await harness.pool.query(`INSERT INTO ${schema}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state) VALUES ($1,$2,$3,'member','active')`, [tenant, id, user]);
    }
  }
  await harness.pool.query(`INSERT INTO ${schema}.chat_conversations (tenant_id,id,type,visibility,name) VALUES ('tenant-b','foreign-only','channel','private','Foreign')`);
  const request = async (credential, path, method = 'GET', body) => {
    const response = await fetch(`${harness.endpoint}${path}`, { method, headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  // Counters are reset only inside this newly owned schema between scenarios.
  const resetLimit = () => harness.pool.query(`DELETE FROM ${schema}.chat_native_auth_limits`);
  assert.equal((await request(member.credential, '/native-tokens')).status, 403);
  assert.equal((await request(member.credential, '/native-tokens', 'POST', { name: 'forbidden', channelIds: ['allowed'] })).status, 403);
  assert.equal((await request(admin.credential, '/native-tokens', 'POST', { name: 'spoof', channelIds: ['allowed'], tenantId: 'tenant-b' })).status, 400);
  assert.equal((await request(admin.credential, '/native-tokens', 'POST', { name: 'foreign', channelIds: ['foreign-only'] })).status, 403);
  const created = await request(admin.credential, '/native-tokens', 'POST', { name: 'Contact form', channelIds: ['allowed'] });
  assert.equal(created.status, 200);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const { token, secret } = created.body;
  assert.ok(/^hrnt_[A-Za-z0-9_-]{43}$/.test(secret), 'secure opaque credential');
  const listing = await request(admin.credential, '/native-tokens');
  assert.equal(listing.body.tokens[0].name, 'Contact form');
  assert.equal(JSON.stringify(listing.body).includes(secret), false);
  assert.equal(JSON.stringify(listing.body).includes('verifier'), false);
  const stored = (await harness.pool.query(`SELECT * FROM ${schema}.chat_native_tokens`)).rows[0];
  assert.equal(stored.verifier === createHash('sha256').update(secret).digest('hex'), true);
  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.deepEqual((await request(otherAdmin.credential, '/native-tokens')).body.tokens, []);
  assert.equal((await request(otherAdmin.credential, `/native-tokens/${token.id}`, 'DELETE')).status, 404);
  assert.equal((await request(member.credential, `/native-tokens/${token.id}`, 'DELETE')).status, 403);
  await resetLimit();
  const payload = { channelId: 'allowed', text: 'Synthetic contact: please contact the demo team.', idempotencyKey: 'contact-1' };
  assert.equal((await request('invalid', '/native-inbound/messages', 'POST', payload)).status, 401);
  assert.equal((await request(secret, '/native-tokens')).status, 401);
  assert.equal((await request(secret, '/conversations')).status, 401);
  for (const extra of [{ tenantId: 'tenant-b' }, { author: { userId: 'admin' } }, { roles: ['admin'] }]) {
    assert.equal((await request(secret, '/native-inbound/messages', 'POST', { ...payload, ...extra })).status, 400);
  }
  assert.equal((await request(secret, '/native-inbound/messages', 'POST', { ...payload, channelId: 'denied' })).status, 403);
  const accepted = await request(secret, '/native-inbound/messages', 'POST', payload);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.message.author.userId, token.senderUserId);
  assert.equal(accepted.body.message.tenantId, 'tenant-a');
  await resetLimit();
  const retries = await Promise.all([request(secret, '/native-inbound/messages', 'POST', payload), request(secret, '/native-inbound/messages', 'POST', payload)]);
  for (const retry of retries) {
    assert.equal(retry.status, 200);
    assert.equal(retry.body.reconciliationStatus, 'replayed');
    assert.equal(retry.body.message.id, accepted.body.message.id);
  }
  assert.equal((await request(secret, '/native-inbound/messages', 'POST', { ...payload, text: 'conflict' })).status, 409);
  await harness.pool.query(`DELETE FROM ${schema}.chat_idempotency_keys WHERE user_id=$1`, [token.senderUserId]);
  assert.equal((await request(secret, '/native-inbound/messages', 'POST', payload)).body.reconciliationStatus, 'replayed');
  const persisted = await harness.pool.query(`SELECT tenant_id,author_user_id,content FROM ${schema}.chat_messages`);
  assert.equal(persisted.rowCount, 1);
  assert.equal(persisted.rows[0].content.text, payload.text);
  assert.equal(persisted.rows[0].tenant_id, 'tenant-a');
  assert.equal(persisted.rows[0].author_user_id, token.senderUserId);
  assert.equal((await harness.pool.query(`SELECT 1 FROM ${schema}.chat_message_revisions`)).rowCount, 1);
  const outbox = await harness.pool.query(`SELECT payload FROM ${schema}.chat_outbox_events WHERE tenant_id='tenant-a' AND type='message.created'`);
  assert.equal(outbox.rowCount, 1);
  assert.equal(outbox.rows[0].payload.message.author.userId, token.senderUserId);
  await resetLimit();
  await harness.pool.query(`UPDATE ${schema}.chat_conversation_members SET state='removed' WHERE user_id=$1`, [token.senderUserId]);
  assert.equal((await request(secret, '/native-inbound/messages', 'POST', payload)).status, 403);
  await harness.pool.query(`UPDATE ${schema}.chat_conversation_members SET state='active' WHERE user_id=$1`, [token.senderUserId]);
  await harness.pool.query(`UPDATE ${schema}.chat_conversations SET entity_type='project',entity_id='synthetic' WHERE tenant_id='tenant-a' AND id='allowed'`);
  harness.setEntityAuthorization(false);
  assert.equal((await request(secret, '/native-inbound/messages', 'POST', payload)).status, 403);
  assert.equal((await request(secret, '/native-inbound/messages', 'POST', { ...payload, idempotencyKey: 'blocked-new' })).status, 403);
  harness.setEntityAuthorization(true);
  const timeline = await request(admin.credential, '/conversations/allowed/messages');
  assert.equal(timeline.status, 200);
  assert.ok(JSON.stringify(timeline.body).includes(accepted.body.message.id));
  const directory = await request(admin.credential, '/directory/users:batch', 'POST', { userIds: [token.senderUserId] });
  assert.equal(directory.status, 200);
  assert.ok(JSON.stringify(directory.body).includes('Contact form (integration)'));
  assert.equal((await request(admin.credential, `/native-tokens/${token.id}`, 'DELETE')).status, 200);
  assert.equal((await request(secret, '/native-inbound/messages', 'POST', payload)).status, 401);
  assert.equal((await request(secret, '/native-inbound/messages', 'POST', { ...payload, idempotencyKey: 'new' })).status, 401);
  assert.equal(JSON.stringify(harness.calls.all()).includes(secret), false, 'credential never reaches host adapter call log');
  await resetLimit();
  for (let i = 0; i < 10; i++) assert.equal((await request('bad', '/native-inbound/messages', 'POST', payload)).status, 401);
  const limited = await request('another-invalid-token', '/native-inbound/messages', 'POST', payload);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  await harness.pool.query(`UPDATE ${schema}.chat_native_auth_limits SET attempts=ARRAY[clock_timestamp()-interval '61 seconds']`);
  assert.equal((await request('bad', '/native-inbound/messages', 'POST', payload)).status, 401);
  // Ordinary sessions still work after the native authentication budget is exhausted.
  assert.equal((await request(admin.credential, '/conversations/allowed/messages')).status, 200);
});

test('management fails closed before storage when the host grants no administrator capability', async () => {
  const options = { permissions: { getCapabilities: async () => ['message.send'] }, database: { query() { throw new Error('must not reach database'); } } };
  for (const method of ['GET', 'POST', 'DELETE']) await assert.rejects(manageNativeTokens(options, member.actor, method), { statusCode: 403 });
});
