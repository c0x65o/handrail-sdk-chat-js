import assert from 'node:assert/strict';
import test from 'node:test';
import { createChatTestHarness } from '@handrail/chat/testing';
import { createChatClient } from '@handrail/chat/client';

test('private channel creation stays discoverable without realtime and persists for a fresh client', async () => {
  const harness = await createChatTestHarness({
    schemaPrefix: 'workspace_creation',
    actors: [{
      credential: 'workspace-fixture', actor: { tenantId: 'fixture-tenant', userId: 'fixture-owner', roles: [] },
      capabilities: ['conversation.create', 'conversation.read', 'message.send'],
      user: { tenantId: 'fixture-tenant', userId: 'fixture-owner', displayName: 'Fixture owner' },
    }],
  });
  const clients = [];
  const create = async () => {
    const client = createChatClient({ endpoint: harness.endpoint, getAccessToken: () => 'workspace-fixture', realtime: false });
    clients.push(client);
    client.cache.setIdentity({ tenantId: 'fixture-tenant', userId: 'fixture-owner', sessionId: `fixture-${clients.length}` });
    assert.equal((await client.start()).state, 'ready');
    return client;
  };
  const scope = { type: 'organization' };
  try {
    const setup = await create();
    for (const name of ['A', 'B', 'C']) assert.equal((await setup.createChannel({ name, visibility: 'private' })).status, 'success');
    const client = await create();
    assert.equal((await client.listConversations({ scope })).value.items.length, 3);
    const ids = [];
    for (const name of ['D', 'E']) {
      const result = await client.createChannel({ name, visibility: 'private' });
      assert.equal(result.status, 'success', JSON.stringify(result));
      ids.push(result.value.conversation.conversation.id);
    }
    assert.equal(client.cache.getState().metadata.conversationLists.organization.conversationIds.length, 5);
    const sent = await client.sendMessage({ conversationId: ids[0], content: { format: 'plain', text: 'Disposable history proof' } });
    assert.equal(sent.status, 'success', JSON.stringify(sent));
    const fresh = await create();
    const discovered = await fresh.listConversations({ scope });
    assert.equal(discovered.status, 'success');
    assert.deepEqual(discovered.value.items.map(item => item.name).sort(), ['A', 'B', 'C', 'D', 'E']);
    assert.equal((await fresh.getConversation({ conversationId: ids[0] })).status, 'success');
    const history = await fresh.getMessageTimeline({ conversationId: ids[0], direction: 'backward', limit: 20 });
    assert.equal(history.status, 'success');
    assert.equal(history.value.messages.at(-1).content.text, 'Disposable history proof');
    await client.listConversations({ scope });
    assert.deepEqual(client.cache.getState().metadata.conversationLists.organization.pendingCreatedIds, []);
  } finally {
    for (const client of clients) client.close();
    await harness.teardown();
  }
});
