import { describe, it, expect } from 'vitest'
import { slotKeyForSession, orphanSessionId } from '../../../src/renderer/components/logs/slot-key'

describe('slotKeyForSession', () => {
  it('config-keyed slot', () => expect(slotKeyForSession('s1', 'cfg-a')).toBe('cfg-a'))
  it('orphan slot', () => expect(slotKeyForSession('s1', null)).toBe('orphan:s1'))
})

describe('orphanSessionId', () => {
  it('strips orphan prefix', () => expect(orphanSessionId('orphan:abc123')).toBe('abc123'))
  it('passes through non-orphan slotKey', () => expect(orphanSessionId('cfg-xyz')).toBe('cfg-xyz'))
})
