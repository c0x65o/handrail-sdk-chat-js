import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { candidateRoot, verifyCandidate } from '../../../scripts/candidate-provenance.mjs';

// A development resolver, not an SDK dependency installation. Keep the locked
// public HTTPS Git dependency intact for ordinary consumer installations.
export const candidate = verifyCandidate();
const entries = { '@handrail/chat': 'index.js', '@handrail/chat/server': 'server/index.js', '@handrail/chat/testing': 'testing/index.js', '@handrail/chat/client': 'client/index.js', '@handrail/chat/react': 'react/index.js', '@handrail/chat/ui': 'ui/index.js', '@handrail/chat/ui/styles.css': 'ui/styles.css' };
registerHooks({
  resolve(specifier, context, nextResolve) {
    const entry = entries[specifier];
    return nextResolve(entry ? pathToFileURL(join(candidateRoot, 'dist', entry)).href : specifier, context);
  },
});
