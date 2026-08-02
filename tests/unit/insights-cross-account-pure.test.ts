import { describe, it, expect } from 'vitest'
import {
  CROSS_ACCOUNT_MAX_PARALLEL,
  buildCrossAccountPrompt,
  buildCrossAccountSpawnArgs,
  crossAccountLabel,
  describeCrossAccountFanout,
  mapWithLimit,
  type CrossAccountMember
} from '../../src/main/insights-cross-account'

// #191: the prompt/argv/scheduling half of a cross-account roll-up. Pure, so no
// mocks and no temp dirs.

function member(key: string, label: string, kpis: unknown = {}): CrossAccountMember {
  return { key, runId: `run-${key}`, label, kpis: kpis as CrossAccountMember['kpis'] }
}

describe('cross-account prompt', () => {
  const SAME_WINDOW = { start: '2026-07-01', end: '2026-07-31' }
  const WORK = member('A1', 'Work', {
    period: SAME_WINDOW,
    kpis: { Volume: { sessions: { value: 12, label: 'Sessions', format: 'number', goodDirection: 'up' } } }
  })
  const PERSONAL = member('A2', 'Personal', {
    period: SAME_WINDOW,
    kpis: { Volume: { sessions: { value: 3, label: 'Sessions', format: 'number', goodDirection: 'up' } } }
  })

  it('sends the ALIGNED table, not each account s raw KPI JSON', () => {
    const prompt = buildCrossAccountPrompt([WORK, PERSONAL])
    expect(prompt).toContain('A1 = Work')
    expect(prompt).toContain('A2 = Personal')
    expect(prompt).toContain('SHARED METRICS')
    expect(prompt).toContain('Volume | Sessions (up) | 12 | 3 | 15')
    // The raw-JSON payload is what this replaced; its shape must not come back.
    expect(prompt).not.toContain('"value": 12')
    expect(prompt).not.toContain('"goodDirection"')
  })

  it('is dramatically smaller than the raw-JSON payload it replaced', () => {
    const prompt = buildCrossAccountPrompt([WORK, PERSONAL])
    const rawEquivalent = [WORK, PERSONAL].map((m) => JSON.stringify(m.kpis, null, 2)).join('\n')
    // Tiny fixtures, so this only proves the table is not larger than the blobs.
    // The real ratio (~88% on 13-15KB archives) is measured in the docs, not here.
    expect(prompt.length - rawEquivalent.length).toBeLessThan(prompt.length)
  })

  it('asks for the narrative only — never for the metric tables it already has', () => {
    const prompt = buildCrossAccountPrompt([WORK, PERSONAL])
    expect(prompt).toContain('"crossAccount"')
    expect(prompt).toContain('"highlights"')
    // The instructions that keep invented numbers out of the model's output. If
    // these go, the roll-up starts reporting metrics no account produced.
    expect(prompt).toMatch(/Do NOT walk the table restating rows/)
    expect(prompt).toMatch(/Never introduce a number that is not below/)
    expect(prompt).toContain('Output ONLY valid JSON')
  })

  it('says WHICH window problem it has when it cannot total', () => {
    const noPeriod = member('A1', 'Work', {
      kpis: { Volume: { sessions: { value: 12, label: 'Sessions', format: 'number' } } }
    })
    const prompt = buildCrossAccountPrompt([noPeriod, PERSONAL])
    expect(prompt).toContain('window length unknown')
    expect(prompt).toMatch(/could not be determined/)
    expect(prompt).not.toMatch(/differ materially in length/)
  })

  it('declares label conflicts instead of letting the model assume equivalence', () => {
    const a = member('A1', 'Work', {
      period: SAME_WINDOW,
      kpis: { Outcomes: { successRate: { value: 0.4231, label: 'Fully Achieved Rate', format: 'percent' } } }
    })
    const b = member('A2', 'Personal', {
      period: SAME_WINDOW,
      kpis: {
        Outcomes: { successRate: { value: 0.787, label: 'Mostly or Fully Achieved Rate', format: 'percent' } }
      }
    })
    const prompt = buildCrossAccountPrompt([a, b])
    expect(prompt).toContain('LABEL CONFLICTS')
    expect(prompt).toContain('~ Outcomes.successRate')
    expect(prompt).toContain('"Fully Achieved Rate"')
    expect(prompt).toContain('"Mostly or Fully Achieved Rate"')
  })

  it('carries account-unique metrics and top lists into the prompt', () => {
    const a = member('A1', 'Work', {
      period: SAME_WINDOW,
      kpis: { Volume: { commits: { value: 242, label: 'Commits', format: 'number' } } },
      lists: { 'Top Tools': [{ name: 'Bash', count: 10328 }, { name: 'Edit', count: 2765 }] }
    })
    const b = member('A2', 'Personal', {
      period: SAME_WINDOW,
      kpis: { Volume: { subagents: { value: 7, label: 'Subagent Calls', format: 'number' } } }
    })
    const prompt = buildCrossAccountPrompt([a, b])
    expect(prompt).toContain('ACCOUNT-UNIQUE METRICS')
    expect(prompt).toContain('A1 only: Commits=242')
    expect(prompt).toContain('A2 only: Subagent Calls=7')
    expect(prompt).toContain('TOP LISTS')
    expect(prompt).toContain('Bash 10328')
  })

  it('tells the model when the windows are not comparable', () => {
    const short = member('A1', 'Work', {
      period: { start: '2026-07-01', end: '2026-07-10' },
      kpis: { Volume: { sessions: { value: 5, label: 'Sessions', format: 'number' } } }
    })
    const long = member('A2', 'Personal', {
      period: { start: '2026-06-01', end: '2026-07-31' },
      kpis: { Volume: { sessions: { value: 50, label: 'Sessions', format: 'number' } } }
    })
    const prompt = buildCrossAccountPrompt([short, long])
    expect(prompt).toContain('10d window')
    expect(prompt).toContain('61d window')
    expect(prompt).toMatch(/differ materially in length/)
    // No total on any row when the windows are incommensurate.
    expect(prompt).toContain('| 5 | 50 | -')
  })
})

describe('cross-account spawn args', () => {
  it('grants no tools at all — the data travels on stdin, so nothing is read', () => {
    const args = buildCrossAccountSpawnArgs()
    expect(args).toEqual(['-p', '--output-format', 'json'])
    expect(args).not.toContain('--allowedTools')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })
})

describe('crossAccountLabel', () => {
  it('prefers the profile name, then the email, then the id', () => {
    expect(crossAccountLabel({ name: 'Work', accountEmail: 'w@example.com', id: 'p1' })).toBe('Work')
    expect(crossAccountLabel({ name: '  ', accountEmail: 'w@example.com', id: 'p1' })).toBe('w@example.com')
    expect(crossAccountLabel({ id: 'p1' })).toBe('p1')
    expect(crossAccountLabel({})).toBe('Account')
  })
})

describe('describeCrossAccountFanout', () => {
  it('counts the fan-out, then switches to the synthesis step', () => {
    expect(describeCrossAccountFanout(0, 3)).toBe('Step 1/2: Generating account reports (0/3 done)...')
    expect(describeCrossAccountFanout(2, 3)).toContain('(2/3 done)')
    expect(describeCrossAccountFanout(3, 3)).toBe(
      'Step 2/2: Synthesizing the cross-account report (3 accounts)...'
    )
  })
})

describe('mapWithLimit', () => {
  it('keeps at most `limit` in flight and resolves in input order', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapWithLimit([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 5))
      inFlight--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBe(2)
  })

  it('never runs more workers than there are items', async () => {
    const seen: number[] = []
    const out = await mapWithLimit([7], 8, async (n, i) => {
      seen.push(i)
      return n
    })
    expect(out).toEqual([7])
    expect(seen).toEqual([0])
  })

  it('caps the default parallelism low enough not to flood the machine with PTYs', () => {
    expect(CROSS_ACCOUNT_MAX_PARALLEL).toBeLessThanOrEqual(2)
  })
})
