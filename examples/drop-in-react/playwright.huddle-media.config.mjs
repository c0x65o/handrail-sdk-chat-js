import { defineConfig } from '@playwright/test';
import base from './playwright.cross-client-recovery.config.mjs';
export default defineConfig({ ...base, use: { ...base.use, trace: 'off' }, testMatch: 'flutter-huddle-media.spec.mjs', timeout: 180_000 });
