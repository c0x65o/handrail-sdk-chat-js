import { expect, test } from './chat-lab.fixture.mjs';
import { writeFile } from 'node:fs/promises';

// Defaults to the existing isolated PostgreSQL/schema Chat Lab harness. The
// override also permits campaign verification against the served dev runtime.
if (process.env.FLUTTER_CHAT_LAB_ORIGIN) {
  test.use({ chatLabOrigin: process.env.FLUTTER_CHAT_LAB_ORIGIN });
}

const call = (page, operation, args = {}) => page.evaluate(async (request) => {
  try {
    return JSON.parse(await window.handrailBackendLab(JSON.stringify(request)));
  } catch (error) {
    throw new Error(`${request.operation}: ${String(error.error ?? error)}`);
  }
}, { operation, ...args });

test('TS and Flutter share a parent and capture unopened thread state across reconnect', async ({
  page: ts, context, chatLabOrigin,
}, info) => {
  const flutter = await context.newPage();
  const flutterReads = [];
  flutter.on('request', (request) => {
    if (request.method() === 'GET' && request.url().includes('/api/chat/')) {
      flutterReads.push(new URL(request.url()).pathname);
    }
  });
  await ts.goto(new URL('/chat-lab.html?actor=ada', chatLabOrigin).href);
  const general = ts.locator('[data-conversation-id]').filter({
    has: ts.locator('.handrail-chat__conversation-label', { hasText: /^Chat Lab General$/ }),
  });
  await expect(general).toHaveCount(1);
  const parentId = await general.getAttribute('data-conversation-id');
  await general.click();
  await flutter.goto(new URL('/__flutter-chat-lab/', chatLabOrigin).href);
  await flutter.waitForFunction(() => typeof window.handrailBackendLab === 'function', null, { timeout: 60_000 });
  try {
    await expect.poll(async () => (await call(flutter, 'status')).realtime).toBe('connected');
    await expect.poll(async () => (await call(flutter, 'status')).hydratedTimelineIds).toContain(parentId);
    let initial;
    await expect.poll(async () => {
      initial = await call(flutter, 'capture', { label: 'shared-parent' });
      return initial.identity;
    }).toMatchObject({ tenantId: 'chat-lab', userId: 'grace' });
    expect(initial.conversationIds).toContain(parentId);
    expect(initial.selectedConversationId).toBe(parentId);
    expect(initial.provenance.sourceDigest).toMatch(/^[a-f0-9]{64}$/);

    const send = async (textbox, text) => {
      await textbox.fill(text);
      const response = ts.waitForResponse((response) =>
        response.request().method() === 'POST' &&
        /\/api\/chat\/conversations\/[^/]+\/messages$/.test(new URL(response.url()).pathname));
      await textbox.press('Enter');
      const result = await response;
      expect(result.ok()).toBe(true);
      return (await result.json()).message;
    };
    const text = `Flutter shared parent ${Date.now()}`;
    const root = await send(ts.getByRole('textbox', { name: 'Message #Chat Lab General', exact: true }), text);
    await expect.poll(async () => (await call(flutter, 'status')).messages.map((m) => m.id)).toContain(root.id);
    const row = ts.locator(`[data-message-id="${root.id}"]`);
    await row.hover();
    const creation = ts.waitForResponse((response) =>
      response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/thread'));
    await row.getByRole('button', { name: 'Reply', exact: true }).click();
    const created = await creation;
    expect(created.ok()).toBe(true);
    const threadId = (await created.json()).conversation.conversation.id;
    const reply = ts.getByRole('textbox', { name: 'Reply to thread', exact: true });
    await send(reply, `${text} first reply`);
    await expect(row.getByRole('button', { name: 'Open thread with 1 reply', exact: true })).toBeVisible();
    const summaries = (state) => state.messages.find((m) => m.id === root.id);
    const captureReplies = async (label, count) => {
      let state;
      await expect.poll(async () => {
        state = await call(flutter, 'capture', { label });
        const message = summaries(state);
        return {
          counts: [message?.canonicalSummary?.replyCount, message?.projectedSummary?.replyCount],
          realtime: state.realtime,
          hasCursor: state.cursor !== null,
        };
      }).toEqual({ counts: [count, count], realtime: 'connected', hasCursor: true });
      return state;
    };
    const beforeHydration = await captureReplies('reply-before-thread-hydration', 1);
    expect(beforeHydration.selectedConversationId).toBe(parentId);
    expect(beforeHydration.hydratedTimelineIds).not.toContain(threadId);
    expect(flutterReads.some((path) => path.includes(`/conversations/${threadId}/`))).toBe(false);
    expect(beforeHydration.cursor).not.toBeNull();

    await call(flutter, 'suspend');
    await send(reply, `${text} reply during disconnect`);
    // The marker follows the summary update in the parent stream.
    const marker = await send(ts.getByRole('textbox', { name: 'Message #Chat Lab General', exact: true }), `${text} reconnect marker`);
    await call(flutter, 'reconnect');
    await expect.poll(async () => (await call(flutter, 'status')).messages.map((m) => m.id)).toContain(marker.id);
    const recovered = await captureReplies('replayed-before-thread-hydration', 2);
    expect(recovered.selectedConversationId).toBe(parentId);
    expect(recovered.hydratedTimelineIds).not.toContain(threadId);
    expect(recovered.cursor).not.toEqual(beforeHydration.cursor);
    expect(flutterReads.some((path) => path.includes(`/conversations/${threadId}/`))).toBe(false);
    const hydrated = await call(flutter, 'hydrate', { conversationId: parentId });
    expect(hydrated.hydrationStatus).toBe('ready');
    expect(hydrated.hydrationError).toBeNull();
    expect(hydrated.messages).toEqual(recovered.messages);

    await call(flutter, 'suspend');
    await call(flutter, 'reconnect');
    await expect.poll(async () => (await call(flutter, 'status')).realtime).toBe('connected');
    const replayed = await call(flutter, 'capture', { label: 'idempotent-reconnect' });
    // Reconnect may perform full snapshot recovery, refreshing viewer unread
    // enrichment and the opaque cursor. Reply facts must remain idempotent;
    // canonical/projected equality (including unreadCount) is checked below.
    const replyFacts = (state) => state.messages.map((message) => {
      const { unreadCount: _unread, ...summary } = message.canonicalSummary ?? {};
      return { id: message.id, summary };
    });
    expect(replyFacts(replayed)).toEqual(replyFacts(hydrated));
    const rehydrated = await call(flutter, 'hydrate', { conversationId: parentId });
    expect(rehydrated.hydrationStatus).toBe('ready');
    expect(rehydrated.hydrationError).toBeNull();
    expect(rehydrated.messages).toEqual(replayed.messages);
    for (const [state, count] of [
      [beforeHydration, 1], [recovered, 2], [hydrated, 2], [replayed, 2], [rehydrated, 2],
    ]) {
      expect(state.hydratedTimelineIds).toContain(parentId);
      expect(state.hydratedTimelineIds).not.toContain(threadId);
      expect(state.selectedConversationId).toBe(parentId);
      const message = summaries(state);
      expect(message.canonicalSummary).toMatchObject({ threadId, replyCount: count });
      expect(message.projectedSummary).toEqual(message.canonicalSummary);
    }
    expect(flutterReads.some((path) => path.includes(`/conversations/${threadId}/`))).toBe(false);
  } finally {
    const evidence = await call(flutter, 'export');
    const evidencePath = info.outputPath('flutter-backend-evidence.json');
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    await info.attach('flutter-backend-evidence', {
      path: evidencePath,
      contentType: 'application/json',
    });
    const screenshotPath = info.outputPath('flutter-backend.png');
    await flutter.screenshot({ path: screenshotPath });
    await info.attach('flutter-backend-surface', {
      path: screenshotPath, contentType: 'image/png',
    });
  }
});

test('Flutter actor and conversation selection match the TS authenticated list', async ({
  page: ts, context, chatLabOrigin,
}) => {
  await ts.goto(new URL('/chat-lab.html', chatLabOrigin).href);
  const rows = ts.locator('button.handrail-chat__conversation-button[data-conversation-id]');
  await expect(rows.filter({ hasText: 'Chat Lab General' })).toHaveCount(1);
  const ids = await rows.evaluateAll((rows) => rows.map((row) => row.dataset.conversationId).sort());
  const parentId = await rows.filter({ hasText: 'Chat Lab General' }).getAttribute('data-conversation-id');
  const flutter = await context.newPage();
  await flutter.goto(new URL(`/__flutter-chat-lab/?actor=ada&conversation=${parentId}`, chatLabOrigin).href);
  await flutter.waitForFunction(() => typeof window.handrailBackendLab === 'function', null, { timeout: 60_000 });
  await expect.poll(async () => (await call(flutter, 'status')).identity?.userId).toBe('ada');
  const state = await call(flutter, 'status');
  expect(state.conversationIds.sort()).toEqual(ids);
  expect(state.selectedConversationId).toBe(parentId);
});
