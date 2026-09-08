import { parseMessageContextRequest, parseMessageContextResult, type MessageContextResult } from '../src/contracts/index.js';
import type { MessageSequence } from '../src/contracts/identifiers.js';
const request = parseMessageContextRequest({ conversationId: 'c', messageId: 'm' });
const result = parseMessageContextResult({}, request);
if (result.status === 'available') {
  const text: string = result.message.content.text;
  const sequence: MessageSequence = result.sequence;
  void [text, sequence];
} else if (result.status === 'deleted') {
  const redacted: null = result.message.content;
  const timestamp: string = result.message.deletedAt;
  void [redacted, timestamp];
} else {
  // @ts-expect-error Unavailable cannot supply source content.
  result.message.content;
}
// @ts-expect-error Deleted context must not expose content.
const leaking: MessageContextResult = { ...request, status: 'deleted', sequence: 1, message: { ...({} as Extract<MessageContextResult, { status: 'deleted' }>['message']), content: { format: 'plain', text: 'leak' } } };
// @ts-expect-error Unavailable cannot supply a sequence.
const existenceLeak: MessageContextResult = { ...request, status: 'unavailable', sequence: 1 };
// @ts-expect-error Expected request is mandatory.
parseMessageContextResult({});
void [leaking, existenceLeak];
