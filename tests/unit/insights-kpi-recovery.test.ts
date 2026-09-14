import { describe, it, expect, vi } from 'vitest'

vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => '',
  registerSetupHandlers: () => {}
}))

import {
  describeClaudeError,
  extractJsonObject,
  looksTruncated,
  parseKpiOutput
} from '../../src/main/insights-runner'

// A real 4-account run: 3 of 4 KPI extractions failed. One never reached the API
// (is_error:true, every token count 0, duration_api_ms 0). Two produced 4,788
// output tokens each, cost $0.77 each, and were DISCARDED because the greedy
// `/\{[\s\S]*\}/` match returned nothing and only 500 characters of the envelope
// were logged. These tests pin the recovery and the diagnostics.

const KPIS = { period: { days: 3 }, kpis: { Volume: { sessions: { value: 4, label: 'Sessions' } } } }

function envelope(result: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ is_error: false, stop_reason: 'end_turn', result, ...extra })
}

describe('extractJsonObject', () => {
  it('recovers a fenced object', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('recovers an object with prose on both sides', () => {
    expect(extractJsonObject('Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 })
  })

  it('recovers when trailing prose contains a closing brace', () => {
    // This is what defeated the greedy match: it ran past the real closing brace
    // to the last one in the string and produced invalid JSON.
    expect(extractJsonObject('{"a":1}\nnote: use } to close an object')).toEqual({ a: 1 })
  })

  it('fails safe on a stray unclosed brace in leading prose', () => {
    // Accepted limitation, documented in extractJsonObject: positionally this is
    // indistinguishable from a truncated reply, and the safe direction is to
    // report failure (which saves the raw reply for inspection) rather than risk
    // returning a nested fragment as the payload.
    expect(extractJsonObject('an object starts with { like so:\n{"a":1}')).toBeNull()
  })

  it('never returns a NESTED object out of a truncated reply', () => {
    // The failure this guards: the outer object is cut off, the inner
    // {"days":3} closes cleanly, and returning it would write a plausible but
    // wrong kpis.json to disk.
    const truncated = '{"period":{"days":3},"kpis":{"Volume":{"sessions":{"value"'
    expect(extractJsonObject(truncated)).toBeNull()
    expect(looksTruncated(truncated)).toBe(true)
  })

  it('prefers the largest object when prose carries a small one too', () => {
    const text = '{"note":1} then the real payload: ' + JSON.stringify(KPIS)
    expect(extractJsonObject(text)).toEqual(KPIS)
  })

  it('is not fooled by braces inside strings', () => {
    expect(extractJsonObject('{"a":"} not the end {","b":2}')).toEqual({ a: '} not the end {', b: 2 })
  })

  it('handles escaped quotes inside strings', () => {
    expect(extractJsonObject('{"a":"say \\"hi\\" }","b":1}')).toEqual({ a: 'say "hi" }', b: 1 })
  })

  it('returns null on truncated output rather than a partial object', () => {
    expect(extractJsonObject('{"period":{"days":3},"kpis":{"Volume":{"sessions":{"value"')).toBeNull()
  })

  it('returns null for junk, arrays, and empty input', () => {
    expect(extractJsonObject('')).toBeNull()
    expect(extractJsonObject('no braces here')).toBeNull()
    expect(extractJsonObject('[1,2,3]')).toBeNull()
  })
})

describe('looksTruncated', () => {
  it('flags an object that never closes', () => {
    expect(looksTruncated('{"a":1,"b":{"c":')).toBe(true)
  })

  it('does not flag a complete object, even with trailing prose', () => {
    expect(looksTruncated('{"a":1} done')).toBe(false)
  })

  it('does not flag text with no object at all', () => {
    expect(looksTruncated('sorry, no JSON')).toBe(false)
  })
})

describe('parseKpiOutput', () => {
  it('unwraps a clean envelope', () => {
    expect(parseKpiOutput(envelope(JSON.stringify(KPIS)))).toEqual(KPIS)
  })

  it('unwraps an envelope whose result is fenced and prose-wrapped', () => {
    expect(parseKpiOutput(envelope('Sure!\n```json\n' + JSON.stringify(KPIS) + '\n```\nDone.'))).toEqual(KPIS)
  })

  it('unwraps an envelope recovered from NOISY stdout — and does not return the envelope', () => {
    // The regression that matters: recovering the envelope from dirty stdout and
    // then returning it would write the CLI's own metadata to kpis.json as if it
    // were the metrics. It must still be unwrapped.
    const noisy = 'Warning: something on stdout\n' + envelope(JSON.stringify(KPIS)) + '\n'
    const out = parseKpiOutput(noisy) as Record<string, unknown>
    expect(out).toEqual(KPIS)
    expect(out.is_error).toBeUndefined()
    expect(out.stop_reason).toBeUndefined()
  })

  it('accepts a bare KPI object with no envelope', () => {
    expect(parseKpiOutput(JSON.stringify(KPIS))).toEqual(KPIS)
  })

  it('returns null when the reply was truncated mid-object', () => {
    expect(parseKpiOutput(envelope('{"period":{"days":3},"kpis":{"Volume"'))).toBeNull()
  })

  it('returns null for junk and for an array', () => {
    expect(parseKpiOutput('')).toBeNull()
    expect(parseKpiOutput('total nonsense')).toBeNull()
    expect(parseKpiOutput('[1,2]')).toBeNull()
  })
})

describe('describeClaudeError', () => {
  it('names the failure that never reached the API', () => {
    // Shape observed in the real log: zeroed usage, duration_api_ms 0, 1 turn.
    const out = describeClaudeError(
      JSON.stringify({
        is_error: true,
        subtype: 'error_during_execution',
        result: 'Weekly usage limit reached',
        duration_api_ms: 0,
        num_turns: 1,
        stop_reason: 'stop_sequence'
      })
    )
    expect(out).toContain('error_during_execution')
    expect(out).toContain('Weekly usage limit reached')
    expect(out).toContain('the API was never reached')
    expect(out).toContain('stop_reason=stop_sequence')
  })

  it('falls back to a nested error message', () => {
    expect(describeClaudeError(JSON.stringify({ is_error: true, error: { message: 'boom' } }))).toContain('boom')
  })

  it('says so when is_error carries no message at all', () => {
    expect(describeClaudeError(JSON.stringify({ is_error: true }))).toBe(
      'claude reported is_error with no message'
    )
  })

  it('returns null for a successful reply or unparseable output', () => {
    expect(describeClaudeError(envelope('{}'))).toBeNull()
    expect(describeClaudeError('not json')).toBeNull()
    expect(describeClaudeError('')).toBeNull()
  })
})
