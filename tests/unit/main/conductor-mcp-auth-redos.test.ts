/**
 * #151 / CodeQL js/polynomial-redos -- regression guard for the Bearer parser.
 *
 * `isAuthorizedMcpRequest` used `/^bearer\s+(.+)$/i` on the Authorization
 * header. Replaced with a linear prefix parse (parseBearerToken).
 *
 * READ THIS BEFORE EDITING THE PAYLOAD. The first version of this file was
 * VACUOUS -- it flooded with `'bearer ' + ' '.repeat(n)` and asserted a time
 * bound. Two independent adversarial reviewers found that all of its timing
 * assertions PASS against the vulnerable regex, so it guarded nothing:
 *
 *   1. `isAuthorizedMcpRequest` calls `authHeader.trim()` BEFORE parsing, so a
 *      trailing whitespace run is deleted -- `'bearer ' + ' '.repeat(100_000)`
 *      trims to the 6-char string `'bearer'`.
 *   2. Even untrimmed, that input MATCHES: `\s+` takes one space, `(.+)` eats
 *      the rest, `$` hits. One backtrack. Linear.
 *
 * The quadratic path needs the match to FAIL after the whitespace run, which
 * needs a LineTerminator that `.` cannot cross -- and a non-whitespace tail so
 * the outer `.trim()` cannot eat it. Hence `'bearer' + SP*n + 'X\nY'`. Measured
 * against the pre-fix regex: n=20k 128ms, n=40k 549ms, n=80k 2209ms (clean
 * n^2). The linear parser is flat and sub-millisecond at every size.
 *
 * Reachability, for honesty: this payload does not survive Node's HTTP parser
 * (llhttp 400s bare CR/LF in a header value, and http.maxHeaderSize caps the
 * value at 16 KB). The fix and this guard stand anyway -- the exported function
 * must not depend on another component's input filtering to be safe.
 */
import { describe, it, expect } from 'vitest'
import {
  isAuthorizedMcpRequest,
  getConductorMcpSecret,
} from '../../../src/main/conductor-mcp-server'

const SECRET = getConductorMcpSecret()

/** The payload that actually forces backtracking. Do not "simplify" this. */
function redosPayload(spaces: number): string {
  return 'bearer' + ' '.repeat(spaces) + 'X\nY'
}

/** Best-of-3 elapsed time. Round-2 review measured occasional 80ms excursions
 *  under heavy CPU load, because payload allocation sat INSIDE the timed window
 *  and a GC pause landed in the measurement. Callers now build the payload
 *  first and this takes the minimum of three runs. Discriminating power is
 *  ~2270ms vs ~0.5ms, so nothing is lost by being generous. */
function timeMs(fn: () => void): number {
  let best = Infinity
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    fn()
    best = Math.min(best, performance.now() - t0)
  }
  return best
}

describe('Bearer parsing is linear in the header length (#151)', () => {
  it('rejects the quadratic payload in well under the vulnerable time', () => {
    const payload = redosPayload(80_000)
    expect(isAuthorizedMcpRequest('/sse', payload, SECRET)).toBe(false)
    // Pre-fix: ~2270 ms at this size (measured). Post-fix: sub-millisecond.
    // 250 ms sits ~9x under the bug signal and ~500x over the fixed path -- a
    // reintroduced regex cannot pass it, and a slow shared runner has room.
    expect(timeMs(() => isAuthorizedMcpRequest('/sse', payload, SECRET))).toBeLessThan(250)
  })

  it('does not blow up super-linearly as the payload grows', () => {
    const smallPayload = redosPayload(20_000)
    const largePayload = redosPayload(80_000)
    const small = timeMs(() => isAuthorizedMcpRequest('/sse', smallPayload, SECRET))
    const large = timeMs(() => isAuthorizedMcpRequest('/sse', largePayload, SECRET))
    // 4x the input. Linear ~4x; the vulnerable regex measured ~17x (128->2209ms).
    // Generous slack for timer noise, but an order-of-magnitude jump fails.
    expect(large).toBeLessThan(Math.max(small * 10, 250))
  })

  it('also stays linear on a trailing whitespace flood (the trimmed case)', () => {
    const flood = 'bearer ' + ' '.repeat(200_000)
    expect(isAuthorizedMcpRequest('/sse', flood, SECRET)).toBe(false)
    expect(timeMs(() => isAuthorizedMcpRequest('/sse', flood, SECRET))).toBeLessThan(250)
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

  it('rejects the bare scheme with no token', () => {
    expect(isAuthorizedMcpRequest('/sse', 'bearer', SECRET)).toBe(false)
  })
})

/**
 * The separator narrowed from `\s` (any whitespace) to SP/HTAB. That is the
 * entire semantic delta of the fix, and it was originally UNTESTED -- a future
 * "let's be lenient again" refactor back to `\s` would have passed the suite.
 * RFC 9110 gives `auth-scheme 1*SP token68`, so SP is the only legal separator;
 * HTAB is kept purely for backward compatibility.
 */
describe('separator narrowing is pinned (#151)', () => {
  // Escapes, not literals: invisible characters in source do not survive
  // copy/paste review. These are every whitespace class `\s` used to accept.
  const NON_SP_WHITESPACE = [
    '\u000a', '\u000b', '\u000c', '\u000d', '\u00a0', '\u1680', '\u2000',
    '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
  ]

  for (const ws of NON_SP_WHITESPACE) {
    const label = `U+${ws.codePointAt(0)!.toString(16).padStart(4, '0')}`
    it(`rejects ${label} as a scheme separator even with the correct secret`, () => {
      expect(isAuthorizedMcpRequest('/sse', `Bearer${ws}${SECRET}`, SECRET)).toBe(false)
    })
  }

  // ROUND-2 NOTE. The first version of this used `Bearer wrong` as the payload.
  // That is NOT a refusal -- SP separator, non-empty token -- so it parses cleanly
  // under the pre-fix regex, round 1 and round 2 alike, and the assertion
  // discriminated nothing (its comment claimed the opposite, wrongly). A real
  // refusal needs a separator that `\s` accepted and SP/HTAB does not. U+00A0 is
  // the one such character that survives Node's HTTP parser (obs-text, decoded as
  // latin-1), so it is the honest payload. Escape, never a literal.
  it('a refused Bearer header is FATAL -- it does not fall through to ?token=', () => {
    const nbsp = '\u00a0'
    expect(
      isAuthorizedMcpRequest(`/sse?token=${SECRET}`, `Bearer${nbsp}${SECRET}`, SECRET),
    ).toBe(false)
  })

  it('a rejected separator hiding behind a legal one is still fatal', () => {
    // If only the FIRST separator char were checked, `slice().trim()` would absorb
    // the rest -- so one leading space would defeat the entire narrowing.
    for (const ws of NON_SP_WHITESPACE) {
      expect(isAuthorizedMcpRequest('/sse', `Bearer ${ws}${SECRET}`, SECRET)).toBe(false)
      expect(isAuthorizedMcpRequest('/sse', `Bearer\t${ws} ${SECRET}`, SECRET)).toBe(false)
      expect(isAuthorizedMcpRequest(`/sse?token=${SECRET}`, `Bearer ${ws}x`, SECRET)).toBe(false)
    }
  })

  it('a NON-Bearer scheme is not a refusal -- ?token= still works', () => {
    // `Basic ...` offers no Bearer credential at all, so the query param is
    // still the presented credential. Distinct from the fatal case above.
    expect(isAuthorizedMcpRequest(`/sse?token=${SECRET}`, 'Basic zzz', SECRET)).toBe(true)
  })

  it('a scheme merely starting with "bearer" is not a refusal', () => {
    expect(isAuthorizedMcpRequest(`/sse?token=${SECRET}`, 'bearerX zzz', SECRET)).toBe(true)
  })

  it('rejects a different auth scheme carrying the secret in the header', () => {
    expect(isAuthorizedMcpRequest('/sse', `Basic ${SECRET}`, SECRET)).toBe(false)
  })
})

/**
 * timingSafeEqual(<empty>, <empty>) is true, and `?token=` yields '' rather
 * than null -- so an empty expectedSecret authorized every request. The live
 * provider always mints 64 hex chars, but the gate must not trust its own input.
 */
describe('a missing or degenerate expected secret fails closed (#151)', () => {
  for (const bad of ['', 'short', 'a'.repeat(31)]) {
    it(`refuses to authenticate against a ${bad.length}-char secret`, () => {
      expect(isAuthorizedMcpRequest('/sse?token=', undefined, bad)).toBe(false)
      expect(isAuthorizedMcpRequest(`/sse?token=${bad}`, undefined, bad)).toBe(false)
      expect(isAuthorizedMcpRequest('/sse', `Bearer ${bad}`, bad)).toBe(false)
    })
  }
})
