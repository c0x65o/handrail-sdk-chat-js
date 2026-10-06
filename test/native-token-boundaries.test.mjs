import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNativeInboundMessage, manageNativeTokens, postNativeMessage } from '../dist/server/native-tokens.js';
import { resolveChatRequestContext } from '../dist/server/request-context.js';

test('inbound text maps to the existing canonical plain-message contract', () => {
  const input = parseNativeInboundMessage({ channelId: 'demo', text: 'Build 42: passed https://example.test/build/42', idempotencyKey: 'build-42' });
  assert.equal(input.operation, 'send');
  assert.equal(input.content.format, 'plain');
  assert.equal(input.conversationId, 'demo');
  assert.equal(input.clientMessageId.length, 64);
  assert.deepEqual(input, parseNativeInboundMessage({ idempotencyKey: 'build-42', text: input.content.text, channelId: 'demo' }));
});
test('caller identity, capabilities, mentions, attachments and unknown fields are rejected', () => {
  const valid = { channelId: 'demo', text: 'Synthetic contact', idempotencyKey: 'contact-1' };
  for (const field of ['tenantId', 'userId', 'author', 'actor', 'roles', 'capabilities', 'content', 'mentions', 'attachments', 'tokenId']) {
    assert.throws(() => parseNativeInboundMessage({ ...valid, [field]: 'forged' }), { statusCode: 400 });
  }
  for (const invalid of [null, [], {}, { ...valid, text: '' }, { ...valid, text: 'x'.repeat(16001) }, { ...valid, channelId: 123 }]) {
    assert.throws(() => parseNativeInboundMessage(invalid), { statusCode: 400 });
  }
});
test('malformed credentials and non-administrators never reach storage', async () => {
  const options = { database: { query() { throw new Error('storage must not be reached'); } }, permissions: { getCapabilities: async () => ['message.send'] } };
  for (const method of ['GET', 'POST', 'DELETE']) await assert.rejects(manageNativeTokens(options, { tenantId: 'demo', userId: 'user', roles: ['admin'] }, method), { statusCode: 403 });
  for (const credential of [undefined, 'Bearer ordinary', 'Bearer hrnt_invalid', 'Bearer hrnt_' + 'x'.repeat(44)]) await assert.rejects(postNativeMessage(options, credential, {}), { statusCode: 401 });
});
test('HTTP and WebSocket host authentication cannot promote a native credential', async () => {
  let calls = 0;
  await assert.rejects(resolveChatRequestContext({ headers: { authorization: 'Bearer hrnt_synthetic' } }, { resolveActor: async () => { calls++; } }, {}), { statusCode: 401 });
  assert.equal(calls, 0);
});

test('shared context rejects native namespace before host auth or cached context across bearer whitespace', async () => {
  let calls = 0;
  const auth = { resolveActor: async () => { calls++; return { tenantId: 'tenant', userId: 'user', roles: [] }; } };
  const permissions = { getCapabilities: async () => [] };
  for (const authorization of [
    'Bearer  hrnt_invalid', 'bearer\thrnt_invalid', ' \tBeArEr \t HRNT_invalid \t',
    'Bearer\u00a0hrnt_invalid', 'Bearer hrnt_', 'Bearer hrnt_invalid extra',
  ]) {
    const request = { headers: { authorization: 'Bearer ordinary' } };
    await resolveChatRequestContext(request, auth, permissions);
    const before = calls;
    request.headers.authorization = authorization;
    await assert.rejects(resolveChatRequestContext(request, auth, permissions), { statusCode: 401 });
    await assert.rejects(resolveChatRequestContext({ headers: { authorization } }, auth, permissions), { statusCode: 401 });
    assert.equal(calls, before);
  }
  for (const authorization of ['Bearer ordinary', ' \tBeArEr  ordinary \t', 'Bearer\tordinary', 'Bearer ordinary-hrnt_suffix', undefined]) {
    const request = { headers: { authorization } };
    const before = calls;
    assert.equal((await resolveChatRequestContext(request, auth, permissions)).actor.userId, 'user');
    assert.equal(request.headers.authorization, authorization);
    assert.equal(calls, before + 1);
  }
});
