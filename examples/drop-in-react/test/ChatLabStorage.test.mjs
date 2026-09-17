import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createChatLabLoopbackStorage } from "../scripts/chat-lab.mjs";

const actor = { tenantId: "storage-tests", userId: "ada", roles: [] };
const input = { actor, attachmentId: "one", fileName: "one.txt", contentType: "text/plain", contentLengthBytes: 5 };
const empty = { objectCount: 0, byteCount: 0, uploadCapabilityCount: 0, downloadCapabilityCount: 0 };

const fixture = async (run) => {
  let clock = Date.now();
  const storage = createChatLabLoopbackStorage({ now: () => clock });
  const server = createServer((request, response) => {
    void storage.handle(request, response, () => { response.statusCode = 404; response.end(); });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  storage.setOrigin(`http://127.0.0.1:${server.address().port}`);
  try { await run(storage, { get: () => clock, set: value => { clock = value; } }); }
  finally {
    await storage.teardown();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.deepEqual(storage.snapshot(), empty);
  }
};

test("Lab upload TTL leaves delay headroom and reclaims unmaterialized failed preparations", async () => {
  await fixture(async (storage, clock) => {
    const validationTime = clock.get();
    clock.set(validationTime + 15);
    const prepared = await storage.createUploadUrl(input);
    assert.ok(Date.parse(prepared.expiresAt) < validationTime + 15 * 60_000);
    assert.equal(storage.snapshot().objectCount, 1);
    // A rejected descriptor/SQL transaction never uploads or produces a SQL row.
    clock.set(Date.parse(prepared.expiresAt));
    assert.deepEqual(storage.snapshot(), empty);
    assert.equal((await fetch(prepared.url, { method: "PUT", body: "hello", headers: { "content-type": "text/plain" } })).status, 404);
    const renewed = await storage.createUploadUrl(input);
    assert.notEqual(renewed.url, prepared.url);
    await storage.deleteObject({ actor, attachmentId: input.attachmentId, objectKey: renewed.objectKey });
    assert.deepEqual(storage.snapshot(), empty);
  });
});

test("Lab descriptor construction failure reserves no capacity or capabilities", async () => {
  const storage = createChatLabLoopbackStorage({ now: () => 1e20 });
  storage.setOrigin("http://127.0.0.1:4167");
  try {
    await assert.rejects(storage.createUploadUrl(input), RangeError);
    assert.deepEqual(storage.snapshot(), empty);
  } finally { await storage.teardown(); }
});

test("Lab actual bytes survive capability expiry until canonical object cleanup; abort revokes capabilities", async () => {
  await fixture(async (storage, clock) => {
    const prepared = await storage.createUploadUrl(input);
    const uploaded = await fetch(prepared.url, { method: "PUT", body: "hello", headers: { "content-type": "text/plain" } });
    assert.equal(uploaded.status, 204);
    const request = { actor, attachmentId: input.attachmentId, objectKey: prepared.objectKey };
    assert.equal((await storage.verifyObject(request)).status, "verified");
    const download = await storage.createDownloadUrl({ ...request, fileName: input.fileName, contentDisposition: "attachment" });
    assert.equal(await (await fetch(download.url)).text(), "hello");
    clock.set(Date.parse(download.expiresAt));
    assert.equal((await fetch(download.url)).status, 404);
    assert.deepEqual(storage.snapshot(), { objectCount: 1, byteCount: 5, uploadCapabilityCount: 0, downloadCapabilityCount: 0 });
    const secondDownload = await storage.createDownloadUrl({ ...request, fileName: input.fileName, contentDisposition: "attachment" });
    await storage.deleteObject(request);
    assert.equal((await fetch(secondDownload.url)).status, 404);
    assert.deepEqual(storage.snapshot(), empty);
  });
});

test("Lab capability cannot materialize bytes after expiry during transfer", async () => {
  await fixture(async (storage, clock) => {
    const prepared = await storage.createUploadUrl(input);
    const statuses = [];
    const request = {
      url: prepared.url, method: "PUT", headers: { "content-type": "text/plain" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("he");
        clock.set(Date.parse(prepared.expiresAt));
        yield Buffer.from("llo");
      },
    };
    const response = { setHeader() {}, end() { statuses.push(this.statusCode); } };
    await storage.handle(request, response, () => assert.fail("unexpected next"));
    assert.deepEqual(statuses, [410]);
    assert.deepEqual(storage.snapshot(), empty);
  });
});
