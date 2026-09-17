import assert from 'node:assert/strict';
import { createNativeTokenProofPacer, paceNativeTokenBrowserRequests, pacedNativeTokenFetch } from './native-token-proof-pacing.mjs';
import { chromium } from '@playwright/test';
import { verifyCandidate } from '../../../scripts/candidate-provenance.mjs';
// This spec never starts a listener/database. Operations supplies the managed QA route.
// Deliberately use the browser library without the test runner: even error-context
// snapshots could retain the one-time disclosure. No tracing, screenshots or video.
  const origin = process.env.CHAT_LAB_QA_URL;
  const source = process.env.CHAT_CANDIDATE_SOURCE_SHA256;
  const packageHash = process.env.CHAT_CANDIDATE_PACKAGE_SHA256;
  const channelId = process.env.CHAT_LAB_ALLOWED_CHANNEL_ID;
  const deniedChannelId = process.env.CHAT_LAB_DENIED_CHANNEL_ID;
  if (![origin, source, packageHash, channelId, deniedChannelId].every(Boolean)) throw new Error('Managed QA URL, candidate hashes and isolated channel IDs are required; no fallback runtime.');
  const local = verifyCandidate();
  assert.equal(local.source.sha256, source);
  assert.equal(local.package.sha256, packageHash);
  const browser = await chromium.launch({ headless: true });
try {
  const instance = await fetch(new URL('/__chat-lab/instance', origin)).then(r => r.json());
  assert.equal(instance.candidate.source.sha256, source);
  assert.equal(instance.candidate.package.sha256, packageHash);
  assert.match(instance.schema, /^handrail_chat_lab_[a-f0-9]{32}$/);
  const pacer = createNativeTokenProofPacer();
  const context = await browser.newContext({ serviceWorkers: 'block' });
  context.setDefaultTimeout(240_000);
  await paceNativeTokenBrowserRequests(context, pacer); // no inherited storage/session
  let secret;
  try {
    const page = await context.newPage();
    await page.goto(new URL('/chat-lab.html?actor=ada', origin).href);
    assert.equal(await page.locator('#root').getAttribute('data-candidate-source'), source);
    assert.equal(await page.locator('#root').getAttribute('data-candidate-package'), packageHash);
    await page.getByRole('button', { name: 'Inbound channel tokens', exact: true }).click();
    await page.getByLabel('Token name', { exact: true }).fill('Synthetic inbound proof');
    await page.getByLabel('Allowed channel IDs (comma separated)').fill(channelId);
    await page.getByRole('button', { name: 'Create token', exact: true }).click();
    await page.getByRole('button', { name: 'I saved the secret' }).waitFor({ state: 'visible' });
    secret = await page.getByLabel('New token secret').inputValue();
    assert.ok(Boolean(secret));
    await page.getByRole('button', { name: 'I saved the secret' }).click();
    await page.getByRole('button', { name: 'Close token settings' }).click();
    const text = `Synthetic contact form ${instance.instanceId}`;
    const payload = { channelId, text, idempotencyKey: `contact-${instance.instanceId}` };
    const post = async body => pacedNativeTokenFetch(pacer, new URL('/api/chat/native-inbound/messages', origin), {
      method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const first = await post(payload);
    assert.equal(first.status, 200);
    const result = await first.json();
    const retry = await post(payload);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).message.id, result.message.id);
    assert.equal((await post({ ...payload, text: 'Conflicting body' })).status, 409);
    assert.equal((await post({ ...payload, channelId: deniedChannelId })).status, 403);
    await page.getByRole('button', { name: /^Chat Lab General(?:,|$)/ }).click();
    await page.getByText(text, { exact: true }).waitFor({ state: 'visible' });
    await page.reload();
    await page.getByRole('button', { name: /^Chat Lab General(?:,|$)/ }).click();
    await page.getByText(text, { exact: true }).waitFor({ state: 'visible' });
    const buildText = `Build sdk-${instance.instanceId}: PASSED https://example.test/build/42`;
    assert.equal((await post({ channelId, text: buildText, idempotencyKey: `build-${instance.instanceId}` })).status, 200);
    await page.getByText(buildText, { exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Inbound channel tokens', exact: true }).click();
    await page.getByRole('button', { name: 'Revoke Synthetic inbound proof', exact: true }).click();
    await page.getByRole('button', { name: 'Revoke Synthetic inbound proof', exact: true }).waitFor({ state: 'detached' });
    assert.equal((await post(payload)).status, 401);
    secret = undefined;
    console.log(JSON.stringify({ status: 'passed', instanceId: instance.instanceId, schema: instance.schema, source, package: packageHash, proofs: ['UI creation', 'external contact', 'retry', 'conflict', 'denied channel', 'reload', 'build status', 'UI revocation'] }));
  } finally { secret = undefined; await context.close(); }
} finally { await browser.close(); }
