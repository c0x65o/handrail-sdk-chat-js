import "./candidate-binding.mjs";
const { leaveHuddleParticipation, HUDDLE_LEAVE_REASONS, LeaveHuddleCommandError,
  ChatAuthorizationError } = await import("@handrail/chat/server");

/** Canonical boundary for this single-process reference provider, not SDK policy. */
export function createChatLabMediaLifecycle(getBackend) {
  const read = async ({ roomId, actor, participation }) => {
    const backend = getBackend();
    if (!backend) return undefined;
    const { harness } = backend;
    const schema = `"${harness.schema}"`;
    const result = await harness.pool.query(
      `SELECT session.id AS "huddleSessionId", participant.joined_at::text AS "joinedAt",
              COALESCE(conversation.entity_type, parent.entity_type) AS entity_type,
              COALESCE(conversation.entity_id, parent.entity_id) AS entity_id
         FROM ${schema}.chat_huddle_sessions AS session
         JOIN ${schema}.chat_huddle_participants AS participant
           ON participant.tenant_id = session.tenant_id AND participant.huddle_session_id = session.id
         JOIN ${schema}.chat_conversations AS conversation
           ON conversation.tenant_id = session.tenant_id AND conversation.id = session.conversation_id
         JOIN ${schema}.chat_conversation_members AS member
           ON member.tenant_id = session.tenant_id AND member.conversation_id = session.conversation_id
           AND member.user_id = participant.user_id
         LEFT JOIN ${schema}.chat_conversations AS parent
           ON parent.tenant_id = conversation.tenant_id AND parent.id = conversation.parent_conversation_id
        WHERE session.provider_room_reference = $1 AND session.tenant_id = $2
          AND participant.user_id = $3 AND participant.left_at IS NULL
          AND session.status = 'active' AND member.state = 'active'
          AND conversation.archived_at IS NULL AND parent.archived_at IS NULL
          AND ($4::text IS NULL OR (session.id = $4 AND participant.joined_at = $5::timestamptz))`,
      [roomId, actor.tenantId, actor.userId, participation?.huddleSessionId ?? null,
        participation?.joinedAt ?? null],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const permissions = harness.adapters.permissions;
    if (!(await permissions.getCapabilities({ actor })).includes("huddle.join")) return undefined;
    if (row.entity_type !== null || row.entity_id !== null) {
      if (!row.entity_type || !row.entity_id || !(await permissions.authorizeEntity({ actor,
        entity: { type: row.entity_type, id: row.entity_id }, action: "huddle.join" }))) return undefined;
    }
    return { huddleSessionId: row.huddleSessionId, joinedAt: row.joinedAt };
  };
  return {
    async captureParticipation(input) {
      // Start may issue material before the initiator has joined. Such material
      // is not admission and must never acquire a later participation implicitly.
      return read(input);
    },
    async authorizeParticipant(grant) { return grant.participation !== undefined && Boolean(await read(grant)); },
    async releaseParticipation({ actor, participation, cleanupId }) {
      if (!participation) return;
      const { harness } = getBackend();
      try {
        await leaveHuddleParticipation({ database: harness.pool, schema: harness.schema,
          permissions: harness.adapters.permissions, actor,
          huddleSessionId: participation.huddleSessionId,
          expectedJoinedAt: participation.joinedAt,
          idempotencyKey: `lab-media:${cleanupId}`, reason: HUDDLE_LEAVE_REASONS.disconnect });
      } catch (error) {
        // These outcomes are already terminal. Storage failures stay retryable.
        if (error instanceof ChatAuthorizationError || (error instanceof LeaveHuddleCommandError &&
            ["participation_changed", "participant_already_left", "huddle_not_active"].includes(error.code))) return;
        throw error;
      }
    },
  };
}
