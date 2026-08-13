import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Finding #1 from the re-attack: config-manager's fix routed writes through
// mkdirSecure, which THROWS when CONFIG is a planted reparse point. writeConfig
// has always returned false on failure (never thrown) and its callers -- the
// config-saver plus the cloud-agent/team persisters that run from callbacks with
// no try/catch -- depend on that; a thrown ensureConfigDir bricked a legit
// symlinked-CONFIG layout and could crash the main process. These tests pin the
// contract: fail CLOSED (false / empty), never throw. Refusing to write the
// secret into the junction is preserved -- mkdirSecure still throws, we just
// catch it.

const h = vi.hoisted(() => ({ res: '' }))

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => h.res,
  registerSetupHandlers: () => {},
}))

// Simulate a planted reparse point at CONFIG: mkdirSecure refuses it. Everything
// else in account-profiles stays real.
vi.mock('../../src/main/account-profiles', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/account-profiles')>()
  return {
    ...real,
    mkdirSecure: () => {
      throw new Error('refusing to write credentials: <CONFIG> is a reparse point, not a real directory')
    },
  }
})

import { writeConfig, loadAllConfig } from '../../src/main/config-manager'

beforeEach(() => {
  h.res = mkdtempSync(join(tmpdir(), 'cfg-fc-'))
})

describe('config-manager fails closed (never throws) when CONFIG is a reparse point', () => {
  it('writeConfig returns false instead of throwing', () => {
    let r: boolean | undefined
    expect(() => { r = writeConfig('commands', [{ id: 'x' }]) }).not.toThrow()
    expect(r).toBe(false)
  })

  it('writeConfig of the secret returns false, never writing into the junction', () => {
    let r: boolean | undefined
    expect(() => { r = writeConfig('conductorSecret', { secret: 'a'.repeat(64) }) }).not.toThrow()
    expect(r).toBe(false)
  })

  it('loadAllConfig hydrates empty instead of throwing', () => {
    let res: { data: Record<string, unknown>; needsMigration: boolean } | undefined
    expect(() => { res = loadAllConfig() }).not.toThrow()
    expect(res!.data).toEqual({})
    expect(res!.needsMigration).toBe(true)
  })
})
