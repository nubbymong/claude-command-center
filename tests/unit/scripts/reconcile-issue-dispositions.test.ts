import { describe, it, expect } from 'vitest'

// The script guards main() behind `require.main === module`, so require()-ing it
// imports only the pure helpers — no gh, no network.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const rec = require('../../../scripts/reconcile-issue-dispositions.js') as {
  activeLineFromVersion: (v: string) => string | null
  decide: (input: { labels?: string[]; activeLine?: string | null }) => { add: string[]; flags: string[] }
  parseArgv: (argv: string[]) => { dryRun: boolean; issue?: number; repo?: string; activeLine?: string }
}

const { activeLineFromVersion, decide, parseArgv } = rec
const ACTIVE = 'release-2.1'
const d = (labels: string[], activeLine: string | null = ACTIVE) => decide({ labels, activeLine })

describe('activeLineFromVersion', () => {
  it('parses major.minor off a prerelease version', () => {
    expect(activeLineFromVersion('2.1.0-beta.17')).toBe('release-2.1')
  })
  it('keeps a multi-digit minor', () => {
    expect(activeLineFromVersion('2.10.3')).toBe('release-2.10')
  })
  it('returns null when unparseable', () => {
    expect(activeLineFromVersion('')).toBeNull()
    expect(activeLineFromVersion('nope')).toBeNull()
  })
})

describe('decide — no-limbo (not committed)', () => {
  it('adds triage to an issue with no disposition at all', () => {
    expect(d([])).toEqual({ add: ['triage'], flags: [] })
    expect(d(['enhancement', 'ux'])).toEqual({ add: ['triage'], flags: [] })
  })
  it('leaves a backlog issue alone', () => {
    expect(d(['backlog', 'enhancement'])).toEqual({ add: [], flags: [] })
  })
  it('leaves a triage issue alone', () => {
    expect(d(['triage'])).toEqual({ add: [], flags: [] })
  })
  it('leaves a wontfix / duplicate / excluded issue alone', () => {
    expect(d(['wontfix'])).toEqual({ add: [], flags: [] })
    expect(d(['duplicate'])).toEqual({ add: [], flags: [] })
    expect(d(['excluded'])).toEqual({ add: [], flags: [] })
  })
  it('leaves a scheduled (release-tagged, not committed) issue alone', () => {
    expect(d(['release-2.1', 'bug'])).toEqual({ add: [], flags: [] })
  })
})

describe('decide — committed-state requires a release line', () => {
  it('auto-adds the active line to an in-beta issue with no release line', () => {
    expect(d(['in-beta', 'bug'])).toEqual({ add: ['release-2.1'], flags: [] })
  })
  it('leaves an in-beta issue that already has a release line', () => {
    expect(d(['in-beta', 'release-2.1'])).toEqual({ add: [], flags: [] })
  })
  it('flags a claimed/in-progress/done issue with no release line — never guesses', () => {
    expect(d(['loop-in-progress'])).toEqual({ add: [], flags: [expect.stringContaining('no release line')] })
    expect(d(['loop-claimed'])).toEqual({ add: [], flags: [expect.stringContaining('no release line')] })
    expect(d(['loop-done'])).toEqual({ add: [], flags: [expect.stringContaining('no release line')] })
  })
  it('leaves a committed issue that already has its release line', () => {
    expect(d(['loop-done', 'release-2.1'])).toEqual({ add: [], flags: [] })
  })
  it('does NOT auto-add a line when active line is unknown — flags instead', () => {
    expect(d(['in-beta'], null)).toEqual({ add: [], flags: [expect.stringContaining('unknown')] })
  })
})

describe('decide — conflicts are flagged, never auto-fixed', () => {
  it('flags two release lines and adds nothing', () => {
    const r = d(['release-2.1', 'release-2.2'])
    expect(r.add).toEqual([])
    expect(r.flags[0]).toContain('multiple dispositions')
  })
  it('flags a release line together with backlog/triage/wontfix', () => {
    expect(d(['release-2.1', 'backlog']).flags[0]).toContain('multiple dispositions')
    expect(d(['triage', 'backlog']).flags[0]).toContain('multiple dispositions')
  })
  it('flags an in-beta issue marked backlog and does NOT add a release line', () => {
    const r = d(['in-beta', 'backlog'])
    expect(r.add).toEqual([])
    expect(r.flags[0]).toContain('needs a release line')
  })
})

describe('decide — deferred release lines', () => {
  it('keeps a later-line release-2.2 on a NON-committed issue while active is 2.1', () => {
    expect(d(['release-2.2', 'enhancement'])).toEqual({ add: [], flags: [] })
  })
  it('flags in-beta + a deferred line (invariant: in-beta must be on the active line)', () => {
    const r = d(['in-beta', 'release-2.2'])
    expect(r.add).toEqual([])
    expect(r.flags[0]).toContain('active line')
  })
  it('allows a loop-* committed issue to target a future line (only in-beta is pinned to active)', () => {
    expect(d(['loop-in-progress', 'release-2.2'])).toEqual({ add: [], flags: [] })
  })
})

describe('parseArgv', () => {
  it('reads flags', () => {
    expect(parseArgv(['--dry-run', '--issue', '123', '--repo', 'o/n', '--active-line', 'release-2.1']))
      .toEqual({ dryRun: true, issue: 123, repo: 'o/n', activeLine: 'release-2.1' })
  })
})
