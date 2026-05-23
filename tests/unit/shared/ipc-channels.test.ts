import { describe, it, expect } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

describe('attribution IPC channels', () => {
  it('exports TOKENOMICS_LIST_UNATTRIBUTED', () => {
    expect(IPC.TOKENOMICS_LIST_UNATTRIBUTED).toBe('tokenomics:listUnattributed')
  })

  it('exports TOKENOMICS_ATTRIBUTE_SESSIONS', () => {
    expect(IPC.TOKENOMICS_ATTRIBUTE_SESSIONS).toBe('tokenomics:attributeSessions')
  })
})
