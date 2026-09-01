import { defineConfig } from 'vitest/config'

// LIVE connectivity test pack (tests/live/): drives the REAL pty-manager over
// real ssh against hosts named in tests/live/hosts.local.json (gitignored —
// see hosts.example.json). Run on demand with `npm run test:live:ssh`; never
// part of CI (`vitest.config.ts` includes only tests/unit + tests/integration,
// and CI has no LAN).
//
// Parallelism model (2026-08-31): the statusline matrix is one lane FILE per
// TARGET host (statusline-harness.ts) and lanes run in parallel — distinct
// hosts share no remote state, and each lane starts its own conductor MCP
// server on a distinct port. Combos against the SAME host stay ordered inside
// their lane file (maxConcurrency 1), because those DO share remote state
// (~/.claude sidecars, tmux sessions). CCC_LIVE_WORKERS caps the worker count
// for small FROM boxes (default: one worker per lane file).
export default defineConfig({
  test: {
    include: ['tests/live/**/*.live.ts'],
    testTimeout: 240_000,
    hookTimeout: 60_000,
    pool: 'forks',
    maxConcurrency: 1,
    fileParallelism: true,
    ...(process.env.CCC_LIVE_WORKERS ? { maxWorkers: Number(process.env.CCC_LIVE_WORKERS) } : {}),
  },
})
