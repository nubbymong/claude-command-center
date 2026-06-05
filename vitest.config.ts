import { defineConfig, configDefaults } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
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
    testTimeout: 10_000,
    alias: {
      // Allow renderer store tests to import from src/renderer
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
})
