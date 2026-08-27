import { defineConfig } from 'vitest/config'

// LIVE connectivity test pack (tests/live/): drives the REAL pty-manager over
// real ssh against hosts named in tests/live/hosts.local.json (gitignored —
// see hosts.example.json). Run on demand with `npm run test:live:ssh`; never
// part of CI (`vitest.config.ts` includes only tests/unit + tests/integration,
// and CI has no LAN). Sequential: the combos share real remote state
// (~/.claude sidecars, tmux sessions), so parallel files would collide.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.ts'],
    testTimeout: 240_000,
    hookTimeout: 60_000,
    pool: 'forks',
    maxConcurrency: 1,
    fileParallelism: false,
  },
})
