import {
  createApplicationChatStorage,
  type ApplicationChatStorageIdentity,
} from "@handrail/chat/client";

const prefix = (identity: ApplicationChatStorageIdentity) =>
  `chat-lab:reply-styles:${JSON.stringify(identity)}:`;

/** Tab-local host storage for the opt-in demo; SDK owns encoding, drafts and send queues.
 * Synchronous sessionStorage operations are atomic within this single tab. No credentials
 * are stored, and the lab instance in deviceId isolates subsequent backend seeds.
 */
export const createChatLabReplyStorage = () => createApplicationChatStorage({
  async read(identity, kind) { return sessionStorage.getItem(prefix(identity) + kind); },
  async replace(identity, kind, record) { sessionStorage.setItem(prefix(identity) + kind, record); },
  async remove(identity, kind) { sessionStorage.removeItem(prefix(identity) + kind); },
  async compareExchange(identity, kind, expected, replacement) {
    const key = prefix(identity) + kind;
    if (sessionStorage.getItem(key) !== expected) return false;
    if (replacement === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, replacement);
    return true;
  },
  async clearForLogout(identity) {
    const keys = Object.keys(sessionStorage).filter(key => key.startsWith(prefix(identity)));
    for (const key of keys) sessionStorage.removeItem(key);
  },
});
