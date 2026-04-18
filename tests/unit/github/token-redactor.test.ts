import { describe, it, expect } from 'vitest'
import { redactTokens, wrapLogger } from '../../../src/main/github/security/token-redactor'

// Realistic token lengths (36+ chars after prefix) — real GitHub tokens.
const PAT_CLASSIC = 'ghp_' + 'a'.repeat(36)
const PAT_FINEGRAINED = 'github_pat_' + 'A'.repeat(22) + '_' + 'B'.repeat(59)
const OAUTH = 'gho_' + '1'.repeat(36)
const USER = 'ghu_' + '2'.repeat(36)
const SERVER = 'ghs_' + '3'.repeat(36)
const REFRESH = 'ghr_' + '4'.repeat(36)
const INSTALL = 'ghi_' + '5'.repeat(36)

describe('redactTokens', () => {
  it('redacts classic PAT with space prefix', () => {
    expect(redactTokens(`token ${PAT_CLASSIC}`)).toBe('token [REDACTED]')
  })
  it('redacts fine-grained PAT', () => {
    expect(redactTokens(PAT_FINEGRAINED)).toBe('[REDACTED]')
  })
  it('redacts gho_, ghu_, ghs_, ghr_, ghi_', () => {
    const input = `${OAUTH} ${USER} ${SERVER} ${REFRESH} ${INSTALL}`
    expect(redactTokens(input)).toBe('[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]')
  })
  it('redacts access_token= URL param', () => {
    expect(redactTokens('x?access_token=secret&other=ok')).toBe('x?[REDACTED]&other=ok')
  })
  it('redacts token with underscore-prefix (env-var style) — regression for \\b bypass', () => {
    // `\b` does NOT fire between two word chars like `_` and `g`.
    // Patterns must use (?<![A-Za-z0-9_]) to catch shell env dumps.
    expect(redactTokens(`MY_TOKEN=${PAT_CLASSIC}`)).toBe('MY_TOKEN=[REDACTED]')
    expect(redactTokens(`prefix_${PAT_CLASSIC}`)).toBe('prefix_[REDACTED]')
  })
  it('redacts token embedded in URL', () => {
    expect(redactTokens(`https://x-access-token:${PAT_CLASSIC}@github.com/a/b.git`)).toBe(
      'https://x-access-token:[REDACTED]@github.com/a/b.git',
    )
  })
  it('does NOT redact public OAuth Client ID', () => {
    expect(redactTokens('client_id=Ov23liOJO5KaUDD9D1bY')).toBe('client_id=Ov23liOJO5KaUDD9D1bY')
  })
  it('does NOT redact short test-fixture strings like ghp_X', () => {
    // Minimum 20-char suffix avoids destroying short fixtures.
    expect(redactTokens('ghp_X')).toBe('ghp_X')
    expect(redactTokens('ghp_abc')).toBe('ghp_abc')
  })
  it('leaves normal text untouched', () => {
    expect(redactTokens('normal log line')).toBe('normal log line')
  })
})

describe('wrapLogger', () => {
  it('redacts only string args', () => {
    const collected: unknown[] = []
    const logger = wrapLogger((...a: unknown[]) => collected.push(...a))
    logger(`Bearer ${PAT_CLASSIC}`, { num: 42 }, 'normal')
    expect(collected[0]).toBe('Bearer [REDACTED]')
    expect(collected[1]).toEqual({ num: 42 })
    expect(collected[2]).toBe('normal')
  })
})
