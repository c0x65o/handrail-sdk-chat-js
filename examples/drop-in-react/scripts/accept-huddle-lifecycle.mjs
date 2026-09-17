import assert from 'node:assert/strict';
import { runAcceptance } from './accept-flutter-cross-client-recovery.mjs';
await runAcceptance({ name: 'huddle-lifecycle', finding: 'active-share-crash-lifecycle',
  config: 'playwright.huddle-lifecycle.config.mjs', evidenceFile: 'lifecycle.json', screenshots: 2,
  verifyEvidence(evidence) {
    assert.deepEqual(evidence.errors, []);
    for (const label of ['tab-termination', 'browser-process-kill', 'signaling-loss', 'active-share-account-navigation']) {
      assert.equal(evidence.observations.find(row => row.label === label)?.converged, true);
    }
    assert.ok(evidence.observations.some(row => row.label === 'canonical-permission-revocation'));
    assert.ok(evidence.observations.some(row => row.label === 'same-user-sharing-survivor'));
    assert.equal(evidence.observations.find(row => row.label === 'owned-browser-exit')?.signal, 'SIGKILL');
  },
});
