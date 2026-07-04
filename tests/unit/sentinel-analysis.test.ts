import { describe, it, expect } from 'vitest'
import { buildAnalysisPrompt, parseAnalysisOutput, runAnalysis, analysisFailureMessage } from '../../src/main/sentinel/sentinel-analysis'

const goodJson = JSON.stringify({ findings: [{
  kind: 'compat', severity: 'high', title: 'Hooks schema changed',
  evidence: '## 2.1.0 - Hooks now require matcher-wrapped arrays',
  affectedFeature: 'logs', badgeText: 'Hooks may not register under CC 2.1.0',
}] })

describe('parseAnalysisOutput', () => {
  it('valid JSON -> findings with generated ids/status', () => {
    const f = parseAnalysisOutput(goodJson, '2.0.13', '2.1.0')!
    expect(f[0].id).toBe('cc:2.1.0:0')
    expect(f[0].status).toBe('open')
    expect(f[0].ccVersionFrom).toBe('2.0.13')
  })
  it('claude -p --output-format json envelope: payload inside .result', () => {
    const env = JSON.stringify({ type: 'result', result: goodJson })
    expect(parseAnalysisOutput(env, '2.0.13', '2.1.0')).toHaveLength(1)
  })
  it('markdown-fenced payload is unwrapped', () => {
    const fenced = '```json\n' + goodJson + '\n```'
    expect(parseAnalysisOutput(fenced, '2.0.13', '2.1.0')).toHaveLength(1)
  })
  it('registry-proposal findings get sentinel provenance stamped on the patch', () => {
    const withPatch = JSON.stringify({ findings: [{
      kind: 'registry-proposal', severity: 'warn', title: 'New model', evidence: '## 2.1.0 - Added claude-x',
      proposedPatch: { id: 'claude-x-1', patterns: ['claude-x-1'], family: 'x', label: 'X 1' },
    }] })
    const f = parseAnalysisOutput(withPatch, '2.0.13', '2.1.0')!
    expect(f[0].proposedPatch!.provenance.addedBy).toBe('sentinel')
    expect(f[0].proposedPatch!.provenance.ccVersion).toBe('2.1.0')
  })
  it('malformed -> null, never throws', () => {
    expect(parseAnalysisOutput('not json', '2.0.13', '2.1.0')).toBeNull()
    expect(parseAnalysisOutput(JSON.stringify({ findings: [{ bad: true }] }), '1', '2')).toBeNull()
  })
})

describe('runAnalysis', () => {
  it('retries once on malformed output, then reports failure', async () => {
    let calls = 0
    const runner = async () => { calls++; return { code: 0, stdout: 'garbage', stderr: '' } }
    const r = await runAnalysis({ runner, changelog: 'x', manifestJson: '[]', registryJson: '{}', from: '1.0.0', to: '1.0.1' })
    expect(calls).toBe(2)
    expect(r.ok).toBe(false)
  })
  it('passes --model sonnet, -p, --output-format json and the prompt via stdin', async () => {
    let seenArgs: string[] = []; let seenStdin = ''
    const runner = async (args: string[], _t: number, stdin?: string) => {
      seenArgs = args; seenStdin = stdin ?? ''; return { code: 0, stdout: goodJson, stderr: '' }
    }
    const r = await runAnalysis({ runner, changelog: 'CHANGELOG-MARKER', manifestJson: '[]', registryJson: '{}', from: '1.0.0', to: '1.0.1' })
    expect(r.ok).toBe(true)
    expect(seenArgs).toContain('--model'); expect(seenArgs).toContain('sonnet')
    expect(seenArgs).toContain('-p'); expect(seenArgs).toContain('--output-format')
    expect(seenStdin).toContain('CHANGELOG-MARKER')
  })
  it('non-zero exit on both attempts -> failure with a calm, degraded message', async () => {
    const runner = async () => ({ code: 1, stdout: '', stderr: 'not logged in' })
    const r = await runAnalysis({ runner, changelog: 'x', manifestJson: '[]', registryJson: '{}', from: '1', to: '2' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/deterministic checks still ran/i)
  })
  it('timeout degrades to a calm message that never leaks raw stderr', async () => {
    const runner = async () => ({ code: 1, stdout: '', stderr: '\nTimed out after 180s' })
    const r = await runAnalysis({ runner, changelog: 'x', manifestJson: '[]', registryJson: '{}', from: '1', to: '2' })
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
