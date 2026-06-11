import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os'
import { validateProposal } from '../../src/main/sentinel/sentinel-apply'
import { _initRegistryForTest, getRegistry } from '../../src/main/model-registry-service'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-app-')); _initRegistryForTest(dir) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const base = {
  id: 'claude-new-1', patterns: ['new-1'], family: 'sonnet', label: 'New 1',
  provenance: { addedBy: 'sentinel' as const, date: '2026-06-11' },
}

describe('validateProposal (spec §7)', () => {
  it('valid proposal passes', () => {
    expect(validateProposal(getRegistry(), base).ok).toBe(true)
  })
  it('substring pattern with regex-special chars is VALID (matchEntry substring contract)', () => {
    expect(validateProposal(getRegistry(), { ...base, patterns: ['vision 2 (preview)'] }).ok).toBe(true)
  })
  it('anchored pattern that does not compile is rejected', () => {
    expect(validateProposal(getRegistry(), { ...base, patterns: ['^([bad'] }).ok).toBe(false)
  })
  it('non-positive pricing rejected', () => {
    const p = { ...base, fallbackPricing: { input: -1, output: 5, cacheRead: 0, cacheWrite: 0 } }
    expect(validateProposal(getRegistry(), p).ok).toBe(false)
  })
  it('absurd pricing rejected (sanity upper bound)', () => {
    const p = { ...base, fallbackPricing: { input: 99999, output: 5, cacheRead: 0, cacheWrite: 0 } }
    expect(validateProposal(getRegistry(), p).ok).toBe(false)
  })
  it('unknown family rejected', () => {
    expect(validateProposal(getRegistry(), { ...base, family: 'ghost' }).ok).toBe(false)
  })
  it('HIJACK GUARD: substring pattern that re-matches a known model -> rejected', () => {
    const r = validateProposal(getRegistry(), { ...base, patterns: ['opus'] })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/already-known/i)
  })
  it('HIJACK GUARD: anchored pattern matching a known id -> rejected', () => {
    expect(validateProposal(getRegistry(), { ...base, patterns: ['^claude-sonnet'] }).ok).toBe(false)
  })
  it('duplicate id vs existing registry entry -> rejected', () => {
    expect(validateProposal(getRegistry(), { ...base, id: 'claude-opus-4-8' }).ok).toBe(false)
  })
  it('invalid colour rejected; valid hex and var() accepted', () => {
    expect(validateProposal(getRegistry(), { ...base, color: 'red; background: url(x)' }).ok).toBe(false)
    expect(validateProposal(getRegistry(), { ...base, color: '#a1b2c3' }).ok).toBe(true)
    expect(validateProposal(getRegistry(), { ...base, color: 'var(--chart-other)' }).ok).toBe(true)
  })
})

describe('apply / revert round-trip', () => {
  it('apply validates, writes overlay, marks applied; revert frees the id for re-apply', async () => {
    const { initSentinel, sentinelApply, sentinelRevert } = await import('../../src/main/sentinel/index')
    const st = initSentinel(dir)
    st.upsertFinding({
      id: 'obs:model:claude-new-1', kind: 'registry-proposal', severity: 'warn',
      title: 't', evidence: 'e', status: 'open', createdAt: 1, proposedPatch: base,
    })
    expect(sentinelApply('obs:model:claude-new-1').ok).toBe(true)
    expect(getRegistry().models.some((m) => m.id === 'claude-new-1')).toBe(true)
    expect(st.snapshot().findings[0].status).toBe('applied')
    expect(sentinelApply('obs:model:claude-new-1').ok).toBe(false)   // id now exists
    sentinelRevert('obs:model:claude-new-1')
    expect(getRegistry().models.some((m) => m.id === 'claude-new-1')).toBe(false)
    expect(st.snapshot().findings[0].status).toBe('open')
    expect(sentinelApply('obs:model:claude-new-1').ok).toBe(true)    // re-apply works
  })
})
