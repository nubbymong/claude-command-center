// Unit tests for the pure parser/classifier in scripts/verify-release.mjs.
// Fixtures are real report() lines captured from the live SSH matrix, so the
// gate's PASS/WARN/FAIL logic is pinned without needing the fleet.
import { describe, it, expect } from 'vitest'
import {
  stripAnsi,
  parseBuckets,
  parseLiveMatrixOutput,
  classifyCombo,
  summarizeGate,
} from '../../scripts/verify-release.mjs'

// A realistic slice of the pack's stdout: a full PASS (Fable present, live.co.uk),
// a WARN (statusline+account but no buckets — a host whose token is empty), and a
// FAIL (no statusline update, no account). ANSI codes included to exercise strip.
const SAMPLE = [
  '\x1b[22m\x1b[39mT7 windows payload: account=nicholas@live.co.uk buckets=5h:0%,Weekly:100%,Fable:93% 5h=0 wk=100',
  'T7 windows: updates=1 sids=["lv7abc"] wrapped=false states=["claude-running"] paneLen=30057',
  'T1 key+tmux fresh payload: account=nicholas.moger@icloud.com buckets=- 5h=- wk=-',
  'T1 key+tmux fresh: updates=1 sids=["lv1abc"] wrapped=true states=["claude-running"] paneLen=21000',
  'T99 dead payload: account=- buckets=- 5h=- wk=-',
  'T99 dead: updates=0 sids=[] wrapped=false states=[] paneLen=0',
  ' Tests  1 failed | 11 passed (12)',
].join('\n')

describe('stripAnsi + parseBuckets', () => {
  it('strips ANSI SGR codes', () => {
    expect(stripAnsi('\x1b[22m\x1b[39mhi')).toBe('hi')
  })
  it('parses a bucket list into {label,percent}', () => {
    expect(parseBuckets('5h:0%,Weekly:100%,Fable:93%')).toEqual([
      { label: '5h', percent: 0 },
      { label: 'Weekly', percent: 100 },
      { label: 'Fable', percent: 93 },
    ])
  })
  it('treats "-" and empty as no buckets', () => {
    expect(parseBuckets('-')).toEqual([])
    expect(parseBuckets('')).toEqual([])
  })
})

describe('parseLiveMatrixOutput', () => {
  it('pairs payload + status lines per combo and reads the vitest tally', () => {
    const { combos, summary } = parseLiveMatrixOutput(SAMPLE)
    expect(combos).toHaveLength(3)
    const win = combos.find((c) => c.combo === 'T7 windows')!
    expect(win.account).toBe('nicholas@live.co.uk')
    expect(win.updates).toBe(1)
    expect(win.wrapped).toBe(false)
    expect(win.buckets.map((b) => b.label)).toContain('Fable')
    const t1 = combos.find((c) => c.combo === 'T1 key+tmux fresh')!
    expect(t1.account).toBe('nicholas.moger@icloud.com')
    expect(t1.buckets).toEqual([])
    const dead = combos.find((c) => c.combo === 'T99 dead')!
    expect(dead.account).toBe('') // '-' normalised to empty
    expect(dead.updates).toBe(0)
    expect(summary).toEqual({ failed: 1, passed: 11 })
  })

  it('reads a clean tally with no failures', () => {
    const { summary } = parseLiveMatrixOutput('Tests  10 passed (10)')
    expect(summary).toEqual({ failed: 0, passed: 10 })
  })
})

describe('classifyCombo', () => {
  it('PASS when statusline + account + a bucket', () => {
    expect(classifyCombo({ updates: 1, account: 'a@b.co', buckets: [{ label: 'Fable', percent: 9 }] })).toBe('PASS')
  })
  it('WARN when statusline + account but no buckets (host auth-state)', () => {
    expect(classifyCombo({ updates: 1, account: 'a@b.co', buckets: [] })).toBe('WARN')
  })
  it('FAIL when no statusline update', () => {
    expect(classifyCombo({ updates: 0, account: 'a@b.co', buckets: [] })).toBe('FAIL')
  })
  it('FAIL when no account', () => {
    expect(classifyCombo({ updates: 1, account: '', buckets: [] })).toBe('FAIL')
  })
})

describe('summarizeGate', () => {
  it('fails the gate on a FAIL row or a vitest failure; WARN does not fail it', () => {
    const parsed = parseLiveMatrixOutput(SAMPLE)
    const gate = summarizeGate(parsed)
    expect(gate.ok).toBe(false) // has a FAIL row + vitest 1 failed
    expect(gate.fails).toHaveLength(1)
    expect(gate.warns).toHaveLength(1)
    expect(gate.vitestFailed).toBe(1)
  })

  it('passes the gate when all rows are PASS/WARN and vitest is green', () => {
    const clean = [
      'T7 windows payload: account=nicholas@live.co.uk buckets=Fable:93% 5h=0 wk=100',
      'T7 windows: updates=1 sids=["x"] wrapped=false states=[] paneLen=1',
      'T4 pi payload: account=nicholas@live.co.uk buckets=5h:0%,Weekly:50% 5h=0 wk=50',
      'T4 pi: updates=2 sids=["y"] wrapped=true states=[] paneLen=1',
      'T6 mac payload: account=nicholas@live.co.uk buckets=- 5h=- wk=-',
      'T6 mac: updates=1 sids=["z"] wrapped=false states=[] paneLen=1',
      'Tests  3 passed (3)',
    ].join('\n')
    const gate = summarizeGate(parseLiveMatrixOutput(clean))
    expect(gate.ok).toBe(true)
    expect(gate.fails).toHaveLength(0)
    expect(gate.warns).toHaveLength(1) // mac: no buckets
    expect(gate.rows.filter((r) => r.verdict === 'PASS')).toHaveLength(2)
  })

  it('is not OK when nothing parsed (spawn/config error)', () => {
    const gate = summarizeGate(parseLiveMatrixOutput('random noise, no report lines'))
    expect(gate.ok).toBe(false)
    expect(gate.rows).toHaveLength(0)
  })
})
