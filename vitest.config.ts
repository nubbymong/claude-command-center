import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/unit/setup.ts'],
    alias: {
      // Allow renderer store tests to import from src/renderer
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
})
