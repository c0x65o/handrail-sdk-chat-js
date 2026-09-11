import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Window } from "happy-dom";
import { WebSocket } from "ws";
import { createChatTestHarness } from "@handrail/chat/testing";
import { createChatClient, createNormalizedChatCache } from "@handrail/chat/client";

// Public built exports deliberately exercise the consumer install/build surface.
// The qualification runner builds current source and supplies disposable PG16.
process.env.NODE_ENV = "test";
const window = new Window({ url: "https://isolated-react-chat.example.test" });
Object.assign(globalThis, {
  window, document: window.document, HTMLElement: window.HTMLElement,
  Node: window.Node, Event: window.Event,
});
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, createRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ChatProvider } = await import("@handrail/chat/react");
const { ReplyStyleSettings, MessageComposer } = await import("@handrail/chat/ui");

async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(20);
  }
}

test("PG16 mounted React settings persist, recover, propagate and preserve reply destinations", { timeout: 90_000 }, async t => {
  const actor = { tenantId: "react-reply-lab", userId: "bob", roles: [] };
  const credential = "isolated-react-reply-credential";
  let harness;
  const clients = [], mounts = [], sockets = [];
  try {
    harness = await createChatTestHarness({ schemaPrefix: "react_reply_style",
      actors: [{ credential, actor, capabilities: ["conversation.read", "message.send", "thread.create"],
        user: { ...actor, displayName: "Bob Lab" } }],
    });
    const sql = (query, values) => harness.pool.query(query, values);
    const prefix = `"${harness.schema}"`;
    const version = (await sql("SHOW server_version")).rows[0].server_version;
    assert.match(version, /^16\./, "This qualification requires real PostgreSQL 16");
    t.diagnostic(`PostgreSQL ${version}; schema ${harness.schema}; mounted happy-dom React (not browser/media evidence)`);
    await sql(`INSERT INTO ${prefix}.chat_conversations
      (tenant_id,id,type,visibility,name,current_message_sequence)
      VALUES ($1,'parent','channel','public','Isolated Reply Lab',1)`, [actor.tenantId]);
    await sql(`INSERT INTO ${prefix}.chat_conversation_members (tenant_id,conversation_id,user_id,role,state)
      VALUES ($1,'parent','bob','member','active')`, [actor.tenantId]);
    await sql(`INSERT INTO ${prefix}.chat_messages
      (tenant_id,id,conversation_id,sequence,author_user_id,client_message_id,content)
      VALUES ($1,'root','parent',1,'alice','root','{"format":"plain","text":"Original lab context"}')`, [actor.tenantId]);

    async function clientFor(session) {
      const client = createChatClient({ endpoint: harness.endpoint, getAccessToken: () => credential,
        cache: createNormalizedChatCache({ ...actor, sessionId: session }),
        commands: { retry: { maxAttempts: 1 } },
        realtime: { webSocketFactory(url, protocols) {
          const socket = new WebSocket(url, protocols); sockets.push(socket); return socket;
        } },
      });
      clients.push(client);
      assert.equal((await client.start()).state, "ready");
      await until(() => client.realtime.state.state === "connected", `${session} real websocket handshake`);
      assert.equal(client.state.enabledFeatures.reply_style_preference_v1, true);
      assert.equal(client.state.enabledFeatures.inlineReplies, true);
      assert.equal(client.state.enabledFeatures.namedThreads, true);
      assert.equal(client.realtime.state.metadata.enabledFeatures.reply_style_preference_v1, true);
      assert.equal(client.realtime.state.metadata.enabledFeatures.inlineReplies, true);
      await client.replyStyle.load();
      return client;
    }
    async function mount(client, child = createElement(ReplyStyleSettings)) {
      const container = document.createElement("div"); document.body.append(container);
      const root = createRoot(container); mounts.push({ root, container });
      await act(async () => root.render(createElement(ChatProvider, { client }, child)));
      return container;
    }
    async function choose(container, style, status = "saved") {
      const select = container.querySelector("select"); assert.equal(select.disabled, false);
      await act(async () => {
        select.value = style;
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
        await until(() => first.replyStyle.getState().saveStatus === status, `${style} save ${status}`);
      });
    }
    const first = await clientFor("first"), second = await clientFor("second");
    const firstView = await mount(first), secondView = await mount(second);
    assert.match(firstView.textContent, /Effective style: Current — SDK default/);
    assert.match(firstView.textContent, /No saved choice/);

    await t.test("real settings save reaches PostgreSQL and a second mounted client by websocket", async () => {
      await choose(firstView, "discord");
      await act(async () => until(() => second.replyStyle.getState().effectiveStyle === "discord", "second client canonical event"));
      assert.match(firstView.textContent, /save confirmed/);
      assert.match(secondView.textContent, /Effective style: Discord-style — saved preference/);
      assert.deepEqual((await sql(`SELECT style,revision FROM ${prefix}.chat_user_reply_style_preferences
        WHERE tenant_id=$1 AND user_id=$2`, [actor.tenantId, actor.userId])).rows.map(row => ({ ...row, revision: Number(row.revision) })),
      [{ style: "discord", revision: 1 }]);
      const response = await fetch(`${harness.endpoint}/preferences/reply-style`, { headers: { authorization: `Bearer ${credential}` } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { state: "saved", style: "discord", revision: 1 });
      const reloaded = await clientFor("reload");
      const view = await mount(reloaded);
      assert.match(view.textContent, /Effective style: Discord-style — saved preference/);
      const socketCount = sockets.length;
      await act(async () => {
        second.realtime.restart();
        await until(() => sockets.length > socketCount && second.realtime.state.state === "connected", "real reconnect handshake");
        await until(() => second.replyStyle.getState().confirmedPreference?.style === "discord", "reconnected canonical preference");
      });
      assert.match(secondView.textContent, /Effective style: Discord-style — saved preference/);
    });

    await t.test("actual rejected PostgreSQL save retains confirmed mode and mounted retry succeeds", async () => {
      await sql(`CREATE FUNCTION ${prefix}.reject_style_save() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'isolated storage fault'; END $$`);
      await sql(`CREATE TRIGGER reject_style_save BEFORE UPDATE ON ${prefix}.chat_user_reply_style_preferences
        FOR EACH ROW EXECUTE FUNCTION ${prefix}.reject_style_save()`);
      try {
        await choose(firstView, "current", "error");
        assert.match(firstView.textContent, /Effective style: Discord-style/);
        assert.match(firstView.querySelector('[role="alert"]').textContent, /Could not confirm/);
        assert.equal((await sql(`SELECT style FROM ${prefix}.chat_user_reply_style_preferences`)).rows[0].style, "discord");
      } finally {
        await sql(`DROP TRIGGER reject_style_save ON ${prefix}.chat_user_reply_style_preferences`);
        await sql(`DROP FUNCTION ${prefix}.reject_style_save()`);
      }
      await act(async () => {
        firstView.querySelector("button").click();
        await until(() => first.replyStyle.getState().saveStatus === "saved", "mounted retry commit");
        await until(() => second.replyStyle.getState().effectiveStyle === "current", "second client Current mode");
      });
      assert.match(firstView.textContent, /Effective style: Current — saved preference/);
      assert.equal(firstView.querySelector('[role="alert"]'), null);
      await choose(firstView, "discord");
      await act(async () => until(() => clients.every(client =>
        client.replyStyle.getState().effectiveStyle === "discord"), "all mounted clients receiving final Discord preference"));
    });

    await t.test("mounted composer sends immutable same-conversation source with ping off; thread creation stays separate", async () => {
      assert.equal((await first.getConversation({ conversationId: "parent" })).status, "success");
      assert.equal((await first.getMessageTimeline({ conversationId: "parent", direction: "backward", limit: 20 })).status, "success");
      const controlsRef = createRef();
      const view = await mount(first, createElement(MessageComposer, { conversationId: "parent", controlsRef, availability: { canSend: true } }));
      await act(async () => until(() => first.selectConversationDraft("parent").status === "ready", "composer draft hydration"));
      const source = { conversationId: "parent", messageId: "root" };
      await act(async () => { controlsRef.current.selectReply(source); controlsRef.current.setText("Isolated Discord reply"); });
      source.messageId = "mutated-source";
      await act(async () => controlsRef.current.setReplyNotifyAuthor(false));
      assert.equal(view.querySelector('input[type="checkbox"]').checked, false);
      assert.throws(() => controlsRef.current.selectReply({ conversationId: "elsewhere", messageId: "root" }), /current conversation/);
      await act(async () => controlsRef.current.send());
      const rows = (await sql(`SELECT conversation_id,reply_to_message_id,reply_notify_author
        FROM ${prefix}.chat_messages WHERE content->>'text'='Isolated Discord reply'`)).rows;
      assert.deepEqual(rows, [{ conversation_id: "parent", reply_to_message_id: "root", reply_notify_author: false }]);
      assert.equal((await sql(`SELECT count(*)::int AS n FROM ${prefix}.chat_conversations WHERE type='thread'`)).rows[0].n, 0);
      let created;
      await act(async () => { created = await first.createThread({ rootMessageId: "root", name: "Separate discussion" }); });
      assert.equal(created.state, "ready", JSON.stringify(created));
      assert.notEqual(created.threadConversationId, "parent");
      let opened;
      await act(async () => {
        assert.equal((await second.getMessageTimeline({ conversationId: "parent", direction: "backward", limit: 20 })).status, "success");
        opened = await second.openThread("root");
      });
      assert.equal(opened.state, "ready", JSON.stringify(opened));
      assert.equal(opened.threadConversationId, created.threadConversationId);
      assert.deepEqual((await sql(`SELECT name FROM ${prefix}.chat_conversations WHERE root_message_id='root'`)).rows,
        [{ name: "Separate discussion" }]);
    });
  } finally {
    for (const { root, container } of mounts.reverse()) { await act(async () => root.unmount()); container.remove(); }
    for (const client of clients) client.close();
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await harness?.teardown();
    await window.happyDOM.close();
  }
});
