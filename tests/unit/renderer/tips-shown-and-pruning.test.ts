/**
 * Tips: "shown" now means SEEN, dead usage rows are pruned, and the gates that
 * were never recorded now are. Backlog items 13, 14 and 15.
 *
 * The one that mattered is 13. A tip was stamped shown when it was PICKED --
 * about two seconds after launch, whether or not anything drew it -- and a
 * stamped tip does not come back for seven days. Launch onto a page tab, or with
 * the sidebar collapsed, and the tip was burnt without a pixel of it reaching
 * the screen. Moving the trigger into the dock did not fix that; it made it
 * visible, because the count beside the row is derived from the same field.
 *
 * 14 is pruning by RULE rather than by a hand-written list of retired ids. A
 * guessed id that never existed makes a prune that cannot fire, which is worse
 * than no prune at all because it reads as though it were doing something.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const saved: Array<[string, unknown]> = []
vi.mock('../../../src/renderer/utils/config-saver', () => ({
  saveConfigNow: (k: string, v: unknown) => { saved.push([k, v]) },
}))

const {
  useTipsStore, countUnseenTips, pruneRetiredFeatures, knownFeatureIds, VIEW_FEATURE_IDS,
} = await import('../../../src/renderer/stores/tipsStore')
const { TIPS_LIBRARY } = await import('../../../src/renderer/tips-library')

const EMPTY = { features: {}, tipsShown: {}, tipsDismissed: {}, tipsActed: {} }

beforeEach(() => {
  saved.length = 0
  useTipsStore.setState({ tracking: EMPTY, currentTipId: null, silencedUntilRestart: false, isLoaded: true })
})

describe('picking a tip is not showing it', () => {
  it('pickNextTip chooses one WITHOUT stamping it shown', () => {
    useTipsStore.getState().pickNextTip()
    const s = useTipsStore.getState()
    expect(s.currentTipId).toBeTruthy()
    expect(s.tracking.tipsShown).toEqual({})
    // …and nothing was written to disk for it either.
    expect(saved).toEqual([])
  })

  it('an unseen tip stays eligible on the next launch', () => {
    useTipsStore.getState().pickNextTip()
    const first = useTipsStore.getState().currentTipId
    // A fresh launch: in-memory selection is gone, persisted tracking is not.
    const tracking = useTipsStore.getState().tracking
    useTipsStore.setState({ tracking, currentTipId: null })
    useTipsStore.getState().pickNextTip()
    // Same highest-priority tip comes back, because nothing recorded it as seen.
    expect(useTipsStore.getState().currentTipId).toBe(first)
  })

  it('markTipShown is what stamps it, and it persists', () => {
    useTipsStore.getState().pickNextTip()
    const id = useTipsStore.getState().currentTipId!
    useTipsStore.getState().markTipShown(id)
    expect(useTipsStore.getState().tracking.tipsShown[id]).toBeTypeOf('number')
    expect(saved.map(([k]) => k)).toContain('usageTracking')
  })

  it('markTipShown keeps the FIRST timestamp, so a remount cannot push the window out', () => {
    useTipsStore.setState({ tracking: { ...EMPTY, tipsShown: { 'tip.notes': 111 } } })
    useTipsStore.getState().markTipShown('tip.notes')
    expect(useTipsStore.getState().tracking.tipsShown['tip.notes']).toBe(111)
    // No write either — an idempotent no-op must not touch the disk on every render.
    expect(saved).toEqual([])
  })

  it('a shown tip drops out of the unseen count', () => {
    const before = countUnseenTips(EMPTY)
    useTipsStore.getState().pickNextTip()
    // Picked but unseen: still counted, which is the honest answer.
    expect(countUnseenTips(useTipsStore.getState().tracking)).toBe(before)
    useTipsStore.getState().markTipShown(useTipsStore.getState().currentTipId!)
    expect(countUnseenTips(useTipsStore.getState().tracking)).toBe(before - 1)
  })
})

describe('pruning usage rows for features that no longer exist', () => {
  it('drops a row nothing can write and no tip refers to', () => {
    const tracking = {
      ...EMPTY,
      features: { 'hooks.gateway-seen': { firstSeenAt: 1, lastUsedAt: 1, count: 1 } },
    }
    const out = pruneRetiredFeatures(tracking)
    expect(out.features['hooks.gateway-seen']).toBeUndefined()
    expect(saved.map(([k]) => k)).toContain('usageTracking')
  })

  it('keeps every id this build can still write', () => {
    const features: Record<string, { firstSeenAt: number; lastUsedAt: number; count: number }> = {}
    for (const id of knownFeatureIds()) features[id] = { firstSeenAt: 1, lastUsedAt: 1, count: 1 }
    const out = pruneRetiredFeatures({ ...EMPTY, features })
    expect(Object.keys(out.features).sort()).toEqual([...knownFeatureIds()].sort())
  })

  it('returns the SAME object when there is nothing to drop, so hydrate does not write', () => {
    const tracking = { ...EMPTY, features: { 'sessions.create-config': { firstSeenAt: 1, lastUsedAt: 1, count: 1 } } }
    expect(pruneRetiredFeatures(tracking)).toBe(tracking)
    expect(saved).toEqual([])
  })

  it('prunes the real-world row this was built from and keeps the live ones beside it', () => {
    // Exactly what was in usage-tracking.json on the author's machine: thirteen
    // live ids and one from the removed hooks gateway.
    const real = [
      'advanced.insights', 'advanced.log-viewer', 'agents.cloud-agent-dispatch',
      'commands.command-sections', 'commands.create-command', 'github.panel-toggled',
      'github.session-context-seen', 'github.session-enabled', 'github.signed-in',
      'hooks.gateway-seen', 'memory.memory-page', 'sessions.create-config',
      'tokenomics.dashboard', 'vision.toggle-vision',
    ]
    const features: Record<string, { firstSeenAt: number; lastUsedAt: number; count: number }> = {}
    for (const id of real) features[id] = { firstSeenAt: 1, lastUsedAt: 1, count: 1 }
    const out = pruneRetiredFeatures({ ...EMPTY, features })
    expect(Object.keys(out.features)).toHaveLength(13)
    expect(out.features['hooks.gateway-seen']).toBeUndefined()
    expect(out.features['advanced.log-viewer']).toBeDefined()
  })
})

describe('the gates the library depends on', () => {
  it('every requires/excludes id is one this build can record', () => {
    // The failure this catches: a tip gated on an id nothing writes. In
    // `requires` that tip can never show at all; in `excludes` its "you already
    // use this" variant is dead and it keeps explaining a feature you found
    // months ago. Both were live before items 13-15.
    const known = knownFeatureIds()
    const orphans: string[] = []
    for (const tip of TIPS_LIBRARY) {
      for (const f of [...(tip.requires ?? []), ...(tip.excludes ?? [])]) {
        if (!known.has(f)) orphans.push(`${tip.id} -> ${f}`)
      }
    }
    expect(orphans).toEqual([])
  })

  it('every literal trackUsage call site is an id the prune knows about', () => {
    // tipsStore's comment promises this round trip, and until now nothing
    // enforced it. It matters in the direction that is easy to get wrong: add a
    // trackUsage call, forget DIRECT_FEATURE_IDS, and the prune deletes that
    // row on the next launch -- so the feature records itself and then quietly
    // un-records itself, forever.
    const dir = path.resolve(__dirname, '../../../src/renderer')
    const files: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(e.name)) files.push(p)
      }
    }
    walk(dir)
    const known = knownFeatureIds()
    const missing: string[] = []
    let seen = 0
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8')
      for (const m of src.matchAll(/trackUsage\(\s*'([^']+)'/g)) {
        seen++
        if (!known.has(m[1])) missing.push(`${path.basename(f)} -> ${m[1]}`)
      }
    }
    // The scan itself must not be able to pass by finding nothing.
    expect(seen).toBeGreaterThan(10)
    expect(missing).toEqual([])
  })

  it('every actionTarget is a view the app can actually navigate to', () => {
    // TipCard casts actionTarget straight to ViewType and hands it to
    // onNavigate, so a plausible-looking name that is not a view -- the Feature
    // Guide is `help`, not `feature-guide` -- gives the user a button that does
    // nothing at all. TypeScript cannot catch it: the field is a string.
    //
    // 'ask-conductor' is the one CUSTOM handler key (#586): TipCard branches on
    // it BEFORE the ViewType cast and launches the Ask session instead of
    // navigating. Adding another custom key here requires adding its branch in
    // TipCard.handleAction first -- this list pins that pairing.
    const VIEWS = new Set([
      'cloud-agents', 'sessions', 'logs', 'settings', 'insights',
      'tokenomics', 'vision', 'memory', 'account-usage', 'help',
      'ask-conductor',
    ])
    const bad: string[] = []
    for (const tip of TIPS_LIBRARY) {
      for (const v of [tip.variants.primary, tip.variants.postUse]) {
        if (v?.actionTarget && !VIEWS.has(v.actionTarget)) bad.push(`${tip.id} -> ${v.actionTarget}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('no two tips share an id', () => {
    const ids = TIPS_LIBRARY.map((t) => t.id)
    expect(ids.length).toBe(new Set(ids).size)
  })

  it('the view map is the only copy of the view -> feature mapping', () => {
    // App.tsx imports this rather than holding its own. A second copy drifts,
    // and a drifted id is one the prune deletes on the next launch.
    expect(VIEW_FEATURE_IDS.memory).toBe('memory.memory-page')
    expect(VIEW_FEATURE_IDS.logs).toBe('advanced.log-viewer')
    expect(Object.values(VIEW_FEATURE_IDS).every((id) => knownFeatureIds().has(id))).toBe(true)
  })
})

describe("acknowledging a tip advances the rotation — it never hides the row (owner bug, 2026-08-24)", () => {
  // "Got it", Discuss, and the tip's action button all call markTipActed. It
  // used to null currentTipId with no successor; the dock row only renders
  // while a current tip exists, so one click hid the whole tip row for the
  // rest of the session.
  it('markTipActed on the current tip picks a successor', () => {
    useTipsStore.getState().pickNextTip()
    const first = useTipsStore.getState().currentTipId!
    useTipsStore.getState().markTipActed(first)
    const s = useTipsStore.getState()
    expect(s.tracking.tipsActed[first]).toBeTypeOf('number')
    expect(s.currentTipId).toBeTruthy() // the row lives on
    expect(s.currentTipId).not.toBe(first) // and moved past the acknowledged tip
    expect(saved.map(([k]) => k)).toContain('usageTracking')
  })

  it('goes null only when the acknowledged tip was the last eligible one', () => {
    useTipsStore.getState().pickNextTip()
    const current = useTipsStore.getState().currentTipId!
    // Every OTHER tip permanently dismissed -> nothing left to rotate to.
    const tipsDismissed = Object.fromEntries(
      TIPS_LIBRARY.filter((t) => t.id !== current).map((t) => [t.id, 1]),
    )
    useTipsStore.setState({ tracking: { ...EMPTY, tipsDismissed } })
    useTipsStore.getState().markTipActed(current)
    expect(useTipsStore.getState().currentTipId).toBeNull()
  })

  it('acting on a NON-current tip leaves the rotation alone', () => {
    // The current tip is deliberately NOT what selectNextTip would pick, so a
    // mutant that always advances lands on a DIFFERENT id and fails here — the
    // first cut used the natural successor as current and could not fail.
    useTipsStore.setState({ currentTipId: 'tip.canvas-plan-mode' })
    useTipsStore.getState().markTipActed('tip.notes')
    expect(useTipsStore.getState().currentTipId).toBe('tip.canvas-plan-mode')
  })

  it('never picks a successor through a silence, even from a state silencing cannot produce', () => {
    // silenceUntilRestart always nulls currentTipId, so current+silenced is
    // unreachable today — the guard exists for whatever produces it tomorrow.
    // Built directly, the test discriminates: without the silence term the
    // acted tip would get a successor instead of null.
    useTipsStore.setState({ currentTipId: 'tip.notes', silencedUntilRestart: true })
    useTipsStore.getState().markTipActed('tip.notes')
    expect(useTipsStore.getState().currentTipId).toBeNull()
  })

  it('using the feature a tip points at advances the rotation instead of hiding the row', () => {
    // The second vanish path: an `excludes` gate firing on a tip with no
    // postUse variant makes resolveContent null, and the dock row only renders
    // while the current tip RESOLVES. tip.memory-visualiser is exactly that
    // shape (excludes memory.memory-page, primary only).
    useTipsStore.setState({ currentTipId: 'tip.memory-visualiser' })
    useTipsStore.getState().recordUsage('memory.memory-page')
    const s = useTipsStore.getState()
    expect(s.currentTipId).toBeTruthy() // the row lives on
    expect(s.currentTipId).not.toBe('tip.memory-visualiser')
    expect(s.getCurrentTip()).not.toBeNull() // and it resolves
  })

  it('usage that does NOT unresolve the current tip leaves it alone', () => {
    useTipsStore.setState({ currentTipId: 'tip.notes' })
    useTipsStore.getState().recordUsage('memory.memory-page')
    expect(useTipsStore.getState().currentTipId).toBe('tip.notes')
  })

  it('a postUse downgrade keeps the tip current -- it swaps variant, never rotates', () => {
    // tip.notes excludes security.encrypted-notes but HAS a postUse variant, so
    // firing its excludes still resolves. A mutant that advances whenever the
    // resolved content merely CHANGES would rotate it away and fail here.
    useTipsStore.setState({ currentTipId: 'tip.notes' })
    useTipsStore.getState().recordUsage('security.encrypted-notes')
    const s = useTipsStore.getState()
    expect(s.currentTipId).toBe('tip.notes')
    expect(s.getCurrentTip()?.content).toBe(TIPS_LIBRARY.find((t) => t.id === 'tip.notes')!.variants.postUse)
  })
})
