import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// Config for tests that load a native module built for Electron's ABI
// (currently better-sqlite3). Run via `npm run test:unit:native`, which launches
// these under Electron-as-Node (ELECTRON_RUN_AS_NODE=1) so the runtime ABI
// matches the electron-rebuilt binary. Test files must be named `*.native.test.ts`.
// The default `vitest run` config excludes that pattern so the system-Node run
// never tries to dlopen an Electron-ABI binary.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    globals: true,
    include: ['tests/unit/**/*.native.test.ts', 'tests/unit/**/*.native.test.tsx'],
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
    // Forks (not worker threads) play nicest with Electron-as-Node.
    pool: 'forks',
    // Native DB work (FTS over many rows, throughput tests) can exceed a
    // unit-test budget; give it more headroom than the default node run.
    testTimeout: 15_000,
    // Tolerate an empty run until the first native test lands.
    passWithNoTests: true,
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
})
