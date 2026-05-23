import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('node-pty', () => ({
  spawn: () => { throw new Error('node-pty not mockable in unit test -- helpers under test do not call spawn') },
}))

vi.mock('../../../src/main/account-identity', () => ({
  readClaudeAccountEmail: () => null,
  readCodexAccountEmail: () => ({ email: 'codex@example.com', name: 'CU', accountUuid: 'acct-1', provider: 'codex' as const }),
}))

import { captureCodexSpawnIdentity, getCodexSpawnIdentityMap, clearCodexSpawnIdentity } from '../../../src/main/pty-manager'

describe('codex spawn-time identity capture', () => {
  beforeEach(() => {
    clearCodexSpawnIdentity('s1')
    clearCodexSpawnIdentity('s2')
    clearCodexSpawnIdentity('sNull')
  })

  it('captures identity for a session id', () => {
    captureCodexSpawnIdentity('s1')
    expect(getCodexSpawnIdentityMap().get('s1')).toEqual({
      email: 'codex@example.com',
      name: 'CU',
      accountUuid: 'acct-1',
      provider: 'codex',
    })
  })

  it('different session ids get the same identity at the same point in time', () => {
    captureCodexSpawnIdentity('s1')
    captureCodexSpawnIdentity('s2')
    expect(getCodexSpawnIdentityMap().get('s1')).toEqual(getCodexSpawnIdentityMap().get('s2'))
  })

  it('clearCodexSpawnIdentity removes the entry', () => {
    captureCodexSpawnIdentity('s1')
    clearCodexSpawnIdentity('s1')
    expect(getCodexSpawnIdentityMap().get('s1')).toBeUndefined()
  })

  it('handles null identity gracefully (does not add map entry)', async () => {
    // Use vi.spyOn against the live module rather than vi.doMock + re-import.
    const id = await import('../../../src/main/account-identity')
    const spy = vi.spyOn(id, 'readCodexAccountEmail').mockReturnValueOnce(null)
    captureCodexSpawnIdentity('sNull')
    expect(getCodexSpawnIdentityMap().get('sNull')).toBeUndefined()
    spy.mockRestore()
  })
})
