import { defineConfig, configDefaults } from 'vitest/config'
import { resolve } from 'path'
import { canvasBridgePlugin } from './scripts/vite-plugin-canvas-bridge.mjs'

export default defineConfig({
  // Tests drive the SAME bundled bridge string the app serves — no second,
  // hand-maintained copy of the in-page script to drift.
  plugins: [canvasBridgePlugin()],
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx', 'tests/integration/**/*.test.ts'],
    // `*.native.test.ts` load better-sqlite3 (built for Electron's ABI) and run
    // under Electron-as-Node via `npm run test:unit:native` — excluded here so
    // this system-Node run never tries to dlopen an Electron-ABI binary.
    exclude: [...configDefaults.exclude, '**/*.native.test.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
    // Integration tests (e.g. hooks synthetic path) spin up a real loopback
    // HTTP server and can take longer than a unit-test budget.
    //
    // 30s, raised from 10s (backlog item 44 — "identify the flaky test").
    //
    // The flake was never one test. A handful of MAIN-PROCESS suites do real
    // filesystem work and shell out to `icacls` to apply and read back Windows
    // DACLs — `harden-dir-acl-windows`, `canvas-plugin`, the `account-profiles`
    // group. Each icacls call is a process spawn, they are serialised by the
    // filesystem, and a single one can take seconds on a machine that is busy.
    // Run alone, `canvas-plugin.test.ts` takes ~41s for eleven tests and passes;
    // run alongside 590 other files on a loaded box, individual cases crossed
    // 10s and were reported as failures.
    //
    // So the symptom was "one full run reported a failure, every run since is
    // green" — an assertion never failed, a stopwatch did. A budget that a real,
    // passing test cannot meet on a busy machine does not measure correctness;
    // it measures how much else was running, and it costs someone an
    // investigation every time it fires. 30s is still far below the point where
    // a genuinely hung test would go unnoticed.
    testTimeout: 30_000,
    alias: {
      // Allow renderer store tests to import from src/renderer
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
})
