import { defineConfig } from '@playwright/test';
import base from './playwright.cross-client-recovery.config.mjs';
export default defineConfig({ ...base, use: { ...base.use, trace: 'off' }, testMatch: 'huddle-crash-lifecycle.spec.mjs', timeout: 240_000 });
