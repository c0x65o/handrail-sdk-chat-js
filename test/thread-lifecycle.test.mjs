import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { build } from 'esbuild';
const bundle = await build({entryPoints:['src/contracts/thread-lifecycle.ts'], bundle:true, write:false, platform:'browser', format:'esm', target:'es2022'});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const fixtures = JSON.parse(readFileSync('test/fixtures/thread-lifecycle-http.json','utf8'));
const roundtrip = value => JSON.parse(JSON.stringify(value));
for (const f of fixtures.valid) test(`round trip: ${f.name}`, () => {
  const input = api.parseThreadLifecycleInput(roundtrip(f.input));
  assert.deepEqual(api.serializeThreadLifecycleInput(input), f.input);
  const result = api.parseThreadLifecycleResult(roundtrip(f.result), input);
  assert.deepEqual(api.serializeThreadLifecycleResult(result, input), f.result);
  const body = api.serializeThreadLifecycleBody(input);
  assert.equal(Object.hasOwn(body, 'threadId'), false);
  assert.deepEqual(api.parseThreadLifecycleHttpInput(input.threadId, roundtrip(body)), input);
});
for (const f of fixtures.invalidRequests) test(`reject input: ${f.name}`, () => {
  assert.throws(() => api.parseThreadLifecycleInput(roundtrip(f.input)), api.ThreadLifecycleParseError);
});
for (const f of fixtures.invalidResults) test(`reject result: ${f.name}`, () => {
  assert.throws(() => api.parseThreadLifecycleResult(roundtrip(f.result), f.input), api.ThreadLifecycleParseError);
});
test('non-finite revisions, invalid expected input, trusted errors and HTTP path/body identity', () => {
  const {input, result} = fixtures.valid[0];
  for (const value of [NaN, Infinity, -Infinity]) {
    assert.throws(() => api.parseThreadLifecycleInput({...input, expectedLifecycleRevision:value}));
    assert.throws(() => api.parseThreadLifecycleResult({...result, threadLifecycle:{...result.threadLifecycle, revision:value}}, input));
  }
  assert.throws(() => api.parseThreadLifecycleResult(result, {...input, idempotencyKey:''}));
  assert.throws(() => api.parseThreadLifecycleInput({...input, extra:[{AUTH_ORIZATION:'forged'}]}), {code:'trusted_identity_field'});
  assert.throws(() => api.parseThreadLifecycleHttpInput('thread-1', input));
  const body = api.serializeThreadLifecycleBody(input);
  assert.throws(() => api.parseThreadLifecycleHttpInput('', body));
  assert.throws(() => api.parseThreadLifecycleHttpInput('thread-1', {...body, actor:'user'}));
  const parsed = api.parseThreadLifecycleResult(result, input);
  assert.notEqual(parsed.threadLifecycle, result.threadLifecycle);
});
