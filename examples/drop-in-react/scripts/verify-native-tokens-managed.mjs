import assert from 'node:assert/strict';
import { verifyCandidate } from '../../../scripts/candidate-provenance.mjs';
import { proveNativeTokens } from './native-token-browser-proof.mjs';

// Never starts a lab/database. Operations supplies the managed QA route.
const origin = process.env.CHAT_LAB_QA_URL;
const source = process.env.CHAT_CANDIDATE_SOURCE_SHA256;
const packageHash = process.env.CHAT_CANDIDATE_PACKAGE_SHA256;
const channelId = process.env.CHAT_LAB_ALLOWED_CHANNEL_ID;
const deniedChannelId = process.env.CHAT_LAB_DENIED_CHANNEL_ID;
if (![origin, source, packageHash, channelId, deniedChannelId].every(Boolean)) throw new Error('Managed QA URL, candidate hashes and isolated channel IDs required; no fallback runtime.');
const candidate = verifyCandidate();
assert.equal(candidate.source.sha256, source);
assert.equal(candidate.package.sha256, packageHash);
console.log(JSON.stringify(await proveNativeTokens({ origin, candidate, channelId, deniedChannelId })));
