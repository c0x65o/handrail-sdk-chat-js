import { test, expect, chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { flutterWebRoot as buildRoot } from '../../../scripts/sdk-repositories.mjs';
const call = (page, operation, args = {}) => page.evaluate(async (input) =>
  JSON.parse(await Promise.race([window.handrailStorageLab(JSON.stringify(input)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Lab command timed out: ${input.operation}`)), 30_000)),
  ])), { operation, ...args });
const record = (state, kind) => state.records.find((r) => r.kind === kind);
const sends = (state) => record(state, 'queued_send_message_intents')?.payload.intents ?? [];
const reads = (state) => record(state, 'queued_read_cursor_intents')?.payload.intents ?? [];

// A real disk-backed browser profile is reused after the browser process exits.
// Tabs run independent compiled Dart/Flutter engines and IDB connections.
test('Flutter engines share durable exact CAS and recover across process restart', async ({}, info) => {
  test.setTimeout(180_000);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const relative = decodeURIComponent(url.pathname.replace(/^\/__flutter-chat-lab\//, ''));
      const file = path.resolve(buildRoot, relative || 'index.html');
      if (!file.startsWith(`${buildRoot}${path.sep}`)) { response.writeHead(404).end(); return; }
      const bytes = await readFile(file);
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };
      response.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
      response.end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const profile = info.outputPath('browser-profile');
  await mkdir(profile, { recursive: true });
  const url = `http://127.0.0.1:${server.address().port}/__flutter-chat-lab/?sharedStorage=1&namespace=acceptance`;
  let context;
  const launch = async () => {
    context = await chromium.launchPersistentContext(profile, { headless: true, args: ['--no-sandbox'] });
    return context;
  };
  const open = async (name) => {
    const page = await context.newPage();
    page.on('pageerror', (error) => console.error(`Flutter ${name}: ${error.message}`));
    await page.goto(`${url}&writer=${name}`);
    await page.waitForFunction(() => typeof window.handrailStorageLab === 'function', null, { timeout: 30_000 });
    return page;
  };
  try {
    await launch();
    let a = await open('a');
    let b = await open('b');
    const initial = await call(a, 'export');
    expect(initial.adapter).toBe('indexeddb-exact-cas-strict-v1');
    expect(initial.provenance.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(initial.provenance.sourceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await call(b, 'status')).database).toBe(initial.database);
    expect((await call(b, 'status')).writer).not.toBe(initial.writer);

    // Pause the first writer before CAS: nothing is published before commit.
    await call(a, 'gate', { kind: 'queuedSendMessageIntents', phase: 'cas' });
    const firstSend = call(a, 'send', { text: 'a survives restart' });
    await expect.poll(async () => (await call(a, 'status')).paused).toBe(true);
    expect((await call(a, 'status')).queuedSendIds).toEqual([]);
    expect(sends(await call(b, 'status'))).toHaveLength(0);
    await call(b, 'send', { text: 'b concurrent append' });
    await call(a, 'release');
    expect((await firstSend).result).toBe('queued');
    expect(sends(await call(a, 'status'))).toHaveLength(2);

    // Concurrent cancellation must preserve another engine's newly appended send.
    const cancelId = (await call(b, 'status')).queuedSendIds[0];
    await call(b, 'gate', { kind: 'queuedSendMessageIntents', phase: 'cas' });
    const cancel = call(b, 'cancel', { id: cancelId });
    await expect.poll(async () => (await call(b, 'status')).paused).toBe(true);
    await call(a, 'send', { text: 'append during cancel' });
    await call(b, 'release');
    expect((await cancel).result).toBe(true);
    const queued = sends(await call(a, 'status'));
    expect(queued).toHaveLength(2);
    expect(queued.some((i) => i.clientMessageId === cancelId)).toBe(false);
    await call(a, 'gate', { kind: 'queuedReadCursorIntents', phase: 'cas' });
    expect((await call(a, 'read', { sequence: 4 })).result).toBe('pending');
    await expect.poll(async () => (await call(a, 'status')).paused).toBe(true);
    expect(reads(await call(b, 'status'))).toHaveLength(0);
    expect((await call(a, 'status')).readSequence).toBe(0);
    await call(a, 'release');
    await expect.poll(async () => reads(await call(a, 'status')).length).toBe(1);
    await expect.poll(async () => (await call(a, 'status')).readSequence).toBe(4);
    expect((await call(a, 'status')).ledger).toEqual([]);

    // Kill all Flutter engines by exiting the browser, then reopen its disk profile.
    await context.close();
    await launch();
    a = await open('a-restarted');
    b = await open('b-restarted');
    expect(sends(await call(a, 'status'))).toHaveLength(2);
    expect(reads(await call(b, 'status'))).toHaveLength(1);
    await Promise.all([call(a, 'online', { value: true }), call(b, 'online', { value: true })]);
    await expect.poll(async () => sends(await call(a, 'status')).length).toBe(0);
    await expect.poll(async () => reads(await call(b, 'status')).length).toBe(0);
    await expect.poll(async () => (await call(a, 'status')).ledger.length).toBe(3);
    const settled = await call(a, 'export');
    expect(settled.ledger.filter((entry) => entry.response.operation === 'send')).toHaveLength(2);
    expect(settled.ledger.filter((entry) => entry.response.operation === 'mark_read')).toHaveLength(1);
    for (const entry of settled.ledger) {
      expect(settled.trace.filter((event) => event.operation === 'transport' && event.key === entry.key && event.applied)).toHaveLength(1);
    }
    // Repeated connectivity cycles cannot re-apply settled work.
    await call(a, 'online', { value: false });
    await call(a, 'online', { value: true });
    await expect.poll(async () => (await call(a, 'status')).recovery).toBe('connected');
    expect((await call(a, 'status')).ledger).toHaveLength(3);

    // Exact-value stale snapshot rejection, including valid JSON whitespace.
    await call(a, 'gate', { kind: 'normalizedSnapshot', phase: 'cas' });
    const snapshot = call(a, 'snapshot');
    await expect.poll(async () => (await call(a, 'status')).paused).toBe(true);
    expect((await call(b, 'snapshot', { suffix: '\n' })).result).toBe(true);
    await call(a, 'release');
    expect((await snapshot).result).toBe(false);

    // Exercise the SDK push runtime, not an adapter-only numeric counter.
    expect((await call(a, 'push', { revision: 1 })).result).toBe('success');
    await call(a, 'gate', { kind: 'pushTokenRevisions', phase: 'cas' });
    const olderPush = call(a, 'push', { revision: 2, refresh: true });
    await expect.poll(async () => (await call(a, 'status')).paused).toBe(true);
    expect((await call(b, 'push', { revision: 3 })).result).toBe('success');
    await call(a, 'release');
    expect((await olderPush).result).toBe('success');
    expect(record(await call(a, 'status'), 'push_token_revisions').payload.revisions[0].revision).toBe(3);

    // Hold an actual SDK malformed read while another engine quarantines it
    // and installs a valid replacement. The stale quarantine must lose CAS.
    await call(a, 'corrupt-push');
    await call(a, 'gate', { kind: 'pushTokenRevisions', phase: 'read' });
    const corruptRead = call(a, 'quarantine-push');
    await expect.poll(async () => (await call(a, 'status')).paused).toBe(true);
    await call(b, 'quarantine-push');
    expect((await call(b, 'push', { revision: 4, refresh: true })).result).toBe('success');
    await call(a, 'release');
    await corruptRead;
    expect(record(await call(b, 'status'), 'push_token_revisions').payload.revisions[0].revision).toBe(4);
    const evidence = await call(b, 'export');
    expect(evidence.trace.some((e) => e.operation === 'cas' && e.kind === 'pushTokenRevisions' && e.expected === '{malformed' && e.exchanged === false)).toBe(true);
    expect(evidence.trace.some((e) => e.operation === 'cas' && e.kind === 'queuedSendMessageIntents' && e.exchanged === false)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain('fixture-token-never-export');
    await info.attach('shared-storage-surface', { body: await b.screenshot(), contentType: 'image/png' });
    await info.attach('adapter-traces-and-provenance', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } catch (error) {
      for (const page of context?.pages() ?? []) {
        try {
          const evidence = await call(page, 'export');
          await info.attach('failure-adapter-trace', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
          break;
        } catch { /* An engine may already be closed. */ }
      }
    throw error;
  } finally {
    await context?.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
