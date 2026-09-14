import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30000,
  // 1, not 0: a serial full run cold-starts Electron ~20 times, and Windows
  // process-tree teardown lag makes later cold starts bimodal — the same spec
  // that times out mid-suite passes alone (VM matrix, 2026-08-30). One retry
  // absorbs the timing blip while keeping it VISIBLE: Playwright reports the
  // test as "flaky", so a genuine failure still fails and a blip is a blip,
  // never silence.
  retries: 1,
  workers: 1, // Electron tests must run serially
  reporter: [['list']],
  use: {
    trace: 'off',
  },
})
