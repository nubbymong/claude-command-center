import { describe, it, expect } from 'vitest'
import { buildAnalysisPrompt, parseAnalysisOutput, runAnalysis, analysisFailureMessage, envelopeError } from '../../src/main/sentinel/sentinel-analysis'

/** The real shape claude -p prints on a 429 (captured from CC 2.1.239, #430). */
const rateLimitEnvelope = JSON.stringify({
  is_error: true,
  api_error_status: 429,
  terminal_reason: 'api_error',
  subtype: 'success',
  result: "You've hit your weekly limit · resets 4am (Europe/London)",
})

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
  it('a 429 envelope -> a rate-limit message that names the account and stops after ONE attempt (#430)', async () => {
    let calls = 0
    const runner = async () => { calls++; return { code: 1, stdout: rateLimitEnvelope, stderr: '' } }
    const r = await runAnalysis({ runner, changelog: 'x', from: '1', to: '2', accountLabel: 'nick@example.com' })
    expect(calls).toBe(1)                                   // a weekly limit will not clear on retry
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/usage limit/i)
      expect(r.error).toMatch(/resets 4am/)
      expect(r.error).toContain('nick@example.com')
      expect(r.error).toMatch(/Settings . Sentinel/)
      expect(r.error).toMatch(/deterministic checks still ran/i)
    }
  })
  it('a non-rate-limit API error envelope -> the real reason, still retried', async () => {
    let calls = 0
    const env = JSON.stringify({ is_error: true, api_error_status: 500, result: 'Internal server error' })
    const runner = async () => { calls++; return { code: 1, stdout: env, stderr: '' } }
    const r = await runAnalysis({ runner, changelog: 'x', from: '1', to: '2' })
    expect(calls).toBe(2)                                   // a transient 500 is worth the retry
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Internal server error/)
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
  it('a rate-limit envelope -> names the limit, the account, and points at Settings not Re-run', () => {
    const m = analysisFailureMessage('', { rateLimited: true, reason: "You've hit your weekly limit · resets 4am" }, 'nick@example.com')
    expect(m).toMatch(/usage limit/i)
    expect(m).toContain('nick@example.com')
    expect(m).toMatch(/resets 4am/)
    expect(m).toMatch(/Settings . Sentinel/)
  })
})

describe('envelopeError', () => {
  it('reads a 429 as rate-limited with the CLI reason', () => {
    const e = envelopeError(rateLimitEnvelope)!
    expect(e.rateLimited).toBe(true)
    expect(e.reason).toContain("weekly limit")
  })
  it('reads the RAW top-level envelope, not the peeled .result (the error string is not JSON)', () => {
    // Regression for the first cut: routing through unwrapPayload peeled `.result`
    // to "You've hit your weekly limit …", which then failed JSON.parse → null,
    // so the rate limit was never detected. Parsing raw is what fixes it.
    const e = envelopeError(rateLimitEnvelope)
    expect(e?.rateLimited).toBe(true)
  })
  it('a 500 is an error but not rate-limited', () => {
    const e = envelopeError(JSON.stringify({ is_error: true, api_error_status: 500, result: 'boom' }))!
    expect(e.rateLimited).toBe(false)
    expect(e.reason).toBe('boom')
  })
  it('a clean success envelope is not an error', () => {
    expect(envelopeError(JSON.stringify({ is_error: false, result: '{"breakingChanges":[]}' }))).toBeNull()
  })
  it('non-JSON / non-envelope -> null (falls back to the generic message)', () => {
    expect(envelopeError('garbage')).toBeNull()
    expect(envelopeError('')).toBeNull()
  })
  it('strips control chars and caps a pathological result', () => {
    const e = envelopeError(JSON.stringify({ is_error: true, api_error_status: 400, result: 'a\n\tb' + 'x'.repeat(500) }))!
    expect(e.reason).not.toMatch(/[\n\t]/)
    expect(e.reason.length).toBeLessThanOrEqual(160)
  })
})
