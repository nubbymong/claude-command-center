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
  it('sends each account under its opaque key with its KPI JSON verbatim', () => {
    const prompt = buildCrossAccountPrompt([
      member('A1', 'Work', { kpis: { Volume: { sessions: { value: 12, label: 'Sessions' } } } }),
      member('A2', 'Personal', { kpis: { Volume: { sessions: { value: 3, label: 'Sessions' } } } })
    ])
    expect(prompt).toContain('key: A1 | label: Work')
    expect(prompt).toContain('key: A2 | label: Personal')
    expect(prompt).toContain('"value": 12')
    expect(prompt).toContain('"value": 3')
  })

  it('asks for the narrative only — never for the metric tables it already has', () => {
    const prompt = buildCrossAccountPrompt([member('A1', 'Work'), member('A2', 'Personal')])
    expect(prompt).toContain('"crossAccount"')
    expect(prompt).toContain('"highlights"')
    // The instruction that keeps numbers out of the model's output. If this line
    // goes, the roll-up starts reporting metrics no account produced.
    expect(prompt).toMatch(/Do NOT restate the full metric tables/)
    expect(prompt).toContain('Output ONLY valid JSON')
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
