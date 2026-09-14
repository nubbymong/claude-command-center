import { describe, it, expect, vi } from 'vitest'

// The runner reads the resources dir at import time via this module.
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => '',
  registerSetupHandlers: () => {}
}))

import { describeClaudeUsage } from '../../src/main/insights-runner'

// #191 follow-up: every token figure for Insights was an ESTIMATE from file sizes
// while the CLI was already reporting real usage in the `--output-format json`
// envelope and the code threw it away. Logging it makes the next optimisation pass
// measurement instead of arithmetic.

describe('describeClaudeUsage', () => {
  it('renders the snake_case usage block the CLI emits', () => {
    const out = describeClaudeUsage(
      JSON.stringify({
        result: '{}',
        usage: {
          input_tokens: 31700,
          output_tokens: 4200,
          cache_read_input_tokens: 12,
          cache_creation_input_tokens: 0
        },
        total_cost_usd: 0.12345,
        duration_ms: 41000
      })
    )
    expect(out).toBe('in=31700 out=4200 cacheRead=12 cacheWrite=0 cost=$0.1235 41s')
  })

  it('accepts camelCase field names too', () => {
    expect(
      describeClaudeUsage(JSON.stringify({ usage: { inputTokens: 10, outputTokens: 2 }, totalCostUsd: 0.5 }))
    ).toBe('in=10 out=2 cost=$0.5000')
  })

  it('reports whatever subset is present', () => {
    expect(describeClaudeUsage(JSON.stringify({ usage: { input_tokens: 5 } }))).toBe('in=5')
  })

  it('returns null when there is nothing to report', () => {
    expect(describeClaudeUsage('')).toBeNull()
    expect(describeClaudeUsage('not json')).toBeNull()
    expect(describeClaudeUsage(JSON.stringify({ result: 'ok' }))).toBeNull()
    expect(describeClaudeUsage(JSON.stringify({ usage: {} }))).toBeNull()
    expect(describeClaudeUsage(JSON.stringify([1, 2]))).toBeNull()
  })

  it('ignores non-numeric junk in the usage block', () => {
    expect(
      describeClaudeUsage(JSON.stringify({ usage: { input_tokens: 'lots', output_tokens: 7 } }))
    ).toBe('out=7')
  })
})
