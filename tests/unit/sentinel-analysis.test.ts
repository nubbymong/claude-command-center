import { describe, it, expect } from 'vitest'
import { buildAnalysisPrompt, parseAnalysisOutput, runAnalysis, analysisFailureMessage } from '../../src/main/sentinel/sentinel-analysis'

const goodJson = JSON.stringify({ breakingChanges: [{
  title: 'Hooks schema changed',
  evidence: '## 2.1.0 - Hooks now require matcher-wrapped arrays',
  surface: 3,
  whatBreaks: 'CCC statusline hook may not register under CC 2.1.0',
}] })

describe('buildAnalysisPrompt', () => {
  it('is lean (well under the ~7KB claude -p stdin hang threshold) and names only the 4 surfaces', () => {
    const p = buildAnalysisPrompt('## 2.1.0 - some change')
    expect(p.length).toBeLessThan(3000)
    expect(p).toContain('Session launch')
    expect(p).toContain('Terminal embedding')
    expect(p).toContain('Statusline hook')
    expect(p).toContain('Config & account files')
    // No assumption manifest / registry bulk anymore.
    expect(p).not.toMatch(/assumption manifest/i)
    expect(p).not.toMatch(/model registry/i)
  })
})

describe('parseAnalysisOutput', () => {
  it('valid JSON -> high-severity compat findings with generated ids/status', () => {
    const f = parseAnalysisOutput(goodJson, '2.0.13', '2.1.0')!
    expect(f[0].id).toBe('cc:2.1.0:0')
    expect(f[0].status).toBe('open')
    expect(f[0].ccVersionFrom).toBe('2.0.13')
    expect(f[0].kind).toBe('compat')
    expect(f[0].severity).toBe('high')
    expect(f[0].surface).toBe(3)
    expect(f[0].badgeText).toBe('CCC statusline hook may not register under CC 2.1.0') // whatBreaks
  })
  it('claude -p --output-format json envelope: payload inside .result', () => {
    const env = JSON.stringify({ type: 'result', result: goodJson })
    expect(parseAnalysisOutput(env, '2.0.13', '2.1.0')).toHaveLength(1)
  })
  it('markdown-fenced payload is unwrapped', () => {
    const fenced = '```json\n' + goodJson + '\n```'
    expect(parseAnalysisOutput(fenced, '2.0.13', '2.1.0')).toHaveLength(1)
  })
  it('empty breakingChanges -> [] (all clear), not null', () => {
    const f = parseAnalysisOutput(JSON.stringify({ breakingChanges: [] }), '2.0.13', '2.1.0')
    expect(f).not.toBeNull()
    expect(f).toHaveLength(0)
  })
  it('malformed -> null, never throws', () => {
    expect(parseAnalysisOutput('not json', '2.0.13', '2.1.0')).toBeNull()
    expect(parseAnalysisOutput(JSON.stringify({ breakingChanges: [{ bad: true }] }), '1', '2')).toBeNull()
    // out-of-range surface is rejected
    expect(parseAnalysisOutput(JSON.stringify({ breakingChanges: [{ title: 't', evidence: 'e', surface: 9, whatBreaks: 'w' }] }), '1', '2')).toBeNull()
  })
})

describe('runAnalysis', () => {
  it('retries once on malformed output, then reports failure', async () => {
    let calls = 0
    const runner = async () => { calls++; return { code: 0, stdout: 'garbage', stderr: '' } }
    const r = await runAnalysis({ runner, changelog: 'x', from: '1.0.0', to: '1.0.1' })
    expect(calls).toBe(2)
    expect(r.ok).toBe(false)
  })
  it('passes --model sonnet, -p, --output-format json and the prompt via stdin', async () => {
    let seenArgs: string[] = []; let seenStdin = ''
    const runner = async (args: string[], _t: number, stdin?: string) => {
      seenArgs = args; seenStdin = stdin ?? ''; return { code: 0, stdout: goodJson, stderr: '' }
    }
    const r = await runAnalysis({ runner, changelog: 'CHANGELOG-MARKER', from: '1.0.0', to: '1.0.1' })
    expect(r.ok).toBe(true)
    expect(seenArgs).toContain('--model'); expect(seenArgs).toContain('sonnet')
    expect(seenArgs).toContain('-p'); expect(seenArgs).toContain('--output-format')
    expect(seenStdin).toContain('CHANGELOG-MARKER')
  })
  it('non-zero exit on both attempts -> failure with a calm, degraded message', async () => {
    const runner = async () => ({ code: 1, stdout: '', stderr: 'not logged in' })
    const r = await runAnalysis({ runner, changelog: 'x', from: '1', to: '2' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/deterministic checks still ran/i)
  })
  it('timeout degrades to a calm message that never leaks raw stderr', async () => {
    const runner = async () => ({ code: 1, stdout: '', stderr: '\nTimed out after 180s' })
    const r = await runAnalysis({ runner, changelog: 'x', from: '1', to: '2' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).not.toMatch(/Timed out after/i)
      expect(r.error).not.toContain('180')
    }
  })
})

describe('analysisFailureMessage', () => {
  it('timeout -> calm wording, hints at rate limit, points to Re-run, no raw stderr', () => {
    const m = analysisFailureMessage('\nTimed out after 180s')
    expect(m).toMatch(/in time/i)
    expect(m).toMatch(/rate limited/i)
    expect(m).toMatch(/Re-run/)
    expect(m).not.toMatch(/Timed out after/i)
  })
  it('other failure -> calm generic wording', () => {
    const m = analysisFailureMessage('not logged in')
    expect(m).toMatch(/could not complete/i)
    expect(m).toMatch(/deterministic checks still ran/i)
    expect(m).not.toContain('not logged in')
  })
})
