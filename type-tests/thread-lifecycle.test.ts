import { parseThreadLifecycleInput as parseClientInput, type ThreadLifecycleResult as ClientResult } from '../src/client/index.js';
import {
  parseThreadLifecycleInput, parseThreadLifecycleResult, serializeThreadLifecycleInput,
  serializeThreadLifecycleResult, parseThreadLifecycleHttpInput, serializeThreadLifecycleBody,
  THREAD_LIFECYCLE_FEATURE, THREAD_LIFECYCLE_PATH,
  type ThreadLifecycle, type ThreadLifecycleInput, type ThreadLifecycleResult,
  type ThreadLifecycleIntent, type ThreadLifecycleReconciliationStatus,
} from '../src/index.js';
const input: ThreadLifecycleInput = parseThreadLifecycleInput({});
const result: ThreadLifecycleResult = parseThreadLifecycleResult({}, input);
const lifecycle: ThreadLifecycle = result.threadLifecycle;
const intent: ThreadLifecycleIntent = input.intent;
const status: ThreadLifecycleReconciliationStatus = result.reconciliationStatus;
// @ts-expect-error No ambiguous toggles.
const toggle: ThreadLifecycleIntent = 'toggle';
// @ts-expect-error No trusted actor input.
const actor: ThreadLifecycleInput = { ...input, actorUserId: 'user' };
// @ts-expect-error Every response echoes the idempotency key.
const incomplete: ThreadLifecycleResult = { operation: input.operation, intent, threadId: input.threadId, expectedLifecycleRevision: 1, reconciliationStatus: status, previousLifecycle: lifecycle, threadLifecycle: lifecycle };
// @ts-expect-error The prerequisite canonical model forbids open/locked.
const locked: ThreadLifecycle = { revision: 1, locked: true };
void [toggle, actor, incomplete, locked, serializeThreadLifecycleInput, serializeThreadLifecycleResult,
  parseThreadLifecycleHttpInput, serializeThreadLifecycleBody, THREAD_LIFECYCLE_FEATURE, THREAD_LIFECYCLE_PATH];

const clientResult: ClientResult = result;
void [parseClientInput, clientResult];
