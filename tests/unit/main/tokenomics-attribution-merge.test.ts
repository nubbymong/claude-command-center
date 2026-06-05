import { describe, it, expect } from 'vitest'
import { mergeSessionRecordAttribution } from '../../../src/main/tokenomics-manager'
import type { TokenomicsSessionRecord } from '../../../src/shared/types'

describe('mergeSessionRecordAttribution', () => {
  const base: TokenomicsSessionRecord = {
    sessionId: 'sX',
    projectDir: '/p',
    model: 'sonnet',
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCostUsd: 0,
    messageCount: 0,
    firstTimestamp: '2026-01-01T00:00:00Z',
    lastTimestamp: '2026-01-01T00:00:00Z',
  }

  it('preserves accountEmail when existing record has one and new fields do not', () => {
    const existing = { ...base, accountEmail: 'alice@example.com' }
    const newFields = { ...base, totalInputTokens: 100 }
    const merged = mergeSessionRecordAttribution(existing, newFields)
    expect(merged.accountEmail).toBe('alice@example.com')
    expect(merged.totalInputTokens).toBe(100)
  })

  it('uses newFields.accountEmail when existing is undefined', () => {
    const existing = { ...base }
    const newFields = { ...base, accountEmail: 'bob@example.com' }
    const merged = mergeSessionRecordAttribution(existing, newFields)
    expect(merged.accountEmail).toBe('bob@example.com')
  })

  it('preserves attributionMixed flag set by user', () => {
    const existing = { ...base, attributionMixed: true }
    const newFields = { ...base, accountEmail: 'x@y.com' }
    const merged = mergeSessionRecordAttribution(existing, newFields)
    expect(merged.attributionMixed).toBe(true)
    expect(merged.accountEmail).toBe('x@y.com')
  })

  it('preserves accountUuid when existing has one', () => {
    const existing = { ...base, accountUuid: 'uuid-old' }
    const newFields = { ...base, accountUuid: 'uuid-new' }
    const merged = mergeSessionRecordAttribution(existing, newFields)
    expect(merged.accountUuid).toBe('uuid-old')
  })

  it('preserves profileId when existing has one (survives re-parse)', () => {
    const existing = { ...base, profileId: 'prof-old' }
    const newFields = { ...base, profileId: 'prof-new' }
    const merged = mergeSessionRecordAttribution(existing, newFields)
    expect(merged.profileId).toBe('prof-old')
  })

  it('uses newFields.profileId when existing is undefined', () => {
    const existing = { ...base }
    const newFields = { ...base, profileId: 'prof-new' }
    const merged = mergeSessionRecordAttribution(existing, newFields)
    expect(merged.profileId).toBe('prof-new')
  })
})
