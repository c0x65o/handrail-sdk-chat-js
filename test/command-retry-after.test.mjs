import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createChatClient } from '../dist/client/index.js';

const descriptor = { name: 'fixture.command', method: 'POST', path: '/commands', retry: 'safe', validateInput: x => x, parseResult: x => x };
const epoch = Date.parse('Tue, 06 Oct 2026 19:00:00 GMT');
const reply = (status, value) => new Response('{}', { status, headers: value === undefined ? {} : { 'Retry-After': value } });
function fixture(fetch, overrides = {}) {
  let time = epoch;
  const waits = [], requests = [];
  const client = createChatClient({ endpoint: 'https://fixture.invalid', getAccessToken: () => 'fixture-token',
    fetch: async (url, init) => { requests.push({ time, ...init }); return fetch(url, init); },
    commands: { generateIdempotencyKey: () => 'fixture-key', retry: { now: () => time,
      wait: async delay => { waits.push(delay); time += delay; }, ...overrides } },
  });
  return { client, waits, requests, advance: ms => { time += ms; } };
}
async function until(condition) {
  for (let i=0; i<100 && !condition(); i++) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), 'expected asynchronous phase');
}
for (const [header, expected] of [['0',100], ['Tue, 06 Oct 2026 18:00:00 GMT',100], ['60',60000], ['Tue, 06 Oct 2026 19:02:00 GMT',120000], [undefined,60000], ['garbage',60000], ['-1',60000], ['Infinity',60000], ['9'.repeat(400),60000]]) {
  test(`Retry-After ${String(header).slice(0,40)}`, async () => {
    let attempts = 0;
    const f = fixture(async () => reply(++attempts === 1 ? 429 : 200, header));
    assert.equal((await f.client.dispatch(descriptor, { content:'fixture' })).status, 'success');
    assert.equal(f.requests[1].time - f.requests[0].time, expected);
    assert.ok(f.waits.every(ms => ms > 0 && ms <= 60000));
    assert.equal(new Set(f.requests.map(r => r.headers['idempotency-key'])).size, 1);
    assert.equal(new Set(f.requests.map(r => r.body)).size, 1);
    f.client.close();
  });
}
test('overlapping cooldown gates retries and new commands; success cannot shorten it', async () => {
  const responses = [], waits = [];
  const f = fixture(() => new Promise(resolve => responses.push(resolve)), { wait: delay => new Promise(resolve => waits.push({delay,resolve})) });
  const a = f.client.dispatch(descriptor,{id:'a'}), b = f.client.dispatch(descriptor,{id:'b'}), c = f.client.dispatch(descriptor,{id:'c'});
  await until(() => responses.length === 3);
  responses[0](reply(429,'10')); await until(() => waits.length === 1);
  responses[1](reply(429,'30')); responses[2](reply(200)); await c;
  await until(() => waits.length === 2);
  const d = f.client.dispatch(descriptor,{id:'d'}); await until(() => waits.length === 3);
  f.advance(10000); waits[0].resolve(); await until(() => waits.length === 4);
  assert.equal(responses.length,3); assert.equal(waits[3].delay,20000);
  f.advance(20000); waits.slice(1).forEach(w => w.resolve());
  await until(() => responses.length === 6); responses.slice(3).forEach(resolve => resolve(reply(200)));
  assert.deepEqual((await Promise.all([a,b,d])).map(r => r.status),['success','success','success']); f.client.close();
});
for (const mode of ['abort','close']) {
  test(`${mode} while waiting prevents retries`, async () => {
    let waiting; const started = new Promise(resolve => {waiting=resolve;});
    const controller = new AbortController();
    const f = fixture(async () => reply(429,'120'), {wait: () => {waiting();return new Promise(() => {});}});
    const result = f.client.dispatch(descriptor,{}, {signal:controller.signal}); await started;
    if (mode === 'abort') controller.abort(); else f.client.close();
    assert.equal((await result).status, mode === 'abort' ? 'aborted' : 'closed'); assert.equal(f.requests.length,1); f.client.close();
  });
}
test('bounded attempts and retry-never retain final-response cooldown', async () => {
  const f = fixture(async () => reply(429,'2'));
  assert.equal((await f.client.dispatch(descriptor,{})).httpStatus,429); assert.equal(f.requests.length,3);
  assert.deepEqual(f.waits,[2000,2000]);
  await f.client.dispatch({...descriptor,retry:'never'},{});
  assert.equal(f.requests.length,4); assert.deepEqual(f.waits,[2000,2000,2000]); f.client.close();
});
test('uncertain admission then 429 retains identity and one successful side effect', async () => {
  const accepted = new Map(); let attempts=0;
  const f = fixture(async (_url,init) => {
    attempts++; const key=init.headers['idempotency-key'];
    if (attempts===2) return reply(429,'10');
    if (!accepted.has(key)) accepted.set(key,init.body);
    if (attempts===1) throw Error('fixture lost acknowledgement');
    return reply(200);
  });
  assert.equal((await f.client.dispatch(descriptor,{content:'once'})).status,'success');
  assert.equal(accepted.size,1); assert.equal(f.requests.length,3); assert.deepEqual(f.waits,[100,10000]);
  assert.equal(new Set(f.requests.map(r => r.headers['idempotency-key'])).size,1); f.client.close();
});
test('native fetch propagates actual HTTP Retry-After through public client', async () => {
  let attempts=0;
  const server=createServer((_req,res) => {res.writeHead(++attempts===1 ? 429 : 200,{'Retry-After':'2','Content-Type':'application/json'});res.end('{}');});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  let time=epoch; const waits=[];
  const client=createChatClient({endpoint:`http://127.0.0.1:${server.address().port}`,getAccessToken:()=> 'fixture-token',commands:{generateIdempotencyKey:()=> 'fixture-key',retry:{now:()=>time,wait:async delay=>{waits.push(delay);time+=delay;}}}});
  try {assert.equal((await client.dispatch(descriptor,{})).status,'success');assert.deepEqual(waits,[2000]);assert.equal(attempts,2);}
  finally {client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});


test('a shorter overlapping 429 cannot shorten the existing deadline', async () => {
  const responses = [], waits = [];
  const f = fixture(() => new Promise(resolve => responses.push(resolve)), { wait: delay => new Promise(resolve => waits.push({delay,resolve})) });
  const a = f.client.dispatch(descriptor,{}), b = f.client.dispatch(descriptor,{});
  await until(() => responses.length === 2);
  responses[0](reply(429,'30')); await until(() => waits.length === 1);
  responses[1](reply(429,'10')); await until(() => waits.length === 2);
  assert.deepEqual(waits.map(w => w.delay), [30000,30000]);
  f.advance(30000); waits.forEach(w => w.resolve());
  await until(() => responses.length === 4); responses.slice(2).forEach(resolve => resolve(reply(200)));
  await Promise.all([a,b]); f.client.close();
});
