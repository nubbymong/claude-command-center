import { describe, it, expect } from 'vitest'
import { parseKpiOutput, stripAnsiCodes } from '../../src/main/insights-runner'

// Unit 3 W9: cover the previously-untested KPI-output parser (lifted out of
// extractKpis) and the ANSI stripper.
describe('parseKpiOutput', () => {
  it('parses a direct JSON object', () => {
    expect(parseKpiOutput('{"kpis":{"a":1}}')).toEqual({ kpis: { a: 1 } })
  })

  it('unwraps the {result:"<json>"} envelope from claude -p --output-format json', () => {
    const envelope = JSON.stringify({ type: 'result', result: JSON.stringify({ kpis: { a: 2 } }) })
    expect(parseKpiOutput(envelope)).toEqual({ kpis: { a: 2 } })
  })

  it('extracts JSON when the result string has prose around it', () => {
    const envelope = JSON.stringify({ result: 'Here you go:\n{"kpis":{"a":3}}\nDone.' })
    expect(parseKpiOutput(envelope)).toEqual({ kpis: { a: 3 } })
  })

  it('extracts JSON from raw non-enveloped output with surrounding prose', () => {
    expect(parseKpiOutput('blah blah {"kpis":{"a":4}} trailing text')).toEqual({ kpis: { a: 4 } })
  })

  it('returns null when there is no JSON object', () => {
    expect(parseKpiOutput('no json here')).toBeNull()
    expect(parseKpiOutput('')).toBeNull()
  })
})

describe('stripAnsiCodes', () => {
  it('removes CSI color sequences but keeps the text', () => {
    expect(stripAnsiCodes('\x1b[31mred\x1b[0m text')).toBe('red text')
  })

  it('removes OSC (title) sequences', () => {
    expect(stripAnsiCodes('\x1b]0;window-title\x07hello')).toBe('hello')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsiCodes('plain text')).toBe('plain text')
  })
})
