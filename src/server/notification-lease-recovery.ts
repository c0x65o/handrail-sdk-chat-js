import {
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

/** Internal dispatcher recovery; intentionally absent from package barrels. */
export async function recoverExhaustedNotificationLeases(options: {
  readonly database: Pick<PostgresMigrationDatabase, "query">;
  readonly schema: string;
  readonly batchSize: number;
  readonly maxAttempts: number;
  /** One effective time for the batch; defaults to the database clock. */
  readonly now?: Date;
}): Promise<number> {
  const schema = validatePostgresSchema(options.schema);
  for (const name of ["batchSize", "maxAttempts"] as const) {
    if (!Number.isSafeInteger(options[name]) || options[name] < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  if (options.now !== undefined && !Number.isFinite(options.now.getTime())) {
    throw new TypeError("now must be a valid Date");
  }

  // Both writes share one statement and only returned delivery identities can
  // cancel reminders. Clearing the lease also fences late token completions.
  const result = await options.database.query(
    `WITH moment AS MATERIALIZED (
       SELECT COALESCE($3::timestamptz, clock_timestamp()) AS at
     ),
     exhausted AS MATERIALIZED (
       SELECT candidate.tenant_id, candidate.source_event_id,
              candidate.recipient_host_user_id, candidate.notification_kind
       FROM "${schema}".chat_notification_deliveries AS candidate
       CROSS JOIN moment
       WHERE candidate.status = 'leased'
         AND candidate.lease_expires_at <= moment.at
         AND candidate.attempt_count >= $2
       ORDER BY candidate.lease_expires_at, candidate.tenant_id,
                candidate.source_event_id, candidate.recipient_host_user_id,
                candidate.notification_kind
       FOR UPDATE OF candidate SKIP LOCKED
       LIMIT $1
     ),
     updated_delivery AS (
       UPDATE "${schema}".chat_notification_deliveries AS delivery
       SET status = 'failed',
           next_attempt_at = moment.at,
           lease_token = NULL,
           lease_acquired_at = NULL,
           lease_expires_at = NULL,
           last_error_class = 'unknown',
           last_error_at = moment.at,
           updated_at = moment.at
       FROM exhausted
       CROSS JOIN moment
       WHERE delivery.tenant_id = exhausted.tenant_id
         AND delivery.source_event_id = exhausted.source_event_id
         AND delivery.recipient_host_user_id = exhausted.recipient_host_user_id
         AND delivery.notification_kind = exhausted.notification_kind
         AND delivery.status = 'leased'
         AND delivery.lease_expires_at <= moment.at
         AND delivery.attempt_count >= $2
       RETURNING delivery.tenant_id, delivery.source_event_id,
                 delivery.recipient_host_user_id, delivery.notification_kind
     ),
     cancelled_reminder AS (
       UPDATE "${schema}".chat_message_reminders AS reminder
       SET status = 'cancelled',
           cancelled_at = moment.at,
           reminder_revision = reminder.reminder_revision + 1,
           updated_at = moment.at
       FROM updated_delivery
       CROSS JOIN moment
       WHERE updated_delivery.notification_kind = 'message.reminder'
         AND reminder.tenant_id = updated_delivery.tenant_id
         AND reminder.user_id = updated_delivery.recipient_host_user_id
         AND reminder.materialized_source_event_id = updated_delivery.source_event_id
         AND reminder.status = 'active'
         AND reminder.materialized_revision = reminder.reminder_revision
       RETURNING reminder.message_id
     )
     SELECT source_event_id FROM updated_delivery`,
    [options.batchSize, options.maxAttempts, options.now ?? null],
  );
  // Count deliveries, including those with no matching current reminder.
  return result.rowCount ?? 0;
}
