// tests/unit/is-session-writable.test.ts
import { describe, it, expect, vi } from 'vitest'
// node-pty is native; stub it so importing pty-manager doesn't load the binary.
vi.mock('node-pty', () => ({ spawn: vi.fn() }))
const mod = await import('../../src/main/pty-manager')

describe('isSessionWritable', () => {
  it('returns false for an unknown session id', () => {
    expect(mod.isSessionWritable('does-not-exist')).toBe(false)
  })
})
