import { describe, it, expect } from 'vitest'
import { redactTokens, wrapLogger } from '../../../src/main/github/security/token-redactor'

describe('redactTokens', () => {
  it('redacts ghp_', () => {
    expect(redactTokens('token ghp_abc123XYZ')).toBe('token [REDACTED]')
  })
  it('redacts github_pat_', () => {
    expect(redactTokens('github_pat_ABC_123xyz')).toBe('[REDACTED]')
  })
  it('redacts gho_, ghu_, ghs_, ghr_, ghi_', () => {
    expect(redactTokens('gho_1 ghu_2 ghs_3 ghr_4 ghi_5')).toBe(
      '[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED]',
    )
  })
  it('redacts access_token= URL param', () => {
    expect(redactTokens('x?access_token=secret&other=ok')).toBe('x?[REDACTED]&other=ok')
  })
  it('does NOT redact public OAuth Client ID', () => {
    expect(redactTokens('client_id=Ov23liOJO5KaUDD9D1bY')).toBe(
      'client_id=Ov23liOJO5KaUDD9D1bY',
    )
  })
  it('leaves normal text untouched', () => {
    expect(redactTokens('normal log line')).toBe('normal log line')
  })
})

describe('wrapLogger', () => {
  it('redacts only string args', () => {
    const collected: unknown[] = []
    const logger = wrapLogger((...a: unknown[]) => collected.push(...a))
    logger('Bearer ghp_X', { num: 42 }, 'normal')
    expect(collected[0]).toBe('Bearer [REDACTED]')
    expect(collected[1]).toEqual({ num: 42 })
    expect(collected[2]).toBe('normal')
  })
})
