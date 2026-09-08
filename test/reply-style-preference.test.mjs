import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transform } from 'esbuild';

// Load only this contract; scoped type safety is checked by its own tsconfig.
const source = readFileSync(new URL('../src/contracts/reply-style-preference.ts', import.meta.url), 'utf8');
const { code: outputText } = await transform(source, { loader: 'ts', target: 'es2022', format: 'esm' });
const api = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/reply-style-preference.json', import.meta.url)));
const descriptor = JSON.parse(readFileSync(new URL('../contracts/http/reply-style-preference.json', import.meta.url)));
const request = fixtures.request;
const checkError = code => error => error instanceof api.ReplyStylePreferenceParseError && error.code === code;

for (const entry of fixtures.reads) {
  test(`read preserves ${entry.name}`, () => {
    const before = JSON.stringify(entry.wire);
    const state = api.parseReplyStylePreferenceState(entry.wire);
    assert.deepEqual(state, entry.wire);
    assert.equal(api.resolveReplyStylePreference(state), entry.resolved);
    assert.equal(JSON.stringify(entry.wire), before);
    if (state.state === 'saved') assert.equal(api.isReplyStyle(state.style), entry.supported);
  });
}
for (const entry of fixtures.invalidReads) {
  test(`rejects read ${entry.name}`, () => assert.throws(() => api.parseReplyStylePreferenceState(entry.wire), checkError(entry.code)));
}
for (const entry of fixtures.invalidWrites) {
  test(`rejects write ${entry.name}`, () => assert.throws(() => api.parseUpdateReplyStylePreferenceInput(entry.wire), checkError(entry.code)));
}
test('supported writes and UTF-8 key limits', () => {
  for (const style of ['current', 'discord']) {
    for (const idempotencyKey of ['x'.repeat(255), 'é'.repeat(127) + 'x', '😀'.repeat(63) + 'abc']) {
      const input = { ...request, style, idempotencyKey, baseRevision: Number.MAX_SAFE_INTEGER - 1 };
      assert.deepEqual(api.parseUpdateReplyStylePreferenceInput(input), input);
    }
  }
  for (const baseRevision of [NaN, Infinity, -Infinity, undefined]) {
    assert.throws(() => api.parseUpdateReplyStylePreferenceInput({ ...request, baseRevision }), checkError('malformed_revision'));
  }
});
test('GET accepts only empty input and recursively rejects normalized trusted aliases', () => {
  assert.deepEqual(api.parseGetReplyStylePreferenceInput({}), {});
  for (const value of [null, [], { style: 'current' }, { conversationId: 'c' }]) {
    assert.throws(() => api.parseGetReplyStylePreferenceInput(value), checkError('malformed_input'));
  }
  for (const alias of descriptor.trustedContextAliases) {
    const normalizedAttempt = alias.toUpperCase().split('').join('_.- ');
    for (const injection of [{ [alias]: 'spoof' }, { [normalizedAttempt]: 'spoof' }, { nested: [{ more: { [normalizedAttempt]: 'spoof' } }] }]) {
      assert.throws(() => api.parseUpdateReplyStylePreferenceInput({ ...request, ...injection }), checkError('trusted_identity_field'));
      assert.throws(() => api.parseGetReplyStylePreferenceInput(injection), checkError('trusted_identity_field'));
    }
  }
});
for (const entry of fixtures.results) {
  test(`result ${entry.name}`, () => {
    const expected = entry.request ?? request;
    if (entry.code) assert.throws(() => api.parseUpdateReplyStylePreferenceResult(entry.wire, expected), checkError(entry.code));
    else {
      const parsed = api.parseUpdateReplyStylePreferenceResult(entry.wire, expected);
      assert.deepEqual(parsed, entry.wire);
      assert.deepEqual(api.parseUpdateReplyStylePreferenceResult(JSON.parse(JSON.stringify(parsed)), expected), parsed);
    }
  });
}
test('feature is versioned and defaults false', () => {
  assert.equal(api.REPLY_STYLE_PREFERENCE_FEATURE, 'reply_style_preference_v1');
  assert.equal(api.supportsReplyStylePreference(), false);
  assert.equal(api.supportsReplyStylePreference({}), false);
  assert.equal(api.supportsReplyStylePreference({ reply_style_preference_v1: false }), false);
  assert.equal(api.supportsReplyStylePreference({ reply_style_preference_v1: true }), true);
});
test('public entry points export the focused contract', () => {
  for (const path of ['src/contracts/index.ts', 'src/client/index.ts', 'src/server/index.ts']) {
    assert.match(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), /export \* from "(?:\.\/|\.\.\/contracts\/)reply-style-preference\.js"/);
  }
});
