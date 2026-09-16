// Run only on the sender's server. Do not enable HTTP header/body tracing.
const payloads = {
  contact: { idempotencyKey: 'synthetic-contact-001', text: 'Contact form: Synthetic visitor requests a demonstration. Reply address: demo@example.test.' },
  build: { idempotencyKey: 'synthetic-build-042', text: 'Build sdk-demo-042: PASSED. Details: https://example.test/builds/sdk-demo-042' },
};
const payload = payloads[process.argv[2]];
if (!payload || !process.env.CHAT_NATIVE_TOKEN || !process.env.CHAT_CHANNEL_ID || !process.env.CHAT_API_URL) {
  throw new Error('Provide contact|build and server-only CHAT_NATIVE_TOKEN, CHAT_CHANNEL_ID, CHAT_API_URL.');
}
const response = await fetch(`${process.env.CHAT_API_URL.replace(/\/$/, '')}/native-inbound/messages`, {
  method: 'POST',
  headers: { authorization: `Bearer ${process.env.CHAT_NATIVE_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ ...payload, channelId: process.env.CHAT_CHANNEL_ID }),
});
if (!response.ok) {
  console.error(`Inbound post rejected: HTTP ${response.status}`);
  process.exitCode = 1;
} else {
  const result = await response.json();
  console.log(JSON.stringify({ messageId: result.message.id, result: result.reconciliationStatus }));
}
