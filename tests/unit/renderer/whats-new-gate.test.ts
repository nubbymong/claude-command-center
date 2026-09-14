// The version a user has "seen" is the version they RAN — not the newest entry
// authored in the changelog.
//
// This pins the 2026-08-21 fix. The pending changelog entry is written BEFORE
// the version bump (AGENTS.md: the accumulator entry is edited, not added, when
// a beta is cut), so on every dev build, every preview build, and every build
// between two releases, `changelog[0].version` is AHEAD of the version actually
// running. Keying the gate on it meant:
//
//   - a machine running beta.15 read as a "within-line upgrade to beta.16",
//     which showed release notes it had already shown, on every launch; and
//   - dismissing them stamped `lastSeenVersion = beta.16`, a version the user
//     had never run, so the REAL beta.16 would later read `same-version` and
//     show nothing at all.
//
// Both assertions below are green against the current code and RED against the
// changelog-keyed version — verified by mutation, not assumed.

import { describe, it, expect, vi, beforeEach } from 'vitest'

// The build under test. The changelog head deliberately sits one release AHEAD
// of it: exactly the shape of every unreleased build.
;(globalThis as any).__APP_VERSION__ = '2.1.0-beta.15'

vi.mock('../../../src/renderer/changelog', () => ({
  changelog: [
    { version: '2.1.0-beta.16', date: '2026-08-21', changes: [{ type: 'feature', description: 'Not shipped yet' }] },
    { version: '2.1.0-beta.15', date: '2026-08-19', changes: [{ type: 'feature', description: 'The running build' }] },
    { version: '2.1.0-beta.14', date: '2026-08-18', changes: [{ type: 'fix', description: 'Older' }] },
  ],
}))

const metaState: any = { meta: {}, update: vi.fn((patch: any) => Object.assign(metaState.meta, patch)) }
vi.mock('../../../src/renderer/stores/appMetaStore', () => {
  const useAppMetaStore: any = (sel: any) => sel(metaState)
  useAppMetaStore.getState = () => metaState
  return { useAppMetaStore }
})

const settingsState: any = { settings: { updateChannel: 'beta' } }
vi.mock('../../../src/renderer/stores/settingsStore', () => {
  const useSettingsStore: any = (sel: any) => sel(settingsState)
  useSettingsStore.getState = () => settingsState
  return { useSettingsStore }
})

const { shouldShowWhatsNew, markWhatsNewSeen, runningVersion, seenVersion } = await import(
  '../../../src/renderer/onboarding/whats-new-gate'
)

beforeEach(() => {
  metaState.meta = {}
  metaState.update.mockClear()
})

describe('whats-new gate is keyed on the RUNNING version', () => {
  it('reports the running version, not the newest changelog entry', () => {
    expect(runningVersion()).toBe('2.1.0-beta.15')
  })

  it('does NOT show notes to someone already on the build they last ran', () => {
    // THE REPORTED BUG. lastSeen === the running build, so there is nothing new
    // — but the old rule compared against changelog[0] (beta.16) and returned
    // true, which is what opened the wall-of-text modal on a preview build.
    metaState.meta.lastSeenVersion = '2.1.0-beta.15'
    expect(shouldShowWhatsNew()).toBe(false)
  })

  it('still shows notes to someone arriving from an older build', () => {
    // The guard above must not be a blanket "never show": a genuine upgrade
    // still gets its notes.
    metaState.meta.lastSeenVersion = '2.1.0-beta.14'
    expect(shouldShowWhatsNew()).toBe(true)
  })

  it('stamps the version that was RUN, never the unreleased changelog head', () => {
    // The second half of the bug: stamping beta.16 from a beta.15 build left
    // the meta file claiming a version the user had never seen, which would
    // have suppressed the notes on the real beta.16.
    markWhatsNewSeen()
    expect(metaState.meta.lastSeenVersion).toBe('2.1.0-beta.15')
    expect(metaState.meta.lastSeenVersion).not.toBe('2.1.0-beta.16')
  })

  it('is idempotent: stamping then re-asking shows nothing', () => {
    markWhatsNewSeen()
    expect(shouldShowWhatsNew()).toBe(false)
  })
})

describe('#369 — a stamp no build of that version wrote does not suppress the page', () => {
  // The owner's machine at the first launch of the real beta.16: a beta.15-era
  // build had stamped lastSeenVersion = beta.16 from the pending changelog
  // head, while setupVersion — stamped by every build with its own version —
  // still said beta.15. The running build here is beta.15 (the file's pin), so
  // the same shape is: stamp == running build, last run == one older.
  it('shows the page when the stamp equals the running build but setupVersion says an older build ran last', () => {
    metaState.meta.lastSeenVersion = '2.1.0-beta.15'
    metaState.meta.setupVersion = '2.1.0-beta.14'
    expect(shouldShowWhatsNew()).toBe(true)
  })

  it('lastRunVersion outranks setupVersion as the witness', () => {
    metaState.meta.lastSeenVersion = '2.1.0-beta.15'
    metaState.meta.setupVersion = '2.1.0-beta.14'     // stale: setup never re-stamped
    metaState.meta.lastRunVersion = '2.1.0-beta.15'   // but this build has run and stamped
    expect(shouldShowWhatsNew()).toBe(false)
  })

  it('a relaunch after acknowledging on this build shows nothing', () => {
    metaState.meta.lastSeenVersion = '2.1.0-beta.15'
    metaState.meta.setupVersion = '2.1.0-beta.15'
    metaState.meta.lastRunVersion = '2.1.0-beta.15'
    expect(shouldShowWhatsNew()).toBe(false)
  })

  it('seenVersion() is the stamp clamped to what actually ran — what the harness diffs against', () => {
    metaState.meta.lastSeenVersion = '2.1.0-beta.15'
    metaState.meta.setupVersion = '2.1.0-beta.14'
    expect(seenVersion()).toBe('2.1.0-beta.14')
    metaState.meta.lastRunVersion = '2.1.0-beta.15'
    expect(seenVersion()).toBe('2.1.0-beta.15')
  })
})
