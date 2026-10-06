// Run only against the baseline build. The corrected implementation deliberately
// requires an advancing clock when replacing its wait boundary (see regression).
import { createChatClient } from '../../../dist/client/index.js';
const waits = []; let calls = 0;
const client = createChatClient({
  endpoint: 'https://fixture.invalid', getAccessToken: () => 'fixture-token',
  fetch: async () => { calls++; return new Response('{}', { status: 429, headers: { 'Retry-After': '60' } }); },
  commands: { generateIdempotencyKey: () => 'fixture-key', retry: { wait: async ms => { waits.push(ms); } } },
});
const result = await client.dispatch({ name: 'test.command', method: 'POST', path: '/command', retry: 'safe', validateInput: x => x, parseResult: x => x }, {});
console.log(JSON.stringify({ calls, waits, result, expectedMinimumWaitMs: 60000, reproduced: waits.some(ms => ms < 60000) }, null, 2));
