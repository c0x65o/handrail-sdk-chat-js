import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['src/contracts/message-context.ts'], bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022' });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/message-context.json', import.meta.url)));
const request = api.parseMessageContextRequest(fixtures.request);
for (const { name, wire } of fixtures.results) {
  test(`${name} round trip retains canonical identity and metadata`, () => {
    const before = JSON.stringify(wire);
    const result = api.parseMessageContextResult(wire, request);
    assert.deepEqual(result, wire);
    assert.deepEqual(api.parseMessageContextResult(JSON.parse(JSON.stringify(result)), request), result);
    assert.equal(JSON.stringify(wire), before);
  });
}
for (const { name, wire } of fixtures.invalidRequests) {
  test(`request rejects ${name}`, () => assert.throws(() => api.parseMessageContextRequest(wire), api.MessageContextParseError));
}
for (const { name, wire } of fixtures.invalidResults) {
  test(`result rejects ${name}`, () => assert.throws(() => api.parseMessageContextResult(wire, request), api.MessageContextParseError));
}
test('result parsing requires a valid expected request for every status', () => {
  for (const { wire } of fixtures.results) {
    for (const expected of [undefined, {}, { ...request, messageId: 'other' }, { ...request, conversationId: 'other' }]) {
      assert.throws(() => api.parseMessageContextResult(wire, expected), api.MessageContextParseError);
    }
  }
});
test('safe sequence endpoints, non-finite numbers and canonical revision validation', () => {
  for (const sequence of [1, Number.MAX_SAFE_INTEGER]) {
    const wire = structuredClone(fixtures.results[0].wire);
    wire.sequence = wire.message.sequence = sequence;
    assert.equal(api.parseMessageContextResult(wire, request).sequence, sequence);
  }
  for (const sequence of [NaN, Infinity, -Infinity, undefined]) {
    assert.throws(() => api.parseMessageContextResult({ ...fixtures.results[0].wire, sequence }, request), api.MessageContextParseError);
  }
  const wire = structuredClone(fixtures.results[0].wire);
  wire.message.revision.revision = Number.MAX_SAFE_INTEGER;
  assert.equal(api.parseMessageContextResult(wire, request).message.revision.revision, Number.MAX_SAFE_INTEGER);
});
test('unavailable conveys no existence reason and transport rejection remains retryable by callers', async () => {
  const unavailable = fixtures.results[2].wire;
  assert.deepEqual(api.parseMessageContextResult(unavailable, request), { status: 'unavailable', ...request });
  const timeout = new Error('timeout');
  await assert.rejects(Promise.reject(timeout).then(body => api.parseMessageContextResult(body, request)), error => error === timeout);
  assert.throws(() => api.parseMessageContextResult(timeout, request), api.MessageContextParseError);
});
test('bounded Unicode identifiers and public exports', () => {
  for (const id of ['é'.repeat(127) + 'x', 'x'.repeat(255)]) {
    assert.equal(api.parseMessageContextRequest({ ...request, messageId: id }).messageId, id);
  }
  assert.throws(() => api.parseMessageContextRequest({ ...request, messageId: 'é'.repeat(128) }));
  assert.match(readFileSync('src/contracts/index.ts', 'utf8'), /export \* from "\.\/message-context\.js"/);
});
