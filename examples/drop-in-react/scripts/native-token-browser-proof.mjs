import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { createContactFormHandler } from '../../native-contact-form/handler.mjs';
import { createNativeTokenProofPacer, paceNativeTokenBrowserRequests, pacedNativeTokenFetch } from './native-token-proof-pacing.mjs';

// Browser library only: never enable error snapshots, screenshots, video or traces.
export async function proveNativeTokens({ origin, candidate, channelId, deniedChannelId, onStep = () => {} }) {
  let stage = 'startup', secret, tokenId, contactServer, context;
  const step = value => { stage = value; onStep(value); };
  const browser = await chromium.launch({ headless: true });
  const pacer = createNativeTokenProofPacer();
  const fetchNative = (path, options) => pacedNativeTokenFetch(pacer, new URL(`/api/chat${path}`, origin), options);
  const adminHeaders = { authorization: 'Bearer chat-lab-ada', 'content-type': 'application/json' };
  try {
    const instance = await fetch(new URL('/__chat-lab/instance', origin)).then(r => r.json());
    assert.equal(instance.candidate.source.sha256, candidate.source.sha256);
    assert.equal(instance.candidate.package.sha256, candidate.package.sha256);
    assert.match(instance.schema, /^handrail_chat_lab_[a-f0-9]{32}$/);
    context = await browser.newContext({ serviceWorkers: 'block' });
    context.setDefaultTimeout(90_000);
    await paceNativeTokenBrowserRequests(context, pacer);
    const page = await context.newPage();
    step('UI creation');
    await page.goto(new URL('/chat-lab.html?actor=ada', origin).href);
    assert.equal(await page.locator('#root').getAttribute('data-candidate-source'), candidate.source.sha256);
    assert.equal(await page.locator('#root').getAttribute('data-candidate-package'), candidate.package.sha256);
    const open = () => page.getByRole('button', { name: 'Inbound channel tokens', exact: true }).click();
    const close = () => page.getByRole('button', { name: 'Close token settings' }).click();
    await open();
    await page.getByLabel('Token name', { exact: true }).fill('Synthetic inbound proof');
    await page.getByLabel('Allowed channel IDs (comma separated)').fill(channelId);
    await page.getByRole('button', { name: 'Create token', exact: true }).click();
    await page.getByRole('button', { name: 'I saved the secret' }).waitFor({ state: 'visible' });
    secret = await page.getByLabel('New token secret').inputValue();
    assert.ok(/^hrnt_[A-Za-z0-9_-]{43}$/.test(secret));
    tokenId = await page.locator('.hr-chat-native-tokens li code').textContent();
    await page.getByRole('button', { name: 'I saved the secret' }).click();
    assert.equal(await page.getByLabel('New token secret').inputValue(), '');
    await close();
    step('contact HTTP example');
    const submission = { submissionId: `contact-${instance.instanceId}`, name: 'Synthetic contact', email: 'demo@example.test', message: `Contact proof ${instance.instanceId}` };
    const text = `Contact form\nName: ${submission.name}\nEmail: ${submission.email}\n${submission.message}`;
    const payload = { channelId, text, idempotencyKey: `contact:${createHash('sha256').update(submission.submissionId).digest('hex')}` };
    contactServer = createServer(createContactFormHandler({ chatApiUrl: new URL('/api/chat', origin).href, token: secret, channelId,
      authorizeRequest: async () => true, // bounded synthetic fixture only
      fetchImpl: (url, options) => pacedNativeTokenFetch(pacer, url, options) }));
    await new Promise(resolve => contactServer.listen(0, '127.0.0.1', resolve));
    const form = await fetch(`http://127.0.0.1:${contactServer.address().port}/contact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission) });
    assert.equal(form.status, 202);
    const post = (body, credential = secret) => fetchNative('/native-inbound/messages', { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    step('retries and channel restrictions');
    const retry = await post(payload);
    assert.equal(retry.status, 200);
    const result = await retry.json();
    assert.equal(result.reconciliationStatus, 'replayed');
    assert.equal(result.message.author.userId, `native-integration:${tokenId}`);
    assert.equal((await post({ ...payload, text: 'Conflicting body' })).status, 409);
    assert.equal((await post({ ...payload, channelId: deniedChannelId })).status, 403);
    assert.equal((await fetchNative('/conversations', { headers: { authorization: `Bearer ${secret}` } })).status, 401);
    step('attribution and reload');
    await page.getByRole('button', { name: /^Chat Lab General(?:,|$)/ }).click();
    await page.getByText(text, { exact: true }).waitFor({ state: 'visible' });
    await page.getByText('Synthetic inbound proof (integration)', { exact: true }).first().waitFor({ state: 'visible' });
    await page.reload();
    await page.getByRole('button', { name: /^Chat Lab General(?:,|$)/ }).click();
    await page.getByText(text, { exact: true }).waitFor({ state: 'visible' });
    step('UI rotation');
    await open();
    await page.getByRole('button', { name: 'Rotate Synthetic inbound proof', exact: true }).click();
    await page.getByRole('button', { name: 'Replace secret now', exact: true }).click();
    await page.getByRole('button', { name: 'I saved the secret' }).waitFor({ state: 'visible' });
    const oldSecret = secret;
    secret = await page.getByLabel('New token secret').inputValue();
    assert.equal(secret === oldSecret, false);
    await page.getByRole('button', { name: 'I saved the secret' }).click();
    await close();
    assert.equal((await post(payload, oldSecret)).status, 401);
    const rotatedRetry = await post(payload);
    assert.equal(rotatedRetry.status, 200);
    assert.equal((await rotatedRetry.json()).message.id, result.message.id);
    step('build message and UI revocation');
    const buildText = `Build sdk-${instance.instanceId}: PASSED https://example.test/build/42`;
    assert.equal((await post({ channelId, text: buildText, idempotencyKey: `build-${instance.instanceId}` })).status, 200);
    await page.getByText(buildText, { exact: true }).waitFor({ state: 'visible' });
    await open();
    await page.getByRole('button', { name: 'Revoke Synthetic inbound proof', exact: true }).click();
    await page.getByRole('button', { name: 'Revoke Synthetic inbound proof', exact: true }).waitFor({ state: 'detached' });
    assert.equal((await post(payload)).status, 401);
    secret = undefined;
    step('ordinary user denial');
    await page.goto(new URL('/chat-lab.html?actor=grace', origin).href);
    await open();
    await page.getByRole('alert').filter({ hasText: 'host-authorized' }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'Create token', exact: true }).count(), 0);
    const denied = await fetchNative('/native-tokens', { method: 'POST', headers: { ...adminHeaders, authorization: 'Bearer chat-lab-grace' }, body: JSON.stringify({ name: 'denied', channelIds: [channelId] }) });
    assert.equal(denied.status, 403);
    return { status: 'passed', instanceId: instance.instanceId, schema: instance.schema, source: candidate.source.sha256, package: candidate.package.sha256,
      proofs: ['UI creation', 'contact HTTP example', 'retry', 'conflict', 'denied channel/read', 'integration attribution', 'reload', 'UI rotation', 'old credential invalidation', 'retry across rotation', 'build status', 'UI revocation', 'ordinary user UI/API denial'] };
  } catch {
    // Browser exception text can contain page values. Retain only the fixed stage.
    throw new Error(`Native browser proof failed at stage: ${stage}`);
  } finally {
    secret = undefined;
    if (contactServer) await new Promise(resolve => contactServer.close(resolve));
    await context?.close();
    await browser.close();
    if (tokenId) {
      const revoked = await fetchNative(`/native-tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE', headers: adminHeaders });
      if (revoked.status !== 200) throw new Error('Fixture token cleanup unconfirmed; inspect fixture metadata.');
    }
  }
}
