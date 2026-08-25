// #439 adversarial A2/A7 — the shared account-email reader: isolated world
// preferred, and the result shape-validated so a page-influenced string cannot
// smuggle bidi/zero-width controls (identity spoofing) or shell metacharacters.
import { describe, it, expect, vi } from 'vitest'
import { sanitizeAccountEmail, readAccountEmail } from '../../src/main/account-web/account-email-read'

// Named by code point so the source stays plain ASCII.
const RLO = String.fromCharCode(0x202e)  // right-to-left override
const ZWSP = String.fromCharCode(0x200b) // zero-width space
const ZWJ = String.fromCharCode(0x200d)  // zero-width joiner
const LRI = String.fromCharCode(0x2066)  // left-to-right isolate
const NUL = String.fromCharCode(0x00)    // control

describe('sanitizeAccountEmail', () => {
  it('accepts ordinary emails', () => {
    expect(sanitizeAccountEmail('me@example.com')).toBe('me@example.com')
    expect(sanitizeAccountEmail('a.b+c@sub.example.co.uk')).toBe('a.b+c@sub.example.co.uk')
  })

  it('rejects bidi / zero-width / control characters (identity spoofing)', () => {
    expect(sanitizeAccountEmail('billing' + RLO + ZWSP + 'x@claude.ai')).toBeNull()
    expect(sanitizeAccountEmail('a' + ZWJ + '@b.com')).toBeNull()
    expect(sanitizeAccountEmail('a' + NUL + '@b.com')).toBeNull()
    expect(sanitizeAccountEmail('a' + LRI + '@b.com')).toBeNull()
  })

  it('rejects shell metacharacters and quotes (an email can flow into a shown command)', () => {
    for (const bad of ['a`whoami`@b.com', 'a$b@c.com', 'a;b@c.com', 'a|b@c.com', 'a&b@c.com', "a'@b.com", 'a"@b.com', 'a<@b.com', 'a(b)@c.com']) {
      expect(sanitizeAccountEmail(bad)).toBeNull()
    }
  })

  it('rejects non-strings, non-emails, and over-long input', () => {
    expect(sanitizeAccountEmail(null)).toBeNull()
    expect(sanitizeAccountEmail(42)).toBeNull()
    expect(sanitizeAccountEmail('not an email')).toBeNull()
    expect(sanitizeAccountEmail('a'.repeat(200) + '@b.com')).toBeNull()
  })
})

describe('readAccountEmail', () => {
  it('prefers the ISOLATED world when available (page script cannot shadow the wrapper)', async () => {
    const iso = vi.fn(async () => 'me@example.com')
    const main = vi.fn(async () => 'attacker@evil.example')
    const email = await readAccountEmail({ executeJavaScriptInIsolatedWorld: iso, executeJavaScript: main } as never)
    expect(iso).toHaveBeenCalledWith(1, [expect.objectContaining({ code: expect.stringContaining('/api/bootstrap') })])
    expect(main).not.toHaveBeenCalled()
    expect(email).toBe('me@example.com')
  })

  it('falls back to the main world only when the isolated one is absent, and still sanitizes', async () => {
    // A spoof attempt through the fallback path is sanitized away.
    const main = vi.fn(async () => 'billing' + RLO + 'x@claude.ai')
    const email = await readAccountEmail({ executeJavaScript: main } as never)
    expect(main).toHaveBeenCalled()
    expect(email).toBeNull()
  })

  it('never throws; returns null on a rejected read', async () => {
    const email = await readAccountEmail({ executeJavaScript: async () => { throw new Error('gone') } } as never)
    expect(email).toBeNull()
  })
})
