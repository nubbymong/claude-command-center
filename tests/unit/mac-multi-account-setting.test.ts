// @vitest-environment node
// Main's reader of the experimental macOS multi-account setting
// (src/main/mac-multi-account.ts): the saved settings file, fail-closed, and
// never read at all off macOS.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  reads: 0,
  result: { outcome: 'absent', value: null } as { outcome: string; value: unknown },
  throws: false,
}))
vi.mock('../../src/main/config-manager', () => ({
  readConfigChecked: () => {
    h.reads++
    if (h.throws) throw new Error('disk gone')
    return h.result
  },
}))

const { isMacMultiAccountEnabled } = await import('../../src/main/mac-multi-account')

beforeEach(() => { h.reads = 0; h.throws = false; h.result = { outcome: 'absent', value: null } })

describe('isMacMultiAccountEnabled', () => {
  it('on macOS: on only for a clean read of a saved true', () => {
    h.result = { outcome: 'ok', value: { experimentalMacMultiAccount: true } }
    expect(isMacMultiAccountEnabled('darwin')).toBe(true)
    h.result = { outcome: 'ok', value: { experimentalMacMultiAccount: false } }
    expect(isMacMultiAccountEnabled('darwin')).toBe(false)
    h.result = { outcome: 'ok', value: {} }
    expect(isMacMultiAccountEnabled('darwin')).toBe(false)
    h.result = { outcome: 'ok', value: { experimentalMacMultiAccount: 'true' } }
    expect(isMacMultiAccountEnabled('darwin')).toBe(false)
  })

  it('on macOS: an absent, unparseable or failed read, or a throw, is OFF', () => {
    for (const outcome of ['absent', 'unparseable', 'failed']) {
      h.result = { outcome, value: { experimentalMacMultiAccount: true } }
      expect(isMacMultiAccountEnabled('darwin'), outcome).toBe(false)
    }
    h.throws = true
    expect(isMacMultiAccountEnabled('darwin')).toBe(false)
  })

  it('off macOS: off, and the settings file is not even read', () => {
    h.result = { outcome: 'ok', value: { experimentalMacMultiAccount: true } }
    for (const p of ['win32', 'linux'] as const) expect(isMacMultiAccountEnabled(p)).toBe(false)
    expect(h.reads).toBe(0)
  })
})
