// tests/unit/ipc-channels-channels.test.ts
import { describe, it, expect } from 'vitest'
import { IPC } from '../../src/shared/ipc-channels'

const EXPECTED = {
  CHANNELS_SEND: 'channels:send',
  CHANNELS_RETRACT: 'channels:retract',
  CHANNELS_FORCE_TIER: 'channels:forceTier',
  CHANNELS_LEDGER_EVENT: 'channels:ledgerEvent',
  CHANNELS_RULE_CRUD: 'channels:ruleCRUD',
  CHANNELS_STANDING_APPROVAL_CRUD: 'channels:standingApprovalCRUD',
  CHANNELS_CAPABILITY_DIAGNOSTICS: 'channels:capabilityDiagnostics',
  CHANNELS_INTRO_DISMISSED: 'channels:introDismissed',
  CHANNELS_KILL_SWITCH: 'channels:killSwitch',
}

describe('channels IPC constants', () => {
  it('defines all 9 with the exact string values', () => {
    for (const [k, v] of Object.entries(EXPECTED)) {
      expect((IPC as Record<string, string>)[k]).toBe(v)
    }
  })
  it('channel constant values are unique among all IPC values', () => {
    const values = Object.values(IPC)
    expect(new Set(values).size).toBe(values.length)
  })
})
