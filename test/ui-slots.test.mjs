import assert from "node:assert/strict";
import test from "node:test";

const {
  CHAT_WORKSPACE_SLOT_KEYS,
  resolveChatWorkspaceSlots,
} = await import(new URL("ui/index.js", process.env.HANDRAIL_REPLY_UI_BUILD ?? new URL("../dist/", import.meta.url)));

const createSlots = (prefix) => Object.freeze({
  WorkspaceHeader: function WorkspaceHeader() { return prefix; },
  Avatar: function Avatar() { return prefix; },
  Message: function Message() { return prefix; },
  ChannelHeader: function ChannelHeader() { return prefix; },
  Composer: function Composer() { return prefix; },
  EmptyState: function EmptyState() { return prefix; },
  Attachment: function Attachment() { return prefix; },
  LinkPreview: function LinkPreview() { return prefix; },
  SystemEvent: function SystemEvent() { return prefix; },
  User: function User() { return prefix; },
  EntityReference: function EntityReference() { return prefix; },
});

test("slot keys are complete, stable, and immutable", () => {
  assert.deepEqual(CHAT_WORKSPACE_SLOT_KEYS, [
    "WorkspaceHeader",
    "Avatar",
    "Message",
    "ChannelHeader",
    "Composer",
    "EmptyState",
    "Attachment",
    "LinkPreview",
    "SystemEvent",
    "User",
    "EntityReference",
  ]);
  assert.equal(Object.isFrozen(CHAT_WORKSPACE_SLOT_KEYS), true);
});

test("resolution deterministically applies partial overrides", () => {
  const defaults = createSlots("default");
  const WorkspaceHeader = function CustomWorkspaceHeader() { return "override"; };
  const Message = function CustomMessage() { return "override"; };
  const LinkPreview = function CustomLinkPreview() { return "override"; };
  const User = function CustomUser() { return "override"; };
  const overrides = Object.freeze({ WorkspaceHeader, Message, LinkPreview, User });

  const first = resolveChatWorkspaceSlots(defaults, overrides);
  const second = resolveChatWorkspaceSlots(defaults, overrides);

  assert.deepEqual(Object.keys(first), CHAT_WORKSPACE_SLOT_KEYS);
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
  assert.equal(first.WorkspaceHeader, WorkspaceHeader);
  assert.equal(first.Message, Message);
  assert.equal(first.LinkPreview, LinkPreview);
  assert.equal(first.User, User);
  assert.equal(first.Avatar, defaults.Avatar);
});

test("resolution does not mutate or return either input", () => {
  const defaults = createSlots("default");
  const overrides = Object.freeze({
    Composer: function CustomComposer() { return "override"; },
  });
  const defaultEntries = Object.entries(defaults);
  const overrideEntries = Object.entries(overrides);

  const resolved = resolveChatWorkspaceSlots(defaults, overrides);

  assert.notEqual(resolved, defaults);
  assert.notEqual(resolved, overrides);
  assert.deepEqual(Object.entries(defaults), defaultEntries);
  assert.deepEqual(Object.entries(overrides), overrideEntries);
  assert.equal(Object.isFrozen(resolved), true);
});
