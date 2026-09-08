import { parseThreadListRequest, parseThreadListResult, type ThreadListItem, type ThreadListInactivityPolicy, type ThreadListRequest } from '../src/contracts/thread-list.js';
import type { ThreadConversationSnapshotSummary } from '../src/contracts/conversation-snapshot-runtime.js';
import type { ChatThreadInactivityPolicy } from '../src/server/thread-list-handler-options.js';
const request: ThreadListRequest = parseThreadListRequest({ parentConversationId: 'channel' });
const resolved = parseThreadListRequest(request);
const result = parseThreadListResult({}, resolved);
const summary: ThreadConversationSnapshotSummary | undefined = result.items[0]?.thread;
const sharedPolicy: ChatThreadInactivityPolicy = {} as ThreadListInactivityPolicy;
const wirePolicy: ThreadListInactivityPolicy = {} as ChatThreadInactivityPolicy;
// @ts-expect-error Invalid discovery selector.
const invalid: ThreadListRequest = { parentConversationId: request.parentConversationId, view: 'hidden' };
// @ts-expect-error Discovery never accepts caller-authored access authority.
const injected: ThreadListRequest = { parentConversationId: request.parentConversationId, userId: 'actor' };
// @ts-expect-error Every item carries independent canonical follow authority.
const incomplete: ThreadListItem = { thread: summary! };
void [sharedPolicy, wirePolicy, invalid, injected, incomplete];
