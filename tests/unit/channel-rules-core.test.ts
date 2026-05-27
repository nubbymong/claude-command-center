// tests/unit/channel-rules-core.test.ts
import { describe, it, expect } from 'vitest'
import { shouldFire, renderTemplate } from '../../src/main/channel-rules-core'
import type { ChannelRule } from '../../src/shared/channel-types'

const rule = (over: Partial<ChannelRule> = {}): ChannelRule => ({
  id: 'r', name: 'R', enabled: true, fireCount: 0,
  when: { event: 'pr:merged', branch: 'main' }, then: { template: 'x', target: 'dependent-branches' },
  cooldownMs: 30000, ...over,
})

describe('channel-rules-core', () => {
  it('shouldFire is false when disabled', () => {
    expect(shouldFire(rule({ enabled: false }), { event: 'pr:merged', branch: 'main' }, Date.now())).toBe(false)
  })
  it('shouldFire is false when the event name mismatches', () => {
    expect(shouldFire(rule(), { event: 'ci:failed' }, Date.now())).toBe(false)
  })
  it('shouldFire respects a branch filter', () => {
    expect(shouldFire(rule(), { event: 'pr:merged', branch: 'dev' }, Date.now())).toBe(false)
    expect(shouldFire(rule(), { event: 'pr:merged', branch: 'main' }, Date.now())).toBe(true)
  })
  it('shouldFire honours cooldown since lastFiredAt', () => {
    const now = Date.now()
    const r = rule({ lastFiredAt: new Date(now - 10_000).toISOString() }) // 10s ago, cooldown 30s
    expect(shouldFire(r, { event: 'pr:merged', branch: 'main' }, now)).toBe(false)
    expect(shouldFire(r, { event: 'pr:merged', branch: 'main' }, now + 30_000)).toBe(true)
  })
  it('shouldFire honours headroomBelow for anomaly rules', () => {
    const r = rule({ when: { event: 'tokenomics:anomaly', headroomBelow: 10 }, then: { template: 't', target: 'anomaly-session' } })
    expect(shouldFire(r, { event: 'tokenomics:anomaly', headroom: 5 } as any, Date.now())).toBe(true)
    expect(shouldFire(r, { event: 'tokenomics:anomaly', headroom: 50 } as any, Date.now())).toBe(false)
  })
  it('renderTemplate substitutes {vars} from the payload', () => {
    expect(renderTemplate('PR #{n} on {branch}', { n: 48, branch: 'main' })).toBe('PR #48 on main')
  })
})
