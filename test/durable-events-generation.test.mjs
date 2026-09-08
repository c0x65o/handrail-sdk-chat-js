import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  generateDart,
  generateDurableEvents,
  generateTypeScript,
  readDurableEventsDescriptor,
} from "../scripts/generate-durable-events.mjs";

test("descriptor generates all live reducer durable types for TypeScript and Dart", async () => {
  const descriptor = await readDurableEventsDescriptor();
  const reducer = await readFile("src/client/durable-event-reducer.ts", "utf8");
  const reducerKeys = [
    ...reducer.matchAll(/case CHAT_DURABLE_EVENT_TYPES\.([A-Za-z0-9]+):/g),
  ].map((match) => match[1]);
  assert.deepEqual(
    new Set(descriptor.events.map((event) => event.key)),
    new Set(reducerKeys),
  );
  assert.equal(descriptor.events.length, 21);
  assert.deepEqual(
    descriptor.events.slice(-3).map((event) => event.type),
    ["conversation.draft.updated", "attachment.updated", "huddle.updated"],
  );
  assert.match(generateTypeScript(descriptor), /export type KnownDurableEvent =/);
  assert.match(generateTypeScript(descriptor), /parseKnownDurableEvent/);
  assert.match(generateDart(descriptor), /sealed class KnownDurableEvent/);
  assert.match(generateDart(descriptor), /private_stream_mismatch/);
});

test("--check reports drift and becomes clean after generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "handrail-durable-events-"));
  const destination = join(root, "contracts/realtime/durable-events.json");
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, await readFile("contracts/realtime/durable-events.json", "utf8"));
  assert.equal((await generateDurableEvents({ root, check: true })).length, 2);
  await generateDurableEvents({ root });
  assert.deepEqual(await generateDurableEvents({ root, check: true }), []);
});

test("checked-in durable event contracts match deterministic output", async () => {
  assert.deepEqual(await generateDurableEvents({ check: true }), []);
});

test("full-message event validation uses the canonical reply contract without changing routing", async () => {
  const descriptor = await readDurableEventsDescriptor();
  const { replyReference } = JSON.parse(await readFile("contracts/models/message.json", "utf8"));
  const typescript = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.ok(typescript.includes(`ensureExactKeys(reply, ${JSON.stringify(replyReference.fields.map((field) => field.name))})`));
  const maximum = replyReference.fields.find((field) => field.name === "messageId").maximumUtf8Bytes;
  assert.ok(typescript.includes(`new TextEncoder().encode(messageId).length > ${maximum}`));
  assert.ok(dart.includes("MessageReplyReference.fromJson(value['replyTo'])"));
  const fullMessageEvents = descriptor.events.filter((event) => event.requiredFields.includes("message"));
  assert.deepEqual(fullMessageEvents.map((event) => event.type), ["message.created", "message.updated", "message.deleted"]);
  for (const event of fullMessageEvents) {
    assert.deepEqual(event.streamScopes, ["conversation"]);
    assert.equal(event.entityPath, "message.conversationId");
    assert.equal(event.tenantPath, "message.tenantId");
  }
  const replies = JSON.parse(await readFile("conformance-tests/durable-events/reply-references.json", "utf8"));
  for (const field of replyReference.forbiddenFields) {
    assert.ok(replies.invalidReferences.some((reference) => reference && Object.hasOwn(reference, field)), field);
  }
});

test("conversation event templates use canonical supplied thread-name validation", async () => {
  const descriptor = await readDurableEventsDescriptor();
  assert.match(generateTypeScript(descriptor), /if \(Object.hasOwn\(value, "name"\)\) validateThreadConversationName\(value.name\)/);
  assert.match(generateDart(descriptor), /if\(value.containsKey\('name'\)\) \{ validateThreadConversationName\(value\['name'\]\)/);
});


test("reply style is a contract-only user event reusing canonical preference parsers", async () => {
  const descriptor = await readDurableEventsDescriptor();
  const event = descriptor.events.find(event => event.key === "replyStyleUpdated");
  assert.deepEqual(event.streamScopes, ["user_private"]);
  assert.equal(event.entityPath, undefined);
  assert.equal(event.actorPath, "actorUserId");
  assert.equal(event.canonicalContract, "contracts/http/reply-style-preference.json");
  assert.match(generateTypeScript(descriptor), /parseReplyStylePreferenceState\(payload.preference\)/);
  assert.match(generateTypeScript(descriptor), /parseUpdateReplyStylePreferenceResult/);
  assert.match(generateDart(descriptor), /ReplyStylePreferenceState.fromJson/);
  assert.match(generateDart(descriptor), /UpdateReplyStylePreferenceResult.fromJson/);
  for (const render of [generateTypeScript, generateDart]) {
    for (const patch of [{ streamScopes: ["conversation"] }, { streamScopes: [] }, { actorPath: undefined }, { entityPath: null }]) {
      const invalid = structuredClone(descriptor);
      Object.assign(invalid.events.find(event => event.key === "replyStyleUpdated"), patch);
      assert.throws(() => render(invalid));
    }
    const invalid = structuredClone(descriptor);
    delete invalid.events[0].entityPath;
    assert.throws(() => render(invalid));
  }
});

test("lifecycle events define distinct child authority and exact parent invalidation contracts", async () => {
  const descriptor = await readDurableEventsDescriptor();
  for (const [key, entityPath, field] of [
    ["threadLifecycleUpdated", "threadId", "threadLifecycle"],
    ["threadLifecycleChanged", "parentConversationId", "revision"],
  ]) {
    const event = descriptor.events.find(event => event.key === key);
    assert.deepEqual(event.streamScopes, ["conversation"]);
    assert.equal(event.entityPath, entityPath);
    assert.deepEqual(event.requiredFields, ["threadId", "parentConversationId", field]);
    assert.deepEqual(event.optionalFields, []);
    assert.equal(event.canonicalContract, "contracts/models/conversation.json#threadLifecycle");
  }
  const ts = generateTypeScript(descriptor);
  const dart = generateDart(descriptor);
  assert.match(ts, /validateThreadLifecycle\(payload.threadLifecycle\)/);
  assert.match(ts, /validateConversationThreadLifecycle\(value/);
  assert.match(dart, /ThreadLifecycle.fromJson\(payload\['threadLifecycle'\]\)/);
  assert.match(dart, /ThreadLifecycle.fromJson\(value\['threadLifecycle'\]\)/);
  assert.equal(ts, generateTypeScript(descriptor));
  assert.equal(dart, generateDart(descriptor));
});
