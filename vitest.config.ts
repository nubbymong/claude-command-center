import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
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
