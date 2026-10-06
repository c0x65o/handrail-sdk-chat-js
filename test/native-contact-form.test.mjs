import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { createContactFormHandler } from '../examples/native-contact-form/handler.mjs';

test('contact HTTP handler bounds inputs, keeps grants server-side and handles uncertain delivery without leaking credentials', async t => {
  const token = `hrnt_${randomBytes(32).toString('base64url')}`;
  const calls = [];
  let allowed = true, status = 200, failure = false;
  const handler = createContactFormHandler({ chatApiUrl: 'https://chat.example.test/api/chat', token, channelId: 'contact',
    authorizeRequest: async () => allowed,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (failure) throw new Error('synthetic transport failure');
      return new Response('{}', { status });
    } });
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const body = { submissionId: 'synthetic-1', name: 'Demo', email: 'demo@example.test', message: 'Contact me' };
  const send = async (input = body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal((await r.text()).includes(token), false);
    return r.status;
  };
  assert.equal(await send(), 202);
  assert.equal(await send(), 202);
  assert.equal(calls[0].options.body, calls[1].options.body);
  assert.equal(calls[0].url.href, 'https://chat.example.test/api/chat/native-inbound/messages');
  assert.equal(calls[0].options.headers.authorization === `Bearer ${token}`, true);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(JSON.parse(calls[0].options.body).channelId, 'contact');
  assert.equal(await send({ ...body, channelId: 'forged' }), 400);
  assert.equal(await send({ ...body, constructor: 'forged' }), 400);
  assert.equal(await send({ ...body, message: 'x'.repeat(9000) }), 413);
  assert.equal(await send({ ...body, message: '' }), 400);
  allowed = false;
  assert.equal(await send(), 403);
  assert.equal(calls.length, 2);
  allowed = true; status = 409;
  assert.equal(await send(), 409);
  status = 429;
  assert.equal(await send(), 503);
  failure = true;
  assert.equal(await send(), 503);
  assert.equal(calls.length, 5, 'no automatic retries on uncertain delivery');
});
