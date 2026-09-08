import {
  parseReplyStylePreferenceState, parseUpdateReplyStylePreferenceInput,
  parseUpdateReplyStylePreferenceResult, resolveReplyStylePreference,
  supportsReplyStylePreference,
  type ReplyStyle, type UpdateReplyStylePreferenceInput, type ReplyStylePreferenceState,
  type GetReplyStylePreferenceInput,
} from '../src/contracts/reply-style-preference.js';
const input: UpdateReplyStylePreferenceInput = { operation: 'update_reply_style_preference', style: 'current', baseRevision: 0, idempotencyKey: 'key' };
parseUpdateReplyStylePreferenceInput(input);
const state = parseReplyStylePreferenceState({ state: 'saved', revision: 8, style: 'future' });
const resolved: ReplyStyle = resolveReplyStylePreference(state);
void resolved;
supportsReplyStylePreference({});
const result = parseUpdateReplyStylePreferenceResult({}, input);
if (result.reconciliationStatus !== 'preference_revision_conflict') {
  const supported: ReplyStyle = result.preference.style;
  void supported;
}
// @ts-expect-error saved unknown strings are not necessarily supported write styles
const unknownWrite: ReplyStyle = state.style;
// @ts-expect-error unsupported writes are forbidden
const badStyle: UpdateReplyStylePreferenceInput = { ...input, style: 'future' };
// @ts-expect-error trusted identity forbidden even on structural variables
const badActor: UpdateReplyStylePreferenceInput = { ...input, actorUserId: 'spoof' };
const injected = { ...input, authorization: 'spoof' };
// @ts-expect-error no structural authorization injection
const badAuthorization: UpdateReplyStylePreferenceInput = injected;
// @ts-expect-error GET cannot select another identity
const badGet: GetReplyStylePreferenceInput = { tenantId: 'spoof' };
// @ts-expect-error absence never carries a style
const badAbsence: ReplyStylePreferenceState = { state: 'absent', revision: 0, style: 'current' };
void [unknownWrite, badStyle, badActor, badAuthorization, badGet, badAbsence];
