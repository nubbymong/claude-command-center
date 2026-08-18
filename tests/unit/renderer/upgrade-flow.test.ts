// The deterministic first-run / what's-new rule.
//
// The rule it replaces was `lastSeen !== changelog[0].version`, which could not
// distinguish a fresh install from an upgrade and only ever showed the single
// newest entry — so someone going 2.0.0 → 2.1.0 saw one release's notes and not
// the fourteen in between.

import { describe, it, expect } from 'vitest'
import { decideUpgradeFlow, entriesSince } from '../../../src/renderer/onboarding/upgrade-flow'
import { compareVersions, crossedReleaseLine, releaseLine } from '../../../src/shared/version-order'

describe('compareVersions', () => {
  it('orders the release tuple', () => {
    expect(compareVersions('2.1.0', '2.0.0')).toBeGreaterThan(0)
    expect(compareVersions('2.0.9', '2.1.0')).toBeLessThan(0)
    expect(compareVersions('1.5.45', '1.5.44')).toBeGreaterThan(0)
    expect(compareVersions('2.1.0', '2.1.0')).toBe(0)
  })

  it('orders prereleases numerically, not as text', () => {
    // The bug a naive string compare produces: '2' > '14'.
    expect(compareVersions('2.1.0-beta.14', '2.1.0-beta.2')).toBeGreaterThan(0)
    expect(compareVersions('2.1.0-beta.9', '2.1.0-beta.10')).toBeLessThan(0)
  })

  it('ranks rc above beta, and a final release above both', () => {
    // docs/versioning.md: both ride the beta channel, rc outranks beta, final
    // outranks rc.
    expect(compareVersions('2.1.0-rc.1', '2.1.0-beta.14')).toBeGreaterThan(0)
    expect(compareVersions('2.1.0', '2.1.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('2.1.0', '2.1.0-beta.1')).toBeGreaterThan(0)
  })

  it('tolerates a v prefix and surrounding whitespace', () => {
    expect(compareVersions('v2.1.0', '2.1.0')).toBe(0)
    expect(compareVersions(' 2.1.0 ', '2.1.0')).toBe(0)
  })

  it('treats an unparseable version as the oldest thing there is', () => {
    // Fail toward showing too much rather than silently showing nothing.
    expect(compareVersions('garbage', '2.1.0')).toBeLessThan(0)
    expect(compareVersions('2.1.0', '')).toBeGreaterThan(0)
    expect(compareVersions('garbage', 'nonsense')).toBe(0)
  })
})

describe('releaseLine / crossedReleaseLine', () => {
  it('reads the major.minor line', () => {
    expect(releaseLine('2.1.0-beta.14')).toBe('2.1')
    expect(releaseLine('2.0.0')).toBe('2.0')
  })

  it('crosses on a minor bump but not within one', () => {
    expect(crossedReleaseLine('2.0.5', '2.1.0')).toBe(true)
    expect(crossedReleaseLine('2.1.0-beta.13', '2.1.0-beta.14')).toBe(false)
    expect(crossedReleaseLine('2.1.0-rc.1', '2.1.0')).toBe(false)
    expect(crossedReleaseLine('1.5.45', '2.0.0')).toBe(true)
  })

  it('counts an unreadable origin as a crossing', () => {
    expect(crossedReleaseLine('', '2.1.0')).toBe(true)
  })
})

describe('decideUpgradeFlow', () => {
  it('a fresh install gets the tour and NO what is new', () => {
    const d = decideUpgradeFlow({ currentVersion: '2.1.0' })
    expect(d).toMatchObject({ kind: 'first-install', showTour: true, showWhatsNew: false })
    expect(d.reason).toBe('no-stored-version')
  })

  it('an unchanged version shows nothing at all', () => {
    const d = decideUpgradeFlow({ lastSeenVersion: '2.1.0', currentVersion: '2.1.0' })
    expect(d).toMatchObject({ kind: 'nothing', showTour: false, showWhatsNew: false })
  })

  it('does not re-fire on a formatting difference alone', () => {
    // A stored 'v2.1.0' is the same release as '2.1.0'; a string compare would
    // show the modal on every single launch.
    expect(decideUpgradeFlow({ lastSeenVersion: 'v2.1.0', currentVersion: '2.1.0' }).kind).toBe('nothing')
  })

  it('crossing a release line shows what is new AND re-runs the tour', () => {
    // The owner's ask in one case: 2.0 users must walk the tour again on 2.1.
    const d = decideUpgradeFlow({ lastSeenVersion: '2.0.0', currentVersion: '2.1.0' })
    expect(d).toMatchObject({ kind: 'upgrade', showTour: true, showWhatsNew: true })
    expect(d.reason).toBe('crossed-line')
  })

  it('moving within a line shows what is new only', () => {
    const d = decideUpgradeFlow({ lastSeenVersion: '2.1.0', currentVersion: '2.1.1' })
    expect(d).toMatchObject({ kind: 'upgrade', showTour: false, showWhatsNew: true })
    expect(d.reason).toBe('within-line')
  })

  it('beta testers re-walk the tour on every version', () => {
    const d = decideUpgradeFlow({
      lastSeenVersion: '2.1.0-beta.13',
      currentVersion: '2.1.0-beta.14',
      channel: 'beta',
    })
    expect(d).toMatchObject({ showTour: true, showWhatsNew: true })
    expect(d.reason).toBe('beta-channel')
  })

  it('a stable user moving between patches does NOT get the tour', () => {
    const d = decideUpgradeFlow({
      lastSeenVersion: '2.1.0-beta.13',
      currentVersion: '2.1.0-beta.14',
      channel: 'stable',
    })
    expect(d.showTour).toBe(false)
  })

  it('still shows notes after a downgrade', () => {
    // A tester dropping back a build changed what they are running; showing the
    // notes for it beats showing nothing.
    const d = decideUpgradeFlow({ lastSeenVersion: '2.1.0', currentVersion: '2.0.0' })
    expect(d.showWhatsNew).toBe(true)
  })
})

describe('entriesSince', () => {
  // Deliberately in the real changelog's DATE order, which is not semver order:
  // 2.0.0 shipped before its own -beta.5 and -rc.2 entries and therefore sits
  // BELOW them in the array while ranking ABOVE them by version.
  const log = [
    { version: '2.1.0-beta.14' },
    { version: '2.1.0-beta.13' },
    { version: '2.1.0-beta.1' },
    { version: '2.0.0-rc.2' },
    { version: '2.0.0-beta.5' },
    { version: '2.0.0' },
    { version: '1.5.45' },
  ]

  it('returns everything newer than what was last seen', () => {
    expect(entriesSince(log, '2.1.0-beta.13', '2.1.0-beta.14').map((e) => e.version)).toEqual([
      '2.1.0-beta.14',
    ])
  })

  it('spans many releases, not just the newest one', () => {
    const got = entriesSince(log, '2.0.0', '2.1.0-beta.14').map((e) => e.version)
    expect(got).toEqual(['2.1.0-beta.14', '2.1.0-beta.13', '2.1.0-beta.1'])
  })

  it('never hands a 2.0.0 user the notes for 2.0.0 own prereleases', () => {
    // The whole reason this filters instead of slicing by index. Those two
    // entries sit ABOVE 2.0.0 in the array but BELOW it by version.
    const got = entriesSince(log, '2.0.0', '2.1.0-beta.14').map((e) => e.version)
    expect(got).not.toContain('2.0.0-rc.2')
    expect(got).not.toContain('2.0.0-beta.5')
  })

  it('is sorted newest first even though the source array is not', () => {
    const got = entriesSince(log, '1.5.45', '2.1.0-beta.14').map((e) => e.version)
    expect(got).toEqual([
      '2.1.0-beta.14',
      '2.1.0-beta.13',
      '2.1.0-beta.1',
      '2.0.0',
      '2.0.0-rc.2',
      '2.0.0-beta.5',
    ])
  })

  it('excludes anything newer than the running build', () => {
    // A downgraded tester must not be shown notes for a build they no longer
    // have installed.
    const got = entriesSince(log, '2.0.0', '2.1.0-beta.13').map((e) => e.version)
    expect(got).not.toContain('2.1.0-beta.14')
  })

  it('returns nothing for a first install', () => {
    expect(entriesSince(log, undefined, '2.1.0-beta.14')).toEqual([])
  })
})
