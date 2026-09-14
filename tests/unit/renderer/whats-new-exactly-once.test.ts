// A version change shows the What's New page exactly once (#369).
//
// The rule the owner asked to have pinned, as a simulation rather than a
// single assertion: a machine's app-meta carried through a sequence of
// launches, each launch deciding with the pure rule and stamping the way the
// real code stamps. "Exactly once" means: the page is shown on the first
// launch of every build that differs from the one before, is shown again only
// if that launch ended without the user acknowledging it, and is never shown
// twice for the same build once acknowledged.
//
// The sequence that produced #369 is replayed with the OLD stamping rule —
// a beta.15-era build stamped the changelog HEAD, not the version it ran —
// and that is the case the witness field exists for.

import { describe, it, expect } from 'vitest'
import { decideUpgradeFlow, lastRunVersionOf } from '../../../src/renderer/onboarding/upgrade-flow'

interface Meta {
  lastSeenVersion?: string
  setupVersion?: string
  lastRunVersion?: string
}

interface Launch {
  /** The version this build IS (package.json / __APP_VERSION__). */
  version: string
  /** Pre-beta.16 build: stamps "seen" from the changelog head, which on any
   *  build between two releases sits one release AHEAD of `version`. */
  legacyHead?: string
  /** The user closed the app before the page's CTA. */
  quitBeforeAck?: boolean
}

/** One launch, mutating `meta` the way the renderer does. Returns whether the page showed. */
function launch(meta: Meta, l: Launch): boolean {
  let shown: boolean
  if (l.legacyHead) {
    // beta.15 and earlier: `lastSeen !== changelog[0].version` decided, and the
    // dismissal stamped changelog[0].version. No lastRunVersion existed.
    shown = !!meta.lastSeenVersion && meta.lastSeenVersion !== l.legacyHead
    if (shown && !l.quitBeforeAck) meta.lastSeenVersion = l.legacyHead
  } else {
    shown = decideUpgradeFlow({
      lastSeenVersion: meta.lastSeenVersion,
      lastRunVersion: lastRunVersionOf(meta),
      currentVersion: l.version,
      channel: 'beta',
    }).showWhatsNew
    // postConfigInit: record that this build ran, AFTER the decision read the previous value.
    meta.lastRunVersion = l.version
    if (shown && !l.quitBeforeAck) meta.lastSeenVersion = l.version   // markWhatsNewSeen
  }
  // Every build since 1.x: setupVersion = its own version, after the decision.
  meta.setupVersion = l.version
  return shown
}

/** Run a sequence from a meta and return the versions whose page was shown, in order. */
function run(meta: Meta, launches: Launch[]): string[] {
  const shown: string[] = []
  for (const l of launches) if (launch(meta, l)) shown.push(l.version)
  return shown
}

/** A machine that finished the tour on `v` (the tour's finish stamps lastSeenVersion). */
const settledOn = (v: string, legacy = false): Meta =>
  legacy ? { lastSeenVersion: v, setupVersion: v } : { lastSeenVersion: v, setupVersion: v, lastRunVersion: v }

describe('a version change shows the page exactly once', () => {
  it('beta to beta, with relaunches in between', () => {
    const meta = settledOn('2.1.0-beta.15')
    expect(run(meta, [
      { version: '2.1.0-beta.15' },
      { version: '2.1.0-beta.16' },
      { version: '2.1.0-beta.16' },
      { version: '2.1.0-beta.16' },
      { version: '2.1.0-beta.17' },
      { version: '2.1.0-beta.17' },
    ])).toEqual(['2.1.0-beta.16', '2.1.0-beta.17'])
  })

  it('beta, rc, final: once each, in that order', () => {
    const meta = settledOn('2.1.0-beta.16')
    expect(run(meta, [
      { version: '2.1.0-rc.1' },
      { version: '2.1.0-rc.1' },
      { version: '2.1.0' },
      { version: '2.1.0' },
    ])).toEqual(['2.1.0-rc.1', '2.1.0'])
  })

  it('THE #369 SEQUENCE: a beta.15-era build stamped the pending head, then the real beta.16 arrived', () => {
    // Release beta.15 (head == version): settled. Then a build of the beta
    // branch still versioned beta.15 whose changelog head was already beta.16
    // — the wall-of-text incident of 2026-08-21. Dismissing it stamped beta.16.
    // Then the real beta.16 installed from the offline .exe.
    const meta = settledOn('2.1.0-beta.15', true)
    expect(run(meta, [
      { version: '2.1.0-beta.15', legacyHead: '2.1.0-beta.16' },   // preview: showed (stale rule), stamped beta.16
      { version: '2.1.0-beta.16' },                                // the real beta.16: MUST show
      { version: '2.1.0-beta.16' },                                // and then settle
    ])).toEqual(['2.1.0-beta.15', '2.1.0-beta.16'])
  })

  it('an unacknowledged page comes back on the next launch, then settles', () => {
    const meta = settledOn('2.1.0-beta.15')
    expect(run(meta, [
      { version: '2.1.0-beta.16', quitBeforeAck: true },
      { version: '2.1.0-beta.16' },
      { version: '2.1.0-beta.16' },
    ])).toEqual(['2.1.0-beta.16', '2.1.0-beta.16'])
  })

  it('a downgrade shows once, and going back up shows once', () => {
    const meta = settledOn('2.1.0-beta.17')
    expect(run(meta, [
      { version: '2.1.0-beta.16' },
      { version: '2.1.0-beta.16' },
      { version: '2.1.0-beta.17' },
      { version: '2.1.0-beta.17' },
    ])).toEqual(['2.1.0-beta.16', '2.1.0-beta.17'])
  })

  it('a fresh install never sees the page until its SECOND build', () => {
    // No stamp: the tour runs instead (its finish stamps lastSeenVersion, which
    // the simulation models as the tour having settled on the first build).
    const meta: Meta = {}
    expect(run(meta, [{ version: '2.1.0-beta.16' }])).toEqual([])
    // The tour's finish.
    meta.lastSeenVersion = '2.1.0-beta.16'
    expect(run(meta, [{ version: '2.1.0-beta.16' }, { version: '2.1.0-beta.17' }, { version: '2.1.0-beta.17' }]))
      .toEqual(['2.1.0-beta.17'])
  })
})
