import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = new URL('../../../', import.meta.url).pathname;
const { startChatLab } = await import(pathToFileURL(`${root}/examples/drop-in-react/scripts/chat-lab.mjs`));
const { chromium } = await import(pathToFileURL(`${root}/examples/drop-in-react/node_modules/playwright-core/index.mjs`));
const output = process.argv[2];
assert.ok(output, "Supply a fresh JSON evidence output path");
assert.ok(process.env.TEST_DATABASE_URL, "Supply a dedicated test-only PostgreSQL URL; ordinary DATABASE_URL is never a fallback");
const proof = { baseSdkVersion: '1.0.51', baseSdkSha: 'c4403cecb3757cf80f30933efcf9fc0dfa2a7ebd',
  qualification: 'source-bound real Chat Lab; not an installed Git consumer or Preview limiter reproduction',
  requests: [], snapshots: [], errors: [], phases: [], closed: false,
  actualConsumerDatabaseWindows: null,
  limitations: ['The SDK harness has no Preview ordinary API limiter.', 'Two React clients exercise paired SDK traffic; Flutter and Preview background API usage are not reproduced.', 'UTC fixed buckets below are analytical only, not consumer database windows.'] };
let lab, browser;
try {
  lab = await startChatLab({ port: 0, databaseUrl: process.env.TEST_DATABASE_URL, flutterReady: Promise.resolve() });
  proof.schema = lab.harness.schema;
  const candidate = JSON.parse(await readFile(`${root}/dist/candidate.json`, 'utf8'));
  proof.candidate = { source: candidate.source.sha256, package: candidate.package.sha256 };
  const actor = lab.harness.createClient('chat-lab-ada');
  assert.equal((await actor.start()).state, 'ready');
  proof.privateConversationIds = [];
  for (let i = 0; i < 24; i++) {
    const result = await actor.createChannel({ name: `Polling baseline private ${String(i).padStart(2, '0')}`, visibility: 'private' });
    assert.equal(result.status, 'success');
    proof.privateConversationIds.push(result.value.conversation.conversation.id);
  }
  actor.close();
  proof.persistedPrivateRows = (await lab.harness.pool.query("SELECT count(*)::integer AS count FROM chat_conversations WHERE visibility='private'")).rows[0].count;
  browser = await chromium.launch({ headless: true });
  const contexts = [await browser.newContext({ viewport: { width: 1440, height: 1000 } }), await browser.newContext({ viewport: { width: 1440, height: 1000 } })];
  const pages = [];
  const state = ['visible', 'visible'];
  for (const [client, context] of contexts.entries()) {
    const page = await context.newPage(); pages.push(page);
    page.on('pageerror', error => proof.errors.push({ client, message: error.message }));
    // Change only the lab host's supported public config; SDK/UI bytes are untouched.
    await page.route('**/src/chat-lab-config.ts*', async route => {
      const response = await route.fetch();
      const body = await response.text();
      assert.ok(body.includes('endpoint: "/api/chat"'));
      await route.fulfill({ response, body: body.replace('endpoint: "/api/chat"', 'features: { realtime: false }, endpoint: "/api/chat"') });
    });
    const active = new Map();
    page.on('request', request => {
      const url = new URL(request.url());
      if (!url.pathname.startsWith('/api/chat')) return;
      const entry = { client, at: Date.now(), method: request.method(), endpoint: url.pathname, query: url.search, state: state[client], conversationId: url.pathname.match(/\/conversations\/([^/]+)/)?.[1] ?? null };
      active.set(request, entry); proof.requests.push(entry);
    });
    page.on('response', response => { const entry = active.get(response.request()); if (entry) { entry.status = response.status(); entry.completedAt = Date.now(); } });
    page.on('requestfailed', request => { const entry = active.get(request); if (entry) entry.failed = true; });
    await page.goto(`${lab.origin}/chat-lab.html?actor=ada`);
    await page.locator('button[data-conversation-id]').first().waitFor();
  }
  const snapshot = async label => {
    for (const [client, page] of pages.entries()) proof.snapshots.push({ label, client, at: Date.now(), state: state[client], rows: await page.locator('button[data-conversation-id]').evaluateAll(rows => rows.map(row => ({ id: row.dataset.conversationId, visible: row.getClientRects().length > 0 }))) });
  };
  await snapshot('initial');
  proof.phases.push({ name: 'both-visible', at: Date.now() });
  await new Promise(resolve => setTimeout(resolve, 35_000));
  state[1] = 'hidden-retained';
  await pages[1].locator('.handrail-chat').first().evaluate(element => element.style.display = 'none');
  proof.phases.push({ name: 'second-hidden-retained', at: Date.now() });
  await snapshot('hidden');
  await new Promise(resolve => setTimeout(resolve, 40_000));
  await snapshot('end');
  proof.observationEnd = Date.now();
  const groups = {};
  for (const r of proof.requests) { const key = `${r.client} ${r.state} ${r.method} ${r.endpoint} ${r.status ?? 'unfinished'}`; groups[key] = (groups[key] ?? 0) + 1; }
  proof.counts = groups;
  const ordinary = proof.requests.filter(r => r.method === 'GET');
  proof.analyticalUtcFixed60s = {};
  for (const r of ordinary) { const key = new Date(Math.floor(r.at / 60_000) * 60_000).toISOString(); proof.analyticalUtcFixed60s[key] = (proof.analyticalUtcFixed60s[key] ?? 0) + 1; }
  proof.maxRolling60s = ordinary.reduce((max, r) => Math.max(max, ordinary.filter(x => x.at >= r.at && x.at < r.at + 60_000).length), 0);
  proof.summary = { total: proof.requests.length, successful: proof.requests.filter(r=>r.status===200).length, http429: proof.requests.filter(r=>r.status===429).length, http5xx: proof.requests.filter(r=>r.status>=500).length, maxRolling60s: proof.maxRolling60s, hiddenDetailRequests: proof.requests.filter(r=>r.state==='hidden-retained' && /^\/api\/chat\/conversations\/[^/]+$/.test(r.endpoint)).length };
  console.log(JSON.stringify(proof.summary));
} catch (error) { proof.failure = String(error.stack ?? error); console.error(proof.failure); process.exitCode = 1; }
finally { await browser?.close(); await lab?.close(); proof.closed = true; await writeFile(output, JSON.stringify(proof, null, 2)); }
