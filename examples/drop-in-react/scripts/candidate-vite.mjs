import { fileURLToPath } from 'node:url';
import { verifyCandidate } from '../../../scripts/candidate-provenance.mjs';
export function candidateViteConfig() {
  const candidate = verifyCandidate();
  return {
    alias: [
      { find: '@handrail/chat/ui/styles.css', replacement: fileURLToPath(new URL('../../../dist/ui/styles.css', import.meta.url)) },
      ...['client', 'react', 'ui'].map(entry => ({ find: `@handrail/chat/${entry}`, replacement: fileURLToPath(new URL(`../../../dist/${entry}/index.js`, import.meta.url)) })),
      { find: /^@handrail\/chat$/, replacement: fileURLToPath(new URL('../../../dist/index.js', import.meta.url)) },
    ],
    define: { __HANDRAIL_CHAT_CANDIDATE__: JSON.stringify({ source: candidate.source.sha256, package: candidate.package.sha256 }) },
  };
}
