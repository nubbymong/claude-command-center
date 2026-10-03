// @vitest-environment jsdom
// P3.15 round 1 (a review nit): a tip about one operating system is offered
// only there. A tip may name its platforms; the tip store offers it only when
// the app runs on one of them (and a tip that names none, everywhere).
import { describe, it, expect, afterEach } from 'vitest'
import { TIPS_LIBRARY } from '../../../src/renderer/tips-library'
import { countUnseenTips, type UsageTracking } from '../../../src/renderer/stores/tipsStore'
import type { TipPlatform } from '../../../src/renderer/tips-library'

const w = window as unknown as { electronPlatform?: string }
const before = w.electronPlatform
afterEach(() => { w.electronPlatform = before })

/** Every feature any tip requires, done: every tip's content resolves. */
const used = { firstSeenAt: 1, lastUsedAt: 1, count: 1 }
const allDone: UsageTracking = {
  features: Object.fromEntries(TIPS_LIBRARY.flatMap((t) => t.requires ?? []).map((f) => [f, used])),
  tipsShown: {},
  tipsDismissed: {},
  tipsActed: {},
}
/** Whether a tip's content resolves for `allDone` (its requires and excludes). */
const resolves = (t: (typeof TIPS_LIBRARY)[number]): boolean => {
  const done = allDone.features
  if (t.excludes?.some((f) => !!done[f])) return !!t.variants.postUse
  return (t.requires ?? []).every((f) => !!done[f])
}
/** The tips the store should offer on platform `p`. */
const offered = (p: TipPlatform) => TIPS_LIBRARY.filter((t) => resolves(t) && (!t.platforms || t.platforms.includes(p))).length

describe('tips for one operating system', () => {
  it('there is at least one, and each names real platforms', () => {
    const named = TIPS_LIBRARY.filter((t) => t.platforms)
    expect(named.length).toBeGreaterThan(0)
    for (const t of named) {
      expect(t.platforms!.length, t.id).toBeGreaterThan(0)
      for (const p of t.platforms!) expect(['win32', 'darwin', 'linux'], t.id).toContain(p)
    }
  })

  it('is offered only on its platforms', () => {
    w.electronPlatform = 'win32'
    const win = countUnseenTips(allDone)
    w.electronPlatform = 'darwin'
    const mac = countUnseenTips(allDone)
    w.electronPlatform = 'linux'
    const linux = countUnseenTips(allDone)
    expect(win).toBe(offered('win32'))
    expect(mac).toBe(offered('darwin'))
    expect(linux).toBe(offered('linux'))
    expect(mac).toBeLessThan(win)
  })
})
