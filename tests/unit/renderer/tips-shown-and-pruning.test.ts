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

  it('the view map is the only copy of the view -> feature mapping', () => {
    // App.tsx imports this rather than holding its own. A second copy drifts,
    // and a drifted id is one the prune deletes on the next launch.
    expect(VIEW_FEATURE_IDS.memory).toBe('memory.memory-page')
    expect(VIEW_FEATURE_IDS.logs).toBe('advanced.log-viewer')
    expect(Object.values(VIEW_FEATURE_IDS).every((id) => knownFeatureIds().has(id))).toBe(true)
  })
})
