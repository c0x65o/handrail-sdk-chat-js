import { defineConfig } from '@playwright/test';
import base from './playwright.config.ts';
import path from 'node:path';

export default defineConfig({
  ...base,
  testMatch: 'flutter-cross-client-recovery.spec.mjs',
  retries: 0,
  workers: 1,
  forbidOnly: true,
  outputDir: path.join(process.env.CHAT_LAB_RECOVERY_ACCEPTANCE_DIR ?? 'test-results/cross-client-incomplete', 'browser'),
  reporter: [['list'], ['json']],
  use: { ...base.use, trace: 'retain-on-failure' },
});
