import {
  parseGetReplyStylePreferenceInput,
  parseReplyStylePreferenceState,
  type ReplyStylePreferenceState,
} from "../contracts/reply-style-preference.js";
import type { TrustedChatActorContext } from "./contracts.js";
import {
  DEFAULT_POSTGRES_SCHEMA,
  validatePostgresSchema,
  type PostgresMigrationDatabase,
} from "./postgres-migrations.js";

export interface ReplyStylePreferenceQueryOptions {
  readonly database: PostgresMigrationDatabase;
  /** Trusted host-session identity; caller input cannot override these values. */
  readonly actor: TrustedChatActorContext;
  /** JSON-decoded caller input; the shared contract accepts only an empty object. */
  readonly input: unknown;
  readonly schema?: string;
}

interface StoredReplyStylePreferenceRow {
  readonly style: string;
  readonly revision: string | number;
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const validateActor = (actor: TrustedChatActorContext): void => {
  if (
    actor == null ||
    !nonEmptyString(actor.tenantId) ||
    !nonEmptyString(actor.userId) ||
    !Array.isArray(actor.roles) ||
    !actor.roles.every(nonEmptyString)
  ) {
    throw new TypeError("A valid trusted chat actor is required");
  }
};

const toPositiveRevision = (value: string | number): number => {
  const revision = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Invalid reply-style preference revision returned by PostgreSQL");
  }
  return revision;
};

/** Reads the actor's global tenant/user preference without resolving host policy. */
export async function queryReplyStylePreference(
  options: ReplyStylePreferenceQueryOptions,
): Promise<ReplyStylePreferenceState> {
  parseGetReplyStylePreferenceInput(options.input);
  validateActor(options.actor);
  const schema = validatePostgresSchema(
    options.schema ?? DEFAULT_POSTGRES_SCHEMA,
  );
  const prefix = `"${schema.replaceAll('"', '""')}"`;
  const result = await options.database.query<StoredReplyStylePreferenceRow>(
    `SELECT style, revision
     FROM ${prefix}.chat_user_reply_style_preferences
     WHERE tenant_id = $1 AND user_id = $2
     LIMIT 1`,
    [options.actor.tenantId, options.actor.userId],
  );
  const row = result.rows[0];
  return parseReplyStylePreferenceState(
    row === undefined
      ? { state: "absent", revision: 0 }
      : { state: "saved", revision: toPositiveRevision(row.revision), style: row.style },
  );
}
