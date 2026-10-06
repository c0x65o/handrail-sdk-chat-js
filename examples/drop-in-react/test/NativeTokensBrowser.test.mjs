import assert from 'node:assert/strict';
import test from 'node:test';
import { candidate } from '../scripts/candidate-binding.mjs';
import { startChatLab } from '../scripts/chat-lab.mjs';
import { proveNativeTokens } from '../scripts/native-token-browser-proof.mjs';
import { Pool } from 'pg';

// Explicit opt-in from the disposable PG helper, never an ambient managed DB.
test('exact-source Chat Lab browser + HTTP contact relay on two clean isolated instances', { timeout: 600_000 }, async () => {
  assert.equal(process.env.NATIVE_TOKEN_ISOLATED_BROWSER, '1');
  const databaseUrl = process.env.TEST_DATABASE_URL;
  assert.ok(databaseUrl);
  const verifier = new Pool({ connectionString: databaseUrl, max: 1 });
  let previous;
  try {
    for (let run = 1; run <= 2; run++) {
      const lab = await startChatLab({ databaseUrl, port: 0, host: '127.0.0.1' });
      try {
        assert.equal(Number((await lab.harness.pool.query(`SELECT count(*) FROM "${lab.harness.schema}".chat_native_tokens`)).rows[0].count), 0);
        if (previous) {
          assert.notEqual(lab.instanceId, previous.instanceId);
          assert.notEqual(lab.harness.schema, previous.schema);
        }
        const channels = (await lab.harness.pool.query(`SELECT id,name FROM "${lab.harness.schema}".chat_conversations WHERE type='channel'`)).rows;
        const proof = await proveNativeTokens({ origin: lab.origin, candidate,
          channelId: channels.find(row => row.name === 'Chat Lab General').id,
          deniedChannelId: channels.find(row => row.name === 'Chat Lab Empty Room').id,
          onStep: stage => console.log(JSON.stringify({ run, stage })) });
        console.log(JSON.stringify({ run, ...proof }));
        previous = proof;
      } finally { await lab.close(); }
      assert.equal((await verifier.query('SELECT 1 FROM pg_namespace WHERE nspname=$1', [lab.harness.schema])).rowCount, 0, 'only owned schema is removed on teardown');
    }
  } finally { await verifier.end(); }
});
