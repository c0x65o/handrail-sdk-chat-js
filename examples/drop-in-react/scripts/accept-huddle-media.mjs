import { runAcceptance } from './accept-flutter-cross-client-recovery.mjs';
await runAcceptance({ name: 'huddle-media', finding: 'huddle-real-media',
  config: 'playwright.huddle-media.config.mjs', evidenceFile: 'media.json', screenshots: 3 });
