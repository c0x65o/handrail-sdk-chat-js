import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
import test from "node:test";

import { startEmbeddedFixtureHost } from "../dist/host.js";

const readUntil = (socket, predicate) =>
  new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const result = predicate(buffered);
      if (result !== undefined) {
        cleanup();
        resolve(result);
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Socket closed before the expected frame arrived"));
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });

const parseServerFrame = (buffer) => {
  if (buffer.length < 2) {
    return undefined;
  }
  const opcode = buffer[0] & 0x0f;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) {
      return undefined;
    }
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    throw new Error("Fixture frame is unexpectedly large");
  }
  if (buffer.length < offset + length) {
    return undefined;
  }
  return { opcode, payload: buffer.subarray(offset, offset + length) };
};

const maskedTextFrame = (value) => {
  const payload = Buffer.from(value);
  assert.ok(payload.length < 126);
  const mask = randomBytes(4);
  const frame = Buffer.alloc(2 + mask.length + payload.length);
  frame[0] = 0x81;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) {
    frame[6 + index] = payload[index] ^ mask[index % mask.length];
  }
  return frame;
};

const completeWebSocketHandshake = async ({ origin, sessionCookie, metadata }) => {
  const { hostname, port } = new URL(origin);
  const socket = connect(Number(port), hostname);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  const key = randomBytes(16).toString("base64");
  socket.write(
    [
      "GET /api/chat/_realtime HTTP/1.1",
      `Host: ${hostname}:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `Cookie: ${sessionCookie}`,
      "",
      "",
    ].join("\r\n"),
  );

  const upgrade = await readUntil(socket, (buffer) => {
    const boundary = buffer.indexOf("\r\n\r\n");
    if (boundary < 0) {
      return undefined;
    }
    return {
      headers: buffer.subarray(0, boundary).toString("utf8"),
      remainder: buffer.subarray(boundary + 4),
    };
  });
  assert.match(upgrade.headers, /^HTTP\/1\.1 101 Switching Protocols\r\n/i);
  const expectedAccept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  const acceptHeader = upgrade.headers
    .split("\r\n")
    .find((line) => line.toLocaleLowerCase().startsWith("sec-websocket-accept:"));
  assert.equal(acceptHeader?.split(":", 2)[1]?.trim(), expectedAccept);

  socket.write(
    maskedTextFrame(
      JSON.stringify({
        clientPackageVersion: metadata.packageVersion,
        protocolVersion: metadata.protocolVersion,
      }),
    ),
  );
  const acceptedFrame =
    parseServerFrame(upgrade.remainder) ??
    (await readUntil(socket, (buffer) => parseServerFrame(buffer)));
  assert.equal(acceptedFrame.opcode, 1);
  const accepted = JSON.parse(acceptedFrame.payload.toString("utf8"));
  assert.equal(accepted.type, "chat.session.accepted");
  assert.equal(accepted.metadata.protocolVersion, metadata.protocolVersion);
  socket.destroy();
};

test("embedded host authenticates snapshots and WebSocket through its own session", async () => {
  const host = await startEmbeddedFixtureHost();
  try {
    const headers = {
      cookie: host.sessionCookie,
      "x-tenant-id": "spoofed-tenant",
      "x-user-id": "spoofed-user",
      "x-roles": "administrator",
    };

    const metadataResponse = await fetch(`${host.origin}/api/chat/_meta`, {
      headers,
    });
    assert.equal(metadataResponse.status, 200);
    const metadata = await metadataResponse.json();
    assert.equal(typeof metadata.packageVersion, "string");
    assert.equal(typeof metadata.protocolVersion, "number");

    const conversationsResponse = await fetch(
      `${host.origin}/api/chat/conversations?scope=organization`,
      { headers },
    );
    assert.equal(conversationsResponse.status, 200);
    const conversations = await conversationsResponse.json();
    assert.deepEqual(
      conversations.items.map(({ id }) => id),
      [host.visibleConversationId],
    );
    assert.equal(conversations.items[0].tenantId, "fixture-tenant");
    assert.notEqual(conversations.items[0].tenantId, headers["x-tenant-id"]);

    await completeWebSocketHandshake({
      origin: host.origin,
      sessionCookie: host.sessionCookie,
      metadata,
    });
  } finally {
    await host.close();
  }
});
