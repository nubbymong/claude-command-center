// tests/unit/channel-envelope.test.ts
import { describe, it, expect } from 'vitest'
import { formatTier1, summarise } from '../../src/main/channel-envelope'
import type { ChannelPayload, ChannelEnvelopeMeta } from '../../src/shared/channel-types'

const meta: ChannelEnvelopeMeta = { source: 'github', ts: '2026-05-27T14:32:01Z', from: 'frontend-redesign' }

describe('formatTier1', () => {
  it('wraps a sentinel block in bracketed-paste escapes with header + footer', () => {
    const payload: ChannelPayload = { kind: 'github-pr', title: 'fix api', number: 48, url: 'http://x', ciStatus: 'passing' }
    const out = formatTier1(payload, meta)
    expect(out.startsWith('\x1b[200~')).toBe(true)
    expect(out.endsWith('\x1b[201~')).toBe(true)
    expect(out).toContain('[ccc-channel:github  ts:2026-05-27T14:32:01Z  from:frontend-redesign]')
    expect(out).toContain('[/ccc-channel]')
    expect(out).toContain('PR #48')
  })
  it('omits from: when absent and adds fired-by:system for rule fires', () => {
    const out = formatTier1({ kind: 'rule', text: 'hi' }, { source: 'rule:pr-cascade', ts: meta.ts, firedBy: 'system' })
    expect(out).toContain('[ccc-channel:rule:pr-cascade  ts:2026-05-27T14:32:01Z  fired-by:system]')
    expect(out).not.toContain('from:')
  })
  it('truncates bodies over 8KB with a note line', () => {
    const big = 'x'.repeat(9000)
    const out = formatTier1({ kind: 'memory-entry', title: 't', body: big }, meta)
    expect(out).toContain('[...truncated, full payload at')
    expect(out.length).toBeLessThan(9000 + 500)
  })
  it('summarise returns a short one-liner (for the ledger)', () => {
    expect(summarise({ kind: 'github-pr', title: 'fix api', number: 48, url: 'u' })).toContain('#48')
  })
})
