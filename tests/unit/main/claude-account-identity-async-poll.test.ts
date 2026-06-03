import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stub Electron so the module resolves; pushAccountIdentity becomes a no-op
// (no identity file exists during this test, so it is never reached anyway).
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))

// The async poll must do its per-tick mtime check WITHOUT calling the sync fs API.
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  return { ...real, statSync: vi.fn(() => { throw new Error('statSync must not run on the poll tick') }) }
})

import * as identity from '../../../src/main/claude-account-identity'

describe('recheckAllAsync', () => {
  beforeEach(() => identity._resetForTest?.())

  it('exists and resolves without calling statSync on the tick path', async () => {
    identity.startWatchingAccountIdentity('s1', undefined)
    await expect(identity.recheckAllAsync()).resolves.toBeUndefined()
  })
})
