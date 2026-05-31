// tests/unit/channel-types.test.ts
import { describe, it, expect } from 'vitest'
import { LEDGER_KINDS, CHANNEL_SOURCES, isChannelPayload } from '../../src/shared/channel-types'

describe('channel-types', () => {
  it('LEDGER_KINDS has exactly the 11 spec values', () => {
    expect(LEDGER_KINDS).toEqual([
      'bus-fire', 'bus-overflow', 'tray-overflow', 'permission-prompt',
      'permission-auto-allow', 'permission-approve', 'permission-deny',
      'permission-dismiss',
      'tier-2-fallback', 'tier-2-timeout', 'failed',
    ])
  })
  it('CHANNEL_SOURCES lists the canonical bus sources', () => {
    expect(CHANNEL_SOURCES).toContain('github')
    expect(CHANNEL_SOURCES).toContain('retraction')
    expect(CHANNEL_SOURCES).not.toContain('permission') // permission is a UI chip, not a bus source
  })
  it('isChannelPayload accepts a github-pr payload and rejects junk', () => {
    expect(isChannelPayload({ kind: 'github-pr', title: 'x', number: 1, url: 'u' })).toBe(true)
    expect(isChannelPayload({ kind: 'nope' })).toBe(false)
    expect(isChannelPayload(null)).toBe(false)
  })
})
