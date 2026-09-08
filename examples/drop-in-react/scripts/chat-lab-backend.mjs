import { createChatTestHarness } from "@handrail/chat/testing";

export const CHAT_LAB_PRIVATE_SEARCH_TEXT =
  "Quarantined orbital telemetry belongs in the private channel.";

export const CHAT_LAB_PUBLIC_CHANNEL_NAME = "Chat Lab General";
export const CHAT_LAB_EMPTY_CHANNEL_NAME = "Chat Lab Empty Room";
export const CHAT_LAB_DENSE_SIDEBAR_PROFILE = "dense-sidebar";
export const CHAT_LAB_DIRECT_MESSAGE_VISUAL_PROFILE = "direct-message-visual";
export const CHAT_LAB_DENSE_LONG_CHANNEL_NAME =
  "desktop-experience-navigation-reliability-and-launch-coordination";
export const CHAT_LAB_DENSE_LONG_PARTICIPANT_NAME =
  "Alexandria Cassandra Montgomery-Sutherland";

export const CHAT_LAB_PUBLIC_LINK_PREVIEW = Object.freeze({
  url: "https://handrail.test/chat-lab/desktop-review",
  title: "Chat Lab desktop review guide",
  siteName: "Handrail Design System",
  description: "Review the spacing, hierarchy, and containment checks for the desktop conversation experience.",
});

export const CHAT_LAB_PUBLIC_MESSAGES = Object.freeze([
  Object.freeze({
    authorId: "ada",
    text: "Good morning team — let’s use Chat Lab General to coordinate the desktop experience review.",
  }),
  Object.freeze({
    authorId: "grace",
    text: "I’ve connected the real Chat Lab server and I’m checking message groups, reactions, and threads.",
    blocks: Object.freeze([
      Object.freeze({
        type: "link_preview",
        data: CHAT_LAB_PUBLIC_LINK_PREVIEW,
      }),
    ]),
  }),
  Object.freeze({
    authorId: "grace",
    text: "Consecutive notes from the same author should stay compact while remaining easy to scan.",
  }),
  Object.freeze({
    authorId: "margaret",
    text: "For the launch readiness pass, please review the navigation hierarchy, conversation header, message timeline, composer behavior, responsive layout, and accessibility details together so this deliberately long update wraps across several lines without overpowering the rest of the conversation.",
  }),
  Object.freeze({
    authorId: "ada",
    text: "Perfect. Leave focused findings in the thread so the main timeline stays calm.",
  }),
]);

export const CHAT_LAB_EDITED_PUBLIC_MESSAGE = Object.freeze({
  authorId: "grace",
  originalText: "The desktop review is scheduled for tomorrow afternoon.",
  editedText: "The desktop review is confirmed for today at 2:00 PM.",
});

export const CHAT_LAB_PUBLIC_THREAD_REPLY_TEXT =
  "The public-channel review thread is ready for focused follow-up.";

export const CHAT_LAB_GROUP_DIRECT_MESSAGES = Object.freeze([
  Object.freeze({
    authorId: "ada",
    text: "Ada here — the group launch checklist is ready.",
  }),
  Object.freeze({
    authorId: "grace",
    text: "Grace has the server-side checks covered.",
  }),
  Object.freeze({
    authorId: "margaret",
    text: "Margaret will verify the final flight-readiness pass.",
  }),
]);

export const CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE = Object.freeze({
  authorId: "grace",
  originalText: "This superseded launch note should only survive as a tombstone.",
});

export const CHAT_LAB_ACTORS = Object.freeze([
  Object.freeze({
    id: "ada",
    credential: "chat-lab-ada",
    actor: Object.freeze({
      tenantId: "chat-lab",
      userId: "ada",
      roles: Object.freeze(["employee"]),
    }),
    capabilities: Object.freeze([
      "conversation.create",
      "conversation.read",
      "conversation.archive",
      "chat.members.manage",
      "message.send",
      "attachment.prepare",
      "message.edit",
      "message.delete",
      "reaction.set",
      "thread.create",
      "huddle.start",
      "huddle.join",
      "huddle.leave",
      "huddle.screen_share",
      "huddle.end",
    ]),
    user: Object.freeze({
      tenantId: "chat-lab",
      userId: "ada",
      displayName: "Ada Lovelace",
      avatar: Object.freeze({ kind: "initials", initials: "AL" }),
    }),
  }),
  Object.freeze({
    id: "grace",
    credential: "chat-lab-grace",
    actor: Object.freeze({
      tenantId: "chat-lab",
      userId: "grace",
      roles: Object.freeze(["employee"]),
    }),
    capabilities: Object.freeze([
      "conversation.create",
      "conversation.read",
      "conversation.archive",
      "message.send",
      "attachment.prepare",
      "message.edit",
      "message.delete",
      "reaction.set",
      "thread.create",
      "huddle.join",
      "huddle.leave",
      "huddle.screen_share",
    ]),
    user: Object.freeze({
      tenantId: "chat-lab",
      userId: "grace",
      displayName: "Grace Hopper",
      avatar: Object.freeze({ kind: "initials", initials: "GH" }),
    }),
  }),
  Object.freeze({
    id: "margaret",
    credential: "chat-lab-margaret",
    actor: Object.freeze({
      tenantId: "chat-lab",
      userId: "margaret",
      roles: Object.freeze(["employee"]),
    }),
    capabilities: Object.freeze([
      "conversation.create",
      "conversation.read",
      "conversation.archive",
      "message.send",
      "attachment.prepare",
      "message.edit",
      "message.delete",
      "reaction.set",
      "thread.create",
      "huddle.join",
      "huddle.leave",
    ]),
    user: Object.freeze({
      tenantId: "chat-lab",
      userId: "margaret",
      displayName: "Margaret Hamilton",
      avatar: Object.freeze({ kind: "initials", initials: "MH" }),
    }),
  }),
]);

const CHAT_LAB_DIRECT_MESSAGE_VISUAL_ACTORS = Object.freeze(
  CHAT_LAB_ACTORS.map((actor) => actor.id === "grace"
    ? Object.freeze({
        ...actor,
        user: Object.freeze({
          ...actor.user,
          status: Object.freeze({ availability: "online" }),
        }),
      })
    : actor),
);

const denseActorNames = Object.freeze([
  CHAT_LAB_DENSE_LONG_PARTICIPANT_NAME,
  "Benoit Laurent",
  "Chandra Okafor",
  "Dmitri Petrov",
  "Elena Rodriguez",
  "Farah Al-Khalil",
  "Gideon Mensah",
  "Haruki Tanaka",
  "Imani Washington",
  "Juniper Singh",
]);

export const CHAT_LAB_DENSE_ACTORS = Object.freeze(denseActorNames.map(
  (displayName, index) => {
    const suffix = String(index + 1).padStart(2, "0");
    const id = `dense-person-${suffix}`;
    return Object.freeze({
      id,
      credential: `chat-lab-${id}`,
      actor: Object.freeze({
        tenantId: "chat-lab",
        userId: id,
        roles: Object.freeze(["employee"]),
      }),
      capabilities: Object.freeze([
        "conversation.read",
        "message.send",
        "huddle.join",
        "huddle.leave",
      ]),
      user: Object.freeze({
        tenantId: "chat-lab",
        userId: id,
        displayName,
        avatar: Object.freeze({
          kind: "initials",
          initials: displayName.split(/\s+/u).slice(0, 2).map((part) => part[0]).join(""),
        }),
        status: Object.freeze({
          availability: index % 2 === 0 ? "online" : "offline",
        }),
      }),
    });
  },
));

export const CHAT_LAB_REPLY_STYLES_PROFILE = "reply-styles";
export const CHAT_LAB_REPLY_STYLES_ACTORS = Object.freeze([
  ["alice", "Alice"], ["bob", "Bob"], ["carol", "Carol"], ["dave", "Dave"],
].map(([id, displayName]) => Object.freeze({
  id, credential: `chat-lab-${id}`,
  actor: { tenantId: "chat-lab", userId: id, roles: [id === "dave" ? "observer" : "employee"] },
  capabilities: id === "dave" ? ["conversation.read"] : [
    "conversation.create", "conversation.read", "message.send", "thread.create",
    ...(["alice", "bob"].includes(id)
      ? ["chat.members.manage", "thread.manage", "conversation.archive"] : []),
  ],
  user: { tenantId: "chat-lab", userId: id, displayName,
    avatar: { kind: "initials", initials: displayName[0] } },
})));

const actorById = new Map([...CHAT_LAB_ACTORS, ...CHAT_LAB_REPLY_STYLES_ACTORS].map((actor) => [actor.id, actor]));

export const resolveChatLabActor = (actorId) => actorById.get(actorId);

const requireSuccess = (operation, result) => {
  if (result.status !== "success") {
    throw new Error(`Chat lab ${operation} failed: ${JSON.stringify(result)}`);
  }
  return result.value;
};

const denseSidebarNavigationSectionRank = (conversation) => {
  if (conversation.type === "channel") {
    return conversation.visibility === "private" ? 1 : 0;
  }
  if (conversation.type === "direct") return 2;
  if (conversation.type === "group_direct") return 3;
  return 4;
};

const createDenseSidebarSeed = async ({ ada, grace, harness }) => {
  const publicChannels = [];
  const privateChannels = [];
  const directs = [];
  const groupDirects = [];

  const updatePreference = async (label, input) => {
    let result = requireSuccess(
      label,
      await ada.updateConversationPreference(input),
    );
    if (result.reconciliationStatus === "preference_revision_conflict") {
      result = requireSuccess(
        `${label} retry`,
        await ada.updateConversationPreference(input),
      );
    }
    if (
      result.preference.notificationPreference !== input.notificationPreference ||
      result.preference.isStarred !== input.isStarred ||
      result.preference.mute.muted !== input.mute.muted
    ) {
      throw new Error(`Chat lab ${label} did not persist the requested preference`);
    }
  };

  for (let index = 0; index < 30; index += 1) {
    const ordinal = String(index + 1).padStart(2, "0");
    const name = index === 0
      ? CHAT_LAB_DENSE_LONG_CHANNEL_NAME
      : `dense-public-${ordinal}`;
    const channel = requireSuccess(
      `dense public channel ${ordinal} seed`,
      await ada.createChannel({ name, visibility: "public" }),
    );
    publicChannels.push(channel.conversation.conversation.id);
  }

  for (let index = 0; index < 8; index += 1) {
    const ordinal = String(index + 1).padStart(2, "0");
    const channel = requireSuccess(
      `dense private channel ${ordinal} seed`,
      await ada.createChannel({
        name: index === 0
          ? "dense-private-launch-readiness-and-confidential-operations"
          : `dense-private-${ordinal}`,
        visibility: "private",
      }),
    );
    privateChannels.push(channel.conversation.conversation.id);
  }

  for (const actor of CHAT_LAB_DENSE_ACTORS.slice(0, 8)) {
    const direct = requireSuccess(
      `dense direct ${actor.id} seed`,
      await ada.createDirect({ intendedMemberUserIds: [actor.id] }),
    );
    directs.push(direct.conversation.conversation.id);
  }

  const groupPairs = Object.freeze([
    [0, 1],
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 7],
    [7, 8],
  ]);
  for (const [left, right] of groupPairs) {
    const memberIds = [
      CHAT_LAB_DENSE_ACTORS[left].id,
      CHAT_LAB_DENSE_ACTORS[right].id,
    ];
    const group = requireSuccess(
      `dense group direct ${memberIds.join("+")} seed`,
      await ada.createGroupDirect({ intendedMemberUserIds: memberIds }),
    );
    groupDirects.push(group.conversation.conversation.id);
  }

  const unreadConversationId = publicChannels[1];
  const mentionConversationId = publicChannels[2];
  for (const [conversationId, label] of [
    [unreadConversationId, "unread"],
    [mentionConversationId, "mention"],
  ]) {
    requireSuccess(
      `dense ${label} channel membership seed`,
      await ada.addConversationMember({
        conversationId,
        expectedMemberListRevision: 1,
        targetUserId: "grace",
        requestedRole: "member",
      }),
    );
  }
  for (const text of [
    "Dense sidebar unread fixture message one.",
    "Dense sidebar unread fixture message two.",
  ]) {
    requireSuccess(
      "dense unread message seed",
      await grace.sendMessage({
        conversationId: unreadConversationId,
        content: { format: "plain", text },
      }),
    );
  }
  requireSuccess(
    "dense mention message seed",
    await grace.sendMessage({
      conversationId: mentionConversationId,
      content: {
        format: "plain",
        text: "Ada, the dense navigation mention fixture is ready.",
        mentions: [{ type: "user", userId: "ada" }],
      },
    }),
  );
  requireSuccess(
    "dense unread timeline hydration",
    await ada.getMessageTimeline({
      conversationId: unreadConversationId,
      direction: "backward",
      limit: 50,
    }),
  );
  requireSuccess(
    "dense mark-read seed",
    await ada.markRead({
      conversationId: unreadConversationId,
      throughSequence: 2,
    }),
  );
  requireSuccess(
    "dense mark-unread seed",
    await ada.markUnread({
      conversationId: unreadConversationId,
      fromSequence: 1,
    }),
  );

  const mutedConversationId = publicChannels[3];
  const mentionsOnlyConversationId = publicChannels[4];
  await updatePreference(
    "dense muted preference seed",
    {
      conversationId: mutedConversationId,
      notificationPreference: "all",
      isStarred: false,
      mute: { muted: true },
    },
  );
  await updatePreference(
    "dense mentions-only preference seed",
    {
      conversationId: mentionsOnlyConversationId,
      notificationPreference: "mentions",
      isStarred: false,
      mute: { muted: false },
    },
  );

  const activeHuddleConversationId = publicChannels[5];
  requireSuccess(
    "dense active huddle seed",
    await ada.startHuddle(activeHuddleConversationId),
  );

  const selectedConversationId = publicChannels.at(-1);
  harness.clock.advance(1_000);
  requireSuccess(
    "dense stable selected conversation seed",
    await ada.sendMessage({
      conversationId: selectedConversationId,
      content: {
        format: "plain",
        text: "Dense sidebar keeps this current-actor conversation selected and read.",
      },
    }),
  );

  const firstPage = requireSuccess(
    "dense first pagination page seed projection",
    await ada.listConversations({ scope: { type: "organization" }, limit: 50 }),
  );
  if (firstPage.page.nextCursor === undefined) {
    throw new Error(
      "Chat lab dense sidebar seed did not produce a second page",
    );
  }
  const secondPage = requireSuccess(
    "dense second pagination page seed projection",
    await ada.listConversations({
      scope: { type: "organization" },
      limit: 50,
      cursor: firstPage.page.nextCursor,
    }),
  );
  const laterConversationId = secondPage.items[0]?.id;
  if (laterConversationId === undefined) {
    throw new Error("Chat lab dense sidebar second page is empty");
  }
  const initialConversationIds = Object.freeze(
    [...firstPage.items]
      .sort((left, right) =>
        denseSidebarNavigationSectionRank(left) - denseSidebarNavigationSectionRank(right))
      .map(({ id }) => id),
  );

  return Object.freeze({
    profile: CHAT_LAB_DENSE_SIDEBAR_PROFILE,
    conversationIds: Object.freeze({
      publicChannels: Object.freeze(publicChannels),
      privateChannels: Object.freeze(privateChannels),
      directs: Object.freeze(directs),
      groupDirects: Object.freeze(groupDirects),
    }),
    states: Object.freeze({
      longChannel: publicChannels[0],
      longParticipantDirect: directs[0],
      unread: unreadConversationId,
      mention: mentionConversationId,
      muted: mutedConversationId,
      mentionsOnly: mentionsOnlyConversationId,
      onlineDirect: directs[0],
      offlineDirect: directs[1],
      privateChannel: privateChannels[0],
      activeHuddle: activeHuddleConversationId,
      selected: selectedConversationId,
    }),
    participants: Object.freeze({
      longNameUserId: CHAT_LAB_DENSE_ACTORS[0].id,
      onlineUserId: CHAT_LAB_DENSE_ACTORS[0].id,
      offlineUserId: CHAT_LAB_DENSE_ACTORS[1].id,
    }),
    pagination: Object.freeze({
      initialConversationIds,
      laterConversationId,
    }),
    seededConversationCount: firstPage.items.length + secondPage.items.length,
  });
};

export async function startChatLabBackend(options = {}) {
  const seedProfile = options.seedProfile ?? process.env.CHAT_LAB_SEED_PROFILE;
  let inactivityPolicy = Object.freeze({ hideAfterMs: 24 * 60 * 60 * 1_000 });
  if (
    seedProfile !== undefined &&
    seedProfile !== CHAT_LAB_DENSE_SIDEBAR_PROFILE &&
    seedProfile !== CHAT_LAB_DIRECT_MESSAGE_VISUAL_PROFILE &&
    seedProfile !== CHAT_LAB_REPLY_STYLES_PROFILE
  ) {
    throw new TypeError(`Unsupported Chat Lab seed profile: ${seedProfile}`);
  }
  const actors = seedProfile === CHAT_LAB_REPLY_STYLES_PROFILE
    ? CHAT_LAB_REPLY_STYLES_ACTORS
    : seedProfile === CHAT_LAB_DENSE_SIDEBAR_PROFILE
    ? Object.freeze([...CHAT_LAB_ACTORS, ...CHAT_LAB_DENSE_ACTORS])
    : seedProfile === CHAT_LAB_DIRECT_MESSAGE_VISUAL_PROFILE
      ? CHAT_LAB_DIRECT_MESSAGE_VISUAL_ACTORS
      : CHAT_LAB_ACTORS;
  const databaseUrl =
    options.databaseUrl ??
    process.env.CHAT_LAB_DATABASE_URL ??
    process.env.TEST_DATABASE_URL ??
    process.env.DATABASE_URL;
  const harness = await createChatTestHarness({
    ...(databaseUrl === undefined ? {} : { testDatabaseUrl: databaseUrl }),
    schemaPrefix: "handrail_chat_lab",
    httpObservability: {
      onOutcome(outcome) {
        if (outcome.statusCode >= 500) {
          console.error(JSON.stringify({ event: "chat_http_failure", ...outcome }));
        }
      },
    },
    initialTime: "2026-08-28T12:00:00.000Z",
    // Keep fixture call timestamps deterministic while minting short-lived
    // local media material against the same wall clock that validates it.
    mediaTokenNow: options.mediaTokenNow ?? (() => new Date()),
    ...(options.media === undefined ? {} : { media: options.media }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    actors,
    ...(seedProfile === CHAT_LAB_REPLY_STYLES_PROFILE ? {
      threadInactivityPolicy: () => inactivityPolicy,
    } : {}),
    features: {
      ...(seedProfile === CHAT_LAB_REPLY_STYLES_PROFILE ? {
        reply_style_preference_v1: true, inlineReplies: true, namedThreads: true,
        threadLifecycle: true, threadDiscovery: true, threadInactivity: true,
      } : {}),
      attachments: true,
      notifications: true,
      audit: false,
      realtime: true,
      media: true,
      typing: true,
      presence: true,
    },
  });

  try {
    if (seedProfile === CHAT_LAB_REPLY_STYLES_PROFILE) {
      const alice = harness.createClient("chat-lab-alice");
      const bob = harness.createClient("chat-lab-bob");
      try {
        await Promise.all([alice.start(), bob.start()]);
        const channel = requireSuccess("reply styles channel", await alice.createChannel({
          name: "Launch planning", visibility: "public",
        }));
        const conversationId = channel.conversation.conversation.id;
        for (const [index, targetUserId] of ["bob", "carol", "dave"].entries()) {
          requireSuccess(`${targetUserId} membership`, await alice.addConversationMember({
            conversationId, expectedMemberListRevision: index + 1, targetUserId, requestedRole: "member",
          }));
        }
        for (const [client, style] of [[alice, "current"], [bob, "discord"]]) {
          await client.replyStyle.load();
          const saved = await client.replyStyle.update(style);
          if (saved.saveStatus !== "saved") throw new Error(`Could not seed ${style} preference`);
        }
        const root = requireSuccess("Alice launch question", await alice.sendMessage({
          conversationId, content: { format: "plain", text: "Which launch date?" },
        }));
        await harness.runtime.notificationDispatcher?.runOnce();
        harness.calls.reset();
        // Keep the initial inline-reply scenario thread-free. QA can request the
        // archived history fixture through an explicit lab control when needed.
        let archivedFixture;
        const prerequisites = Object.freeze({
          snapshot: () => ({
            actors: actors.map(({ id, user, actor, capabilities }) => ({
              id, displayName: user.displayName, roles: actor.roles, capabilities,
              seededPreference: id === "alice" ? "current" : id === "bob" ? "discord" : null,
            })),
            conversationId, rootMessageId: root.message.id, inactivityPolicy,
            controls: {
              endpoint: "/__chat-lab/reply-styles",
              operations: ["set_inactivity_policy", "create_archived_thread"],
            },
          }),
          async execute(input) {
            if (input?.operation === "set_inactivity_policy" &&
                Object.keys(input).length === 2 &&
                (input.hideAfterMs === null ||
                  (Number.isSafeInteger(input.hideAfterMs) && input.hideAfterMs > 0))) {
              inactivityPolicy = input.hideAfterMs === null
                ? false : Object.freeze({ hideAfterMs: input.hideAfterMs });
              return { inactivityPolicy };
            }
            if (input?.operation !== "create_archived_thread" || Object.keys(input).length !== 1) {
              throw new TypeError("Unsupported reply-styles control");
            }
            archivedFixture ??= (async () => {
              const client = harness.createClient("chat-lab-alice");
              try {
                await client.start();
                const source = requireSuccess("archived history source", await client.sendMessage({
                  conversationId, content: { format: "plain", text: "Archived launch notes" },
                }));
                const thread = await client.createThread({
                  rootMessageId: source.message.id, name: "Archived launch history",
                });
                if (thread.state !== "ready") throw new Error("Could not create archived fixture thread");
                const reply = requireSuccess("archived history reply", await client.sendMessage({
                  conversationId: thread.threadConversationId,
                  content: { format: "plain", text: "Retained archived launch history" },
                }));
                const archive = requireSuccess("archive history", await client.archiveConversation({
                  conversationId: thread.threadConversationId, expectedLifecycleRevision: 1,
                }));
                return { threadId: thread.threadConversationId, rootMessageId: source.message.id,
                  replyMessageId: reply.message.id, archive };
              } finally {
                client.close();
              }
            })();
            return archivedFixture;
          },
        });
        return Object.freeze({ harness, actors, seedProfile, conversationId,
          rootMessageId: root.message.id, prerequisites });
      } finally {
        alice.close();
        bob.close();
      }
    }
    const ada = harness.createClient("chat-lab-ada");
    const grace = harness.createClient("chat-lab-grace");
    const margaret = harness.createClient("chat-lab-margaret");
    await Promise.all([ada.start(), grace.start(), margaret.start()]);

    const direct = requireSuccess(
      "direct conversation seed",
      await ada.createDirect({ intendedMemberUserIds: ["grace"] }),
    );
    const publicChannel = requireSuccess(
      "public channel seed",
      await ada.createChannel({ name: CHAT_LAB_PUBLIC_CHANNEL_NAME, visibility: "public" }),
    );
    for (const [targetUserId, expectedMemberListRevision] of [
      ["grace", 1],
      ["margaret", 2],
    ]) {
      requireSuccess(
        `${targetUserId} public channel membership seed`,
        await ada.addConversationMember({
          conversationId: publicChannel.conversation.conversation.id,
          expectedMemberListRevision,
          targetUserId,
          requestedRole: "member",
        }),
      );
    }
    const emptyChannel = requireSuccess(
      "empty channel seed",
      await ada.createChannel({ name: CHAT_LAB_EMPTY_CHANNEL_NAME, visibility: "public" }),
    );
    const privateChannel = requireSuccess(
      "private channel seed",
      await ada.createChannel({ name: "Chat Lab Private", visibility: "private" }),
    );
    requireSuccess(
      "private channel membership seed",
      await ada.addConversationMember({
        conversationId: privateChannel.conversation.conversation.id,
        expectedMemberListRevision: 1,
        targetUserId: "grace",
        requestedRole: "member",
      }),
    );
    const groupDirect = requireSuccess(
      "group direct seed",
      await ada.createGroupDirect({
        intendedMemberUserIds: ["grace", "margaret"],
      }),
    );
    const conversationIds = Object.freeze({
      direct: direct.conversation.conversation.id,
      emptyChannel: emptyChannel.conversation.conversation.id,
      publicChannel: publicChannel.conversation.conversation.id,
      privateChannel: privateChannel.conversation.conversation.id,
      groupDirect: groupDirect.conversation.conversation.id,
    });
    const privateSearchMessage = requireSuccess(
      "private search message seed",
      await ada.sendMessage({
        conversationId: conversationIds.privateChannel,
        content: {
          format: "plain",
          text: CHAT_LAB_PRIVATE_SEARCH_TEXT,
        },
      }),
    );
    const rootMessage = requireSuccess(
      "Ada message seed",
      await ada.sendMessage({
        conversationId: conversationIds.direct,
        content: {
          format: "plain",
          text: "Welcome to the real-stack Handrail Chat Lab.",
        },
      }),
    );
    requireSuccess(
      "Ada reaction seed",
      await ada.setReaction({
        messageId: rootMessage.message.id,
        reactionKey: "👍",
        reacted: true,
      }),
    );
    requireSuccess(
      "Grace direct timeline seed",
      await grace.getMessageTimeline({
        conversationId: conversationIds.direct,
        direction: "backward",
        limit: 50,
      }),
    );
    let directMessageVisualReadState;
    if (seedProfile === CHAT_LAB_DIRECT_MESSAGE_VISUAL_PROFILE) {
      requireSuccess(
        "Grace direct-message visual detail hydration",
        await grace.getConversation({ conversationId: conversationIds.direct }),
      );
      directMessageVisualReadState = requireSuccess(
        "Grace direct-message visual read receipt seed",
        await grace.markRead({
          conversationId: conversationIds.direct,
          throughSequence: rootMessage.message.sequence,
        }),
      ).readState;
    }
    requireSuccess(
      "Grace reaction seed",
      await grace.setReaction({
        messageId: rootMessage.message.id,
        reactionKey: "👀",
        reacted: true,
      }),
    );
    const thread = await ada.openThread(rootMessage.message.id);
    if (thread.state !== "ready") {
      throw new Error(`Chat lab thread seed failed: ${JSON.stringify(thread)}`);
    }
    const threadReply = requireSuccess(
      "thread reply seed",
      await ada.sendMessage({
        conversationId: thread.threadConversationId,
        content: {
          format: "plain",
          text: "Thread replies stay attached to their canonical root message.",
        },
      }),
    );
    requireSuccess(
      "Grace message seed",
      await grace.sendMessage({
        conversationId: conversationIds.direct,
        content: {
          format: "plain",
          text: "Switch personas above to verify live delivery and read state.",
        },
      }),
    );

    const seedClients = Object.freeze({ ada, grace, margaret });
    const publicMessages = [];
    for (const fixture of CHAT_LAB_PUBLIC_MESSAGES) {
      publicMessages.push(requireSuccess(
        `${fixture.authorId} public channel message seed`,
        await seedClients[fixture.authorId].sendMessage({
          conversationId: conversationIds.publicChannel,
          content: {
            format: "plain",
            text: fixture.text,
            ...(fixture.blocks === undefined ? {} : { blocks: fixture.blocks }),
          },
        }),
      ));
    }
    const editedPublicMessageSeed = requireSuccess(
      `${CHAT_LAB_EDITED_PUBLIC_MESSAGE.authorId} edited public message seed`,
      await seedClients[CHAT_LAB_EDITED_PUBLIC_MESSAGE.authorId].sendMessage({
        conversationId: conversationIds.publicChannel,
        content: {
          format: "plain",
          text: CHAT_LAB_EDITED_PUBLIC_MESSAGE.originalText,
        },
      }),
    );
    const editedPublicMessageResult = requireSuccess(
      `${CHAT_LAB_EDITED_PUBLIC_MESSAGE.authorId} public message edit`,
      await seedClients[CHAT_LAB_EDITED_PUBLIC_MESSAGE.authorId].editMessage({
        messageId: editedPublicMessageSeed.message.id,
        expectedRevision: 1,
        content: {
          format: "plain",
          text: CHAT_LAB_EDITED_PUBLIC_MESSAGE.editedText,
        },
      }),
    );
    if (
      editedPublicMessageResult.reconciliationStatus !== "applied" ||
      editedPublicMessageResult.canonicalRevision !== 2 ||
      editedPublicMessageResult.message.id !== editedPublicMessageSeed.message.id ||
      editedPublicMessageResult.message.revision.revision !== 2 ||
      editedPublicMessageResult.message.content.text !==
        CHAT_LAB_EDITED_PUBLIC_MESSAGE.editedText
    ) {
      throw new Error(
        `Chat lab public message edit failed: ${JSON.stringify(editedPublicMessageResult)}`,
      );
    }
    const publicRootMessage = publicMessages[0];
    for (const client of [grace, margaret]) {
      requireSuccess(
        "public channel reaction hydration",
        await client.getMessageTimeline({
          conversationId: conversationIds.publicChannel,
          direction: "backward",
          limit: 50,
        }),
      );
      requireSuccess(
        "public channel participant reaction seed",
        await client.setReaction({
          messageId: publicRootMessage.message.id,
          reactionKey: "👍",
          reacted: true,
        }),
      );
    }
    requireSuccess(
      "public channel Ada reaction seed",
      await ada.setReaction({
        messageId: publicRootMessage.message.id,
        reactionKey: "👀",
        reacted: true,
      }),
    );
    const publicThread = await ada.openThread(publicRootMessage.message.id);
    if (publicThread.state !== "ready") {
      throw new Error(
        `Chat lab public thread seed failed: ${JSON.stringify(publicThread)}`,
      );
    }
    const publicThreadReply = requireSuccess(
      "public thread reply seed",
      await ada.sendMessage({
        conversationId: publicThread.threadConversationId,
        content: { format: "plain", text: CHAT_LAB_PUBLIC_THREAD_REPLY_TEXT },
      }),
    );

    const groupDirectMessages = [];
    for (const fixture of CHAT_LAB_GROUP_DIRECT_MESSAGES) {
      groupDirectMessages.push(requireSuccess(
        `${fixture.authorId} group direct message seed`,
        await seedClients[fixture.authorId].sendMessage({
          conversationId: conversationIds.groupDirect,
          content: { format: "plain", text: fixture.text },
        }),
      ));
    }
    const deletedGroupDirectMessageSeed = requireSuccess(
      `${CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.authorId} deleted group direct message seed`,
      await seedClients[CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.authorId].sendMessage({
        conversationId: conversationIds.groupDirect,
        content: {
          format: "plain",
          text: CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.originalText,
        },
      }),
    );
    const deletedGroupDirectMessageSeedRevision =
      deletedGroupDirectMessageSeed.message.revision.revision;
    const deletedGroupDirectMessageResult = requireSuccess(
      `${CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.authorId} group direct message deletion`,
      await seedClients[CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.authorId].deleteMessage({
        messageId: deletedGroupDirectMessageSeed.message.id,
        expectedRevision: deletedGroupDirectMessageSeedRevision,
      }),
    );
    const deletedGroupDirectMessageRevision =
      deletedGroupDirectMessageSeedRevision + 1;
    if (
      deletedGroupDirectMessageResult.operation !== "soft_delete" ||
      deletedGroupDirectMessageResult.reconciliationStatus !== "applied" ||
      deletedGroupDirectMessageResult.expectedRevision !==
        deletedGroupDirectMessageSeedRevision ||
      deletedGroupDirectMessageResult.canonicalRevision !==
        deletedGroupDirectMessageRevision ||
      deletedGroupDirectMessageResult.message.id !==
        deletedGroupDirectMessageSeed.message.id ||
      deletedGroupDirectMessageResult.message.content !== null ||
      typeof deletedGroupDirectMessageResult.message.deletedAt !== "string" ||
      !Number.isFinite(Date.parse(deletedGroupDirectMessageResult.message.deletedAt)) ||
      deletedGroupDirectMessageResult.message.deletedByUserId !==
        CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.authorId ||
      deletedGroupDirectMessageResult.message.revision.revision !==
        deletedGroupDirectMessageRevision
    ) {
      throw new Error(
        `Chat lab group direct message deletion failed: ${JSON.stringify(deletedGroupDirectMessageResult)}`,
      );
    }
    const denseSidebar = seedProfile === CHAT_LAB_DENSE_SIDEBAR_PROFILE
      ? await createDenseSidebarSeed({ ada, grace, harness })
      : undefined;
    ada.close();
    grace.close();
    margaret.close();

    // Drain fixture notifications before exposing the harness. The adapter is
    // the in-process test boundary, so Chat Lab never contacts a provider and
    // focused tests start from an empty, deterministic delivery call log.
    await harness.runtime.notificationDispatcher?.runOnce();
    harness.calls.reset();

    return Object.freeze({
      harness,
      conversationId: conversationIds.direct,
      conversationIds,
      privateSearchMessageId: privateSearchMessage.message.id,
      privateSearchText: CHAT_LAB_PRIVATE_SEARCH_TEXT,
      publicMessageIds: Object.freeze(
        publicMessages.map(({ message }) => message.id),
      ),
      editedPublicMessage: Object.freeze({
        id: editedPublicMessageResult.message.id,
        text: editedPublicMessageResult.message.content.text,
        revision: editedPublicMessageResult.canonicalRevision,
      }),
      publicThreadConversationId: publicThread.threadConversationId,
      publicThreadReplyMessageId: publicThreadReply.message.id,
      groupDirectMessageIds: Object.freeze(
        groupDirectMessages.map(({ message }) => message.id),
      ),
      deletedGroupDirectMessage: Object.freeze({
        id: deletedGroupDirectMessageResult.message.id,
        authorId: CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.authorId,
        originalText: CHAT_LAB_DELETED_GROUP_DIRECT_MESSAGE.originalText,
        revision: deletedGroupDirectMessageResult.canonicalRevision,
        deletedAt: deletedGroupDirectMessageResult.message.deletedAt,
        deletedByUserId: deletedGroupDirectMessageResult.message.deletedByUserId,
      }),
      rootMessageId: rootMessage.message.id,
      threadConversationId: thread.threadConversationId,
      threadReplyMessageId: threadReply.message.id,
      actors,
      ...(directMessageVisualReadState === undefined
        ? {}
        : { directMessageVisualReadState }),
      ...(denseSidebar === undefined ? {} : { denseSidebar }),
    });
  } catch (error) {
    await harness.teardown();
    throw error;
  }
}
