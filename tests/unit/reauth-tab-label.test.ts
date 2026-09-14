import { describe, it, expect } from 'vitest'
import { reauthTabLabel } from '../../src/renderer/hooks/useReauthAccount'

// #191: re-auth opened a login tab with NO NAME. AccountProfile.name is documented
// as defaulting to "Personal · <localpart>" but was an empty string on every
// profile on a real machine, and the label was `profile.name` verbatim. Signing two
// accounts back in gave two unlabelled tabs.

describe('reauthTabLabel', () => {
  it('falls back to the email when the profile name is empty — the real case', () => {
    expect(reauthTabLabel('', { name: '', accountEmail: 'aai-se03@broadnet.com' }, undefined)).toBe(
      'Sign in: aai-se03@broadnet.com'
    )
  })

  it('never returns a label with nothing after the prefix', () => {
    for (const args of [
      [undefined, undefined, undefined],
      ['', { name: '', accountEmail: '' }, undefined],
      ['   ', { name: '   ', accountEmail: '   ' }, {}]
    ] as const) {
      const label = reauthTabLabel(args[0], args[1] as never, args[2] as never)
      expect(label).toBe('Sign in: account')
      expect(label.replace('Sign in: ', '').trim().length).toBeGreaterThan(0)
    }
  })

  it('prefers a real profile name over the email', () => {
    expect(reauthTabLabel(undefined, { name: 'Work', accountEmail: 'w@example.com' }, undefined)).toBe(
      'Sign in: Work'
    )
  })

  it('uses a user alias when the profile is unnamed', () => {
    expect(
      reauthTabLabel(undefined, { name: '', accountEmail: 'W@Example.com' }, { 'w@example.com': 'Client A' })
    ).toBe('Sign in: Client A')
  })

  it("honours the caller's hint when it has one", () => {
    expect(reauthTabLabel('SE03', { name: '', accountEmail: 'aai-se03@broadnet.com' }, undefined)).toBe(
      'Sign in: SE03'
    )
  })

  it('still names the account when the profile is missing from the store', () => {
    expect(reauthTabLabel('severson@broadnet.com', undefined, undefined)).toBe(
      'Sign in: severson@broadnet.com'
    )
  })

  it('is prefixed, so a login tab is not mistaken for an ordinary session', () => {
    expect(reauthTabLabel(undefined, { name: 'Work', accountEmail: 'w@example.com' }, undefined)).toMatch(
      /^Sign in: /
    )
  })
})
