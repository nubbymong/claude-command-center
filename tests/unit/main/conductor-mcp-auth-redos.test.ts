/**
 * #151 / CodeQL js/polynomial-redos -- regression guard for the Bearer parser.
 *
 * `isAuthorizedMcpRequest` used `/^bearer\s+(.+)$/i` on the raw Authorization
 * header. That pattern backtracks in polynomial time on `"bearer "` followed by
 * a long run of whitespace, and it runs on an attacker-controlled header on a
 * listening loopback socket BEFORE authentication -- so anything that can reach
 * the port can burn main-process CPU with a single request. The parser is now
 * a linear prefix compare (see parseBearerToken in conductor-mcp-server.ts).
 *
 * The timing assertion here is deliberately loose. It is not a benchmark; it
 * only has to fail if someone reintroduces a super-linear pattern, and the
 * quadratic blow-up is orders of magnitude, not percent.
 */
import { describe, it, expect } from 'vitest'
import {
  isAuthorizedMcpRequest,
  getConductorMcpSecret,
} from '../../../src/main/conductor-mcp-server'

const SECRET = getConductorMcpSecret()

function timeMs(fn: () => void): number {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

describe('Bearer parsing is linear in the header length (#151)', () => {
  it('rejects a whitespace-flood header fast and does not hang', () => {
    const flood = 'bearer ' + ' '.repeat(100_000)
    const elapsed = timeMs(() => {
      expect(isAuthorizedMcpRequest('/sse', flood, SECRET)).toBe(false)
    })
    // The vulnerable regex took seconds at this size; linear parsing is sub-ms.
    expect(elapsed).toBeLessThan(500)
  })

  it('does not blow up super-linearly as the flood grows', () => {
    const small = timeMs(() => {
      isAuthorizedMcpRequest('/sse', 'bearer ' + ' '.repeat(20_000), SECRET)
    })
    const large = timeMs(() => {
      isAuthorizedMcpRequest('/sse', 'bearer ' + ' '.repeat(160_000), SECRET)
    })
    // 8x the input. Linear would be ~8x; quadratic ~64x. Allow generous slack
    // for timer noise on a loaded CI box, but catch an order-of-magnitude jump.
    expect(large).toBeLessThan(Math.max(small * 25, 500))
  })

  it('a whitespace-only token is not a token', () => {
    expect(isAuthorizedMcpRequest('/sse', 'bearer      ', SECRET)).toBe(false)
  })
})

describe('Bearer parsing preserves the pre-fix contract (#151)', () => {
  it('still accepts the correct token', () => {
    expect(isAuthorizedMcpRequest('/sse', `Bearer ${SECRET}`, SECRET)).toBe(true)
  })

  it('still tolerates multiple spaces between scheme and token', () => {
    expect(isAuthorizedMcpRequest('/sse', `Bearer    ${SECRET}`, SECRET)).toBe(true)
  })

  it('still tolerates a tab separator', () => {
    expect(isAuthorizedMcpRequest('/sse', `Bearer\t${SECRET}`, SECRET)).toBe(true)
  })

  it('still tolerates surrounding whitespace on the whole header', () => {
    expect(isAuthorizedMcpRequest('/sse', `   Bearer ${SECRET}   `, SECRET)).toBe(true)
  })

  it('still matches the scheme case-insensitively', () => {
    expect(isAuthorizedMcpRequest('/sse', `BeArEr ${SECRET}`, SECRET)).toBe(true)
  })

  it('rejects a scheme that merely starts with "bearer" (no separator)', () => {
    expect(isAuthorizedMcpRequest('/sse', `bearerX ${SECRET}`, SECRET)).toBe(false)
  })

  it('rejects the bare scheme with no token', () => {
    expect(isAuthorizedMcpRequest('/sse', 'bearer', SECRET)).toBe(false)
  })

  it('rejects a different auth scheme carrying the secret', () => {
    expect(isAuthorizedMcpRequest('/sse', `Basic ${SECRET}`, SECRET)).toBe(false)
  })

  it('falls back to the query param when the header is not a Bearer header', () => {
    expect(isAuthorizedMcpRequest(`/sse?token=${SECRET}`, 'Basic zzz', SECRET)).toBe(true)
  })
})
