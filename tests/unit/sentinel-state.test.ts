import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os'
import { SentinelState, UNVERIFIED_VERSIONS_KEPT } from '../../src/main/sentinel/sentinel-state'

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-sen-')) })
// Only the folder this file made: its own prefix, directly in the temp folder.
afterEach(() => { if (path.dirname(dir) === os.tmpdir() && path.basename(dir).startsWith('ccc-sen-')) fs.rmSync(dir, { recursive: true, force: true }) })

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
  // Fixer 11 (ADR-009 R2-1): a recorded version that is not a string (a
  // damaged or hand-edited file) loads as none, so the next start takes the
  // installed version as its baseline again instead of failing for good.
  for (const [what, bad] of [['a number', 155], ['an object', { v: '0.155.1' }]] as const) {
    it(`a recorded version that is ${what} loads as none, for both providers`, () => {
      fs.mkdirSync(path.join(dir, 'sentinel'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'sentinel', 'sentinel-state.json'), JSON.stringify({
        lastSeenCcVersion: bad, lastSeenCodexVersion: bad, highestCheckedCcVersion: bad, highestCheckedCodexVersion: bad,
        analyzing: false, lastAnalysisAt: null, lastAnalysisError: null, findings: [],
      }))
      const s = new SentinelState(dir)
      expect(s.snapshot()).toMatchObject({ lastSeenCcVersion: null, lastSeenCodexVersion: null, highestCheckedCcVersion: null, highestCheckedCodexVersion: null })
      expect([s.highestChecked('claude'), s.highestChecked('codex')]).toEqual([null, null])
    })
  }

  // Fixer 11 (gate 3 F10, ADR-009 D1 round 2): the highest version checked,
  // which the start-up rule and the cap go by, is kept apart from the version
  // the panel names (lastSeen*). A check of a lower version (a downgrade seen
  // at start, an analysis) moves only the one shown; fixer 12: only a Re-run's
  // record, the user's own act, sets it to its version (below).
  it('the highest version checked follows a higher version and never goes down; the version shown follows each check', () => {
    const s = new SentinelState(dir)
    expect([s.highestChecked('claude'), s.highestChecked('codex')]).toEqual([null, null])
    s.setLastSeenCodexVersion('0.156.0')
    s.setLastSeenCcVersion('2.1.300')
    s.setLastSeenCodexVersion('0.155.1')
    s.setLastSeenCcVersion('2.1.299')
    expect(s.snapshot()).toMatchObject({ lastSeenCodexVersion: '0.155.1', highestCheckedCodexVersion: '0.156.0', lastSeenCcVersion: '2.1.299', highestCheckedCcVersion: '2.1.300' })
    expect([s.highestChecked('claude'), s.highestChecked('codex')]).toEqual(['2.1.300', '0.156.0'])
    s.setLastSeenCodexVersion('0.157.0')
    expect(s.highestChecked('codex')).toBe('0.157.0')
    expect(new SentinelState(dir).snapshot()).toMatchObject({ lastSeenCodexVersion: '0.157.0', highestCheckedCodexVersion: '0.157.0', lastSeenCcVersion: '2.1.299', highestCheckedCcVersion: '2.1.300' })
  })

  // Fixer 12 (ADR-009 R3-1): a highest version stuck far ahead (a hand-edited
  // file, a prerelease once installed) would block every real update at
  // start; a Re-run's record sets it to the version the Re-run checked.
  it('a Re-run\'s record sets the highest version checked to its version, down as well as up, for both providers', () => {
    const s = new SentinelState(dir)
    s.setLastSeenCodexVersion('9999.0.0')
    s.setLastSeenCcVersion('2.9.0-alpha.1')
    s.setLastSeenCodexVersion('0.156.0', { rerun: true })
    s.setLastSeenCcVersion('2.1.300', { rerun: true })
    expect([s.highestChecked('claude'), s.highestChecked('codex')]).toEqual(['2.1.300', '0.156.0'])
    s.setLastSeenCodexVersion('0.157.0', { rerun: true })
    expect(new SentinelState(dir).snapshot()).toMatchObject({ lastSeenCodexVersion: '0.157.0', highestCheckedCodexVersion: '0.157.0', highestCheckedCcVersion: '2.1.300' })
  })

  it('a state file from before fixer 11 (no highest version checked) takes its recorded version as the highest checked', () => {
    fs.mkdirSync(path.join(dir, 'sentinel'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'sentinel', 'sentinel-state.json'), JSON.stringify({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.155.1', analyzing: false, lastAnalysisAt: null, lastAnalysisError: null, findings: [] }))
    const s = new SentinelState(dir)
    expect([s.highestChecked('claude'), s.highestChecked('codex')]).toEqual(['2.1.300', '0.155.1'])
    expect(s.snapshot()).toMatchObject({ lastSeenCcVersion: '2.1.300', lastSeenCodexVersion: '0.155.1' })
    // A file whose shown version is above its highest (edited by hand): the higher one counts.
    fs.writeFileSync(path.join(dir, 'sentinel', 'sentinel-state.json'), JSON.stringify({ lastSeenCodexVersion: '0.157.0', highestCheckedCodexVersion: '0.156.0', lastSeenCcVersion: null, analyzing: false, lastAnalysisAt: null, lastAnalysisError: null, findings: [] }))
    expect(new SentinelState(dir).highestChecked('codex')).toBe('0.157.0')
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

// P3.9 round 2: an analysis finding is known by its version and its quote.
// One kept before (under an older id, or worded differently) stands for a
// later one with the same quote, so a dismissal stays; another quote, or
// another version, is a finding of its own.
describe('SentinelState: analysis findings by version and quote (round 2)', () => {
  const QUOTE = '- Hooks now require matcher-wrapped arrays in settings.'
  const cc = (id: string, evidence = QUOTE, title = 'Hooks schema changed') => ({ id, kind: 'compat' as const, severity: 'high' as const, title, evidence, status: 'open' as const, createdAt: 1 })
  it('a finding dismissed under the older id keeps its dismissal when the same quote comes back under the new one', () => {
    const s = new SentinelState(dir)
    s.upsertFinding(cc('cc:2.1.0:0'))
    s.setStatus('cc:2.1.0:0', 'dismissed')
    s.upsertFinding(cc('cc:2.1.0:0123456789ab', '"' + QUOTE + '"', 'Worded otherwise'))
    expect(s.snapshot().findings.map((f) => [f.id, f.status])).toEqual([['cc:2.1.0:0', 'dismissed']])
    s.upsertFinding(cc('codex-update:0.155.1:0123456789ab'))
    s.upsertFinding(cc('cc:2.1.1:0123456789ab'))
    s.upsertFinding(cc('cc:2.1.0:ba9876543210', '- Another line of the changelog entirely.'))
    expect(s.snapshot().findings.map((f) => f.id)).toEqual(['cc:2.1.0:0', 'codex-update:0.155.1:0123456789ab', 'cc:2.1.1:0123456789ab', 'cc:2.1.0:ba9876543210'])
    // Only analysis findings are matched this way.
    s.upsertFinding({ ...finding, id: 'obs:model:claude-x-2', evidence: QUOTE })
    expect(s.snapshot().findings.some((f) => f.id === 'obs:model:claude-x-2')).toBe(true)
  })
})

// P3.9 round 3 (R3D1): a finding dismissed before its quote was stored
// redacted keeps its dismissal when the same passage comes back redacted.
describe('SentinelState: a dismissal made before quotes were redacted (round 3)', () => {
  it('the new, redacted finding of the same passage stays out', async () => {
    const { parseAnalysisOutput } = await import('../../src/main/sentinel/sentinel-analysis')
    const line = '- Fixed a bug where the token sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE0000 refresh failed on Windows'
    const s = new SentinelState(dir)
    s.upsertFinding({ id: 'cc:2.1.0:0', kind: 'compat', severity: 'high', title: 'old', evidence: line, status: 'open', createdAt: 1 })
    s.setStatus('cc:2.1.0:0', 'dismissed')
    const fresh = parseAnalysisOutput(JSON.stringify({ breakingChanges: [{ title: 'Token refresh', evidence: line, surface: 4, whatBreaks: 'Accounts break.' }] }), '2.0.0', '2.1.0', 'claude', '## 2.1.0\n' + line)!
    expect(fresh).toHaveLength(1)
    expect(fresh[0].evidence).not.toContain('FAKEFAKE')
    s.upsertFinding(fresh[0])
    expect(s.snapshot().findings.map((f) => [f.id, f.status])).toEqual([['cc:2.1.0:0', 'dismissed']])
  })
})

// P3.9 round 4: the counts of analyses whose findings could not be matched,
// per provider and version. Fixer 10 (the cap for versions installed in
// turn): counting one version drops no other version's count (bar the file's
// bound), and recording a version drops that provider's counts at or below it
// (a start no longer analyses those), keeping a higher version's.
describe('SentinelState: unmatched-analysis counts (round 4, fixer 10)', () => {
  it('counts per version, keeps every other version\'s count, and recording a version forgets that provider\'s counts at or below it', () => {
    const s = new SentinelState(dir)
    expect(s.countUnverified('codex:0.155.1')).toBe(1)
    expect(s.countUnverified('codex:0.155.1')).toBe(2)
    expect(s.countUnverified('claude:2.1.300')).toBe(1)
    expect(s.countUnverified('codex:0.156.0')).toBe(1)
    expect(s.snapshot().unverifiedTries).toEqual({ 'codex:0.155.1': 2, 'claude:2.1.300': 1, 'codex:0.156.0': 1 })
    expect(new SentinelState(dir).snapshot().unverifiedTries).toEqual({ 'codex:0.155.1': 2, 'claude:2.1.300': 1, 'codex:0.156.0': 1 })
    s.clearUnverified('codex:0.157.0')
    expect(s.snapshot().unverifiedTries).toEqual({ 'claude:2.1.300': 1 })
    expect(new SentinelState(dir).snapshot().unverifiedTries).toEqual({ 'claude:2.1.300': 1 })
  })

  // Two versions taken in turn (two installs, or two machines sharing one
  // resources folder) never reset each other: each reaches the cap.
  it('two versions taken in turn: each keeps its count and reaches three', () => {
    const s = new SentinelState(dir)
    expect(s.countUnverified('codex:0.156.0')).toBe(1)
    expect(s.countUnverified('codex:0.155.1')).toBe(1)
    expect(s.countUnverified('codex:0.156.0')).toBe(2)
    expect(s.countUnverified('codex:0.155.1')).toBe(2)
    expect(s.snapshot().unverifiedTries).toEqual({ 'codex:0.156.0': 2, 'codex:0.155.1': 2 })
    expect(s.countUnverified('codex:0.155.1')).toBe(3)
    expect(s.countUnverified('codex:0.156.0')).toBe(3)
  })

  it('recording a version keeps a higher version\'s count (it may still be installed in turn) and drops a lower one\'s', () => {
    const s = new SentinelState(dir)
    s.countUnverified('codex:0.155.0')
    s.countUnverified('codex:0.155.1')
    s.countUnverified('codex:0.155.1')
    s.countUnverified('codex:0.156.0')
    s.countUnverified('codex:0.156.0')
    s.countUnverified('claude:2.1.299')
    s.clearUnverified('codex:0.155.1')
    expect(s.snapshot().unverifiedTries).toEqual({ 'codex:0.156.0': 2, 'claude:2.1.299': 1 })
    expect(s.countUnverified('codex:0.156.0')).toBe(3)
    // Another provider's count is never touched by this one's record.
    s.clearUnverified('claude:2.1.298')
    expect(s.snapshot().unverifiedTries).toEqual({ 'codex:0.156.0': 3, 'claude:2.1.299': 1 })
  })

  // Fixer 11 (gate 3 F13): what the code keeps, said exactly: the count made
  // now and the provider's other counts of its highest versions, at most
  // UNVERIFIED_VERSIONS_KEPT in all.
  it(`the file keeps a provider's count made now and the counts of its ${UNVERIFIED_VERSIONS_KEPT - 1} highest other versions`, () => {
    const s = new SentinelState(dir)
    s.countUnverified('claude:2.1.300')
    const versions = Array.from({ length: UNVERIFIED_VERSIONS_KEPT + 2 }, (_, i) => `0.${150 + i}.0`)
    for (const v of versions) s.countUnverified(`codex:${v}`)
    const codexKeys = () => Object.keys(s.snapshot().unverifiedTries ?? {}).filter((k) => k.startsWith('codex:')).sort()
    expect(codexKeys()).toEqual(versions.slice(2).map((v) => `codex:${v}`).sort())
    expect(s.snapshot().unverifiedTries?.['claude:2.1.300']).toBe(1)
    // A lower version counted now is kept; the lowest of the others goes.
    expect(s.countUnverified('codex:0.140.0')).toBe(1)
    expect(codexKeys()).toEqual(['codex:0.140.0', ...versions.slice(3).map((v) => `codex:${v}`)].sort())
  })
})
