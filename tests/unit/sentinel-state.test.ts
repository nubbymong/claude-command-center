import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os'
import { SentinelState } from '../../src/main/sentinel/sentinel-state'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-sen-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const finding = {
  id: 'obs:model:claude-x-1', kind: 'registry-proposal' as const, severity: 'warn' as const,
  title: 'Unknown model claude-x-1', evidence: 'statusline', status: 'open' as const, createdAt: 1,
}

describe('SentinelState', () => {
  it('persists and reloads findings + lastSeenCcVersion', () => {
    const s = new SentinelState(dir)
    s.upsertFinding(finding)
    s.setLastSeenCcVersion('2.0.13')
    const s2 = new SentinelState(dir)
    expect(s2.snapshot().findings).toHaveLength(1)
    expect(s2.snapshot().lastSeenCcVersion).toBe('2.0.13')
  })
  it('upsert by id is idempotent (dedup) and does not resurrect non-open findings', () => {
    const s = new SentinelState(dir)
    s.upsertFinding(finding); s.upsertFinding(finding)
    expect(s.snapshot().findings).toHaveLength(1)
    s.setStatus(finding.id, 'dismissed')
    s.upsertFinding(finding)                       // re-observation of a dismissed finding
    expect(s.snapshot().findings[0].status).toBe('dismissed')
  })
  it('setStatus transitions and notifies subscribers', () => {
    const s = new SentinelState(dir)
    let pushes = 0; s.subscribe(() => pushes++)
    s.upsertFinding(finding); s.setStatus(finding.id, 'applied')
    expect(s.snapshot().findings[0].status).toBe('applied')
    expect(pushes).toBe(2)
  })
  it('corrupt state file -> empty state, no throw (fail-open)', () => {
    fs.mkdirSync(path.join(dir, 'sentinel'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sentinel', 'sentinel-state.json'), 'oops')
    expect(new SentinelState(dir).snapshot().findings).toEqual([])
  })
})

// P3.9: the Codex version the last check saw persists; whose update was being
// analysed does not survive a restart (nothing is analysing at load).
describe('SentinelState for Codex (P3.9)', () => {
  it('persists and reloads lastSeenCodexVersion; a state file from before has none', () => {
    const s = new SentinelState(dir)
    expect(s.snapshot().lastSeenCodexVersion).toBeNull()
    s.setLastSeenCodexVersion('0.155.1')
    expect(new SentinelState(dir).snapshot()).toMatchObject({ lastSeenCodexVersion: '0.155.1', lastSeenCcVersion: null })
  })
  it('setAnalyzing names whose update runs, and clears it when it stops; a reload never starts analysing', () => {
    const s = new SentinelState(dir)
    s.setAnalyzing(true, null, 'codex')
    expect(s.snapshot()).toMatchObject({ analyzing: true, analyzingProvider: 'codex' })
    expect(new SentinelState(dir).snapshot()).toMatchObject({ analyzing: false, analyzingProvider: null })
    s.setAnalyzing(false)
    expect(s.snapshot()).toMatchObject({ analyzing: false, analyzingProvider: null })
  })
  it('a note beside a completed analysis is kept (and reloaded) until the next one starts (round 1)', () => {
    const s = new SentinelState(dir)
    s.setAnalyzing(false, null, null, 'Some notes were cut.')
    expect(s.snapshot()).toMatchObject({ analyzing: false, lastAnalysisError: null, lastAnalysisNote: 'Some notes were cut.' })
    expect(new SentinelState(dir).snapshot().lastAnalysisNote).toBe('Some notes were cut.')
    s.setAnalyzing(true, null, 'codex', 'ignored while running')
    expect(s.snapshot().lastAnalysisNote).toBeNull()
    s.setAnalyzing(false)
    expect(s.snapshot().lastAnalysisNote).toBeNull()
  })
})
