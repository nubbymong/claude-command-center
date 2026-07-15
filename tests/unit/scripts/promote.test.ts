import { describe, it, expect } from 'vitest'

// promote.js guards main() behind `require.main === module`, so require()-ing
// it here imports only the pure helpers without running a promote.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const promote = require('../../../scripts/promote.js') as {
  stableVersionFor: (branch: string, currentVersion: string) => string
  unBackportedCommits: (logLines: string[]) => string[]
}

const { stableVersionFor, unBackportedCommits } = promote

// ── stableVersionFor ───────────────────────────────────────────────
describe('promote stableVersionFor', () => {
  it('strips the rc suffix to the branch base', () => {
    expect(stableVersionFor('release/2.0.0', '2.0.0-rc.2')).toBe('2.0.0')
    expect(stableVersionFor('release/2.0.0', '2.0.0-rc.1')).toBe('2.0.0')
    expect(stableVersionFor('release/v2.1.3', '2.1.3-rc.7')).toBe('2.1.3')
  })

  it('refuses to promote from beta', () => {
    // The old script REQUIRED being on beta. Under the RC-branch model beta is
    // never frozen, so promoting from it would ship whatever features happened
    // to be mid-flight.
    expect(() => stableVersionFor('beta', '2.1.0-beta.0')).toThrow(/not release\/X\.Y\.Z/)
  })

  it('refuses to promote from main or a feature branch', () => {
    expect(() => stableVersionFor('main', '2.0.0')).toThrow(/not release\/X\.Y\.Z/)
    expect(() => stableVersionFor('fix/whatever', '2.0.0-rc.1')).toThrow(/not release\/X\.Y\.Z/)
  })

  it('catches a version that disagrees with the branch name', () => {
    // Would otherwise ship 2.1.0 out of a branch called release/2.0.0.
    expect(() => stableVersionFor('release/2.0.0', '2.1.0-rc.1')).toThrow(/Version mismatch/)
  })

  it('refuses a version that is not a release candidate', () => {
    expect(() => stableVersionFor('release/2.0.0', '2.0.0-beta.6')).toThrow(/not a release candidate/)
    expect(() => stableVersionFor('release/2.0.0', '2.0.0')).toThrow(/not a release candidate/)
  })

  it('throws on an unparseable version', () => {
    expect(() => stableVersionFor('release/2.0.0', 'garbage')).toThrow(/Cannot parse/)
  })
})

// ── unBackportedCommits ────────────────────────────────────────────
describe('promote unBackportedCommits', () => {
  it('ignores the rc version bumps, which are release-branch-only by design', () => {
    // beta carries its own version line, so `build(release):` commits are never
    // back-ported and must not be reported as debt.
    expect(unBackportedCommits(['78471f1 build(release): 2.0.0-rc.2'])).toEqual([])
    expect(unBackportedCommits([
      '78471f1 build(release): 2.0.0-rc.2',
      'aaaaaaa build(release): 2.0.0-rc.1',
    ])).toEqual([])
  })

  it('reports a real fix that never reached beta', () => {
    const debt = unBackportedCommits([
      '78471f1 build(release): 2.0.0-rc.2',
      'bbbbbbb fix(terminal): stop the flicker',
    ])
    expect(debt).toEqual(['bbbbbbb fix(terminal): stop the flicker'])
  })

  it('handles empty and blank input', () => {
    expect(unBackportedCommits([])).toEqual([])
    expect(unBackportedCommits(['', '   '])).toEqual([])
  })

  it('does not mistake a commit that merely mentions build(release) for a bump', () => {
    const debt = unBackportedCommits(['ccccccc fix(ci): repair build(release): parsing'])
    expect(debt).toEqual(['ccccccc fix(ci): repair build(release): parsing'])
  })

  it('matches the real release/2.0.0 state — no debt', () => {
    // As of the v2.0.0 promote, the only commit on release/2.0.0 that is not on
    // beta is the rc.2 bump, so the promote should report a clean back-port.
    expect(unBackportedCommits(['78471f1 build(release): 2.0.0-rc.2'])).toEqual([])
  })
})
