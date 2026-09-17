import test from 'node:test';
import assert from 'node:assert/strict';
import { createNativeTokenProofPacer, paceNativeTokenBrowserRequests, pacedNativeTokenFetch } from '../scripts/native-token-proof-pacing.mjs';

test('complete proof shares the 10/60 budget across StrictMode listings, reopening, writes and denials', async () => {
  let time = 0;
  const waits = [], admissions = [], calls = [];
  const pacer = createNativeTokenProofPacer({ now: () => time, sleep: async ms => { waits.push(ms); time += ms; } });
  let routeHandler;
  await paceNativeTokenBrowserRequests({ route: async (pattern, handler) => { assert.equal(pattern, '**/api/chat/native-**'); routeHandler = handler; } }, pacer);
  const server = (label, status) => {
    assert.ok(admissions.filter(t => time - t < 60_000).length < 10, 'server would reject the next request');
    admissions.push(time); calls.push(label);
    return status;
  };
  const browser = async (label, status = 200) => {
    let fulfilled = false;
    await routeHandler({
      fetch: async options => { assert.deepEqual(options, { maxRedirects: 0, maxRetries: 0 }); const s = server(label, status); return { status: () => s, headers: () => ({}) }; },
      fulfill: async ({ response }) => { assert.equal(response.status(), status); fulfilled = true; },
      abort: async () => assert.fail('browser request must finish'),
    });
    assert.equal(fulfilled, true);
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (label, options) => { assert.equal(options.redirect, 'error'); return new Response('{}', { status: server(label, Number(options.headers.expected)) }); };
  try {
    const external = async (label, expected) => assert.equal((await pacedNativeTokenFetch(pacer, label, { method: 'POST', headers: { expected: String(expected) } })).status, expected);
    // Retain the worst-case two real listings per StrictMode mount, even when
    // the manager now cancels its first header lookup before transport.
    await Promise.all([browser('initial listing 1'), browser('initial listing 2')]);
    await browser('create');
    await external('contact', 200);
    await external('retry', 200);
    await external('conflict', 409);
    await external('denied channel', 403);
    await external('build', 200);
    await Promise.all([browser('reopen listing 1'), browser('reopen listing 2')]);
    await browser('revoke');
    await external('post-revocation denial', 401);
    await browser('ordinary-user management denial', 403);
    assert.equal(calls.length, 13);
    assert.deepEqual(waits, [60_250]);
    assert.ok(admissions[10] >= 60_000);
  } finally { globalThis.fetch = original; }
});

test('explicit pre-dispatch 429 respects Retry-After without replaying uncertain writes', async () => {
  let time = 0, calls = 0;
  const waits = [];
  const pacer = createNativeTokenProofPacer({ now: () => time, sleep: async ms => { waits.push(ms); time += ms; } });
  assert.equal(await pacer.request(async () => ++calls === 1 ? { status: 429, retryAfter: '90' } : { status: 200, value: 'revoked' }), 'revoked');
  assert.deepEqual(waits, [90_250]);
  let uncertainCalls = 0;
  await assert.rejects(pacer.request(async () => { uncertainCalls++; throw new Error('private transport detail'); }), /outcome unknown/);
  assert.equal(uncertainCalls, 1);
  let errorCalls = 0;
  assert.equal(await pacer.request(async () => { errorCalls++; return { status: 500, value: 'failed' }; }), 'failed');
  assert.equal(errorCalls, 1);
});

test('repeated 429 remains a failure and malformed Retry-After waits a full window', async () => {
  let time = 0, calls = 0;
  const pacer = createNativeTokenProofPacer({ now: () => time, sleep: async ms => { time += ms; } });
  await assert.rejects(pacer.request(async () => { calls++; return { status: 429, retryAfter: 'invalid' }; }), /no acceptance result/);
  assert.equal(calls, 3);
  assert.equal(time, 120_500);
});
