// @vitest-environment jsdom
/**
 * The What's New feature showcase (owner design, 2026-08-24): the summary is
 * page 0 and each flagship feature of the line gets a full page behind it,
 * paged by footer dots / Next, escapable by Skip, with the harness CTA only on
 * the last page.
 *
 * What this file holds shut:
 *  - the harness contract is untouched: onNext fires exactly when the run is
 *    left (last-page CTA, or Skip), never on internal paging;
 *  - the "See it" chips only render for items whose showcase page exists, so
 *    the two curated files cannot drift into a dead button;
 *  - a line with no showcase (2.0) collapses to exactly the old single-page
 *    step — no dots, no skip, the incoming CTA label.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as any).__APP_VERSION__ = '2.1.0-rc.1'

const metaState: any = { meta: { lastSeenVersion: '2.1.0-beta.17' } }
vi.mock('../../../src/renderer/stores/appMetaStore', () => {
  const useAppMetaStore: any = (sel: any) => sel(metaState)
  useAppMetaStore.getState = () => metaState
  return { useAppMetaStore }
})

const { WhatsNewV2Step, sectionsFor } = await import('../../../src/renderer/onboarding/WhatsNewV2Step')
const { SHOWCASES_21, showcasesFor } = await import('../../../src/renderer/onboarding/showcase-pages')
const { ShowcaseVignette } = await import('../../../src/renderer/onboarding/ShowcaseVignette')

let container: HTMLDivElement
let root: Root
let nexts: number

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  nexts = 0
  metaState.meta = { lastSeenVersion: '2.1.0-beta.17' }
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const q = (id: string) => container.querySelector(`[data-ux-id="${id}"]`)
const click = (el: Element | null) => act(() => { (el as HTMLElement).click() })

function render(props: Partial<React.ComponentProps<typeof WhatsNewV2Step>> = {}) {
  act(() => {
    root.render(<WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="Nothing to set up." {...props} />)
  })
}

// ── the curated data ───────────────────────────────────────────────
describe('showcase-pages — the curated set', () => {
  it('the 2.1 line has pages; the 2.0 line has none; a future line falls back to the newest set', () => {
    expect(showcasesFor('2.1.0-rc.1').length).toBeGreaterThan(0)
    expect(showcasesFor('2.0.5')).toEqual([])
    expect(showcasesFor('2.2.0')).toEqual(SHOWCASES_21)
  })

  it('page ids are unique and every page keeps to 3-4 points', () => {
    const ids = SHOWCASES_21.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const p of SHOWCASES_21) {
      expect(p.points.length, p.id).toBeGreaterThanOrEqual(3)
      expect(p.points.length, p.id).toBeLessThanOrEqual(4)
    }
  })

  it('every seeIt on the summary resolves to a real showcase page — no dead chips', () => {
    // undefined lastSeen yields the widest summary (both section sets), and
    // the page set is the one the COMPONENT consumes (showcasesFor), not the
    // raw constant — so this pins the pair that actually renders together.
    const items = sectionsFor(undefined, '2.1.0').flatMap((s) => s.items)
    const pageIds = new Set(showcasesFor('2.1.0').map((p) => p.id))
    for (const it of items) {
      if (it.seeIt) expect(pageIds.has(it.seeIt), `seeIt "${it.seeIt}" on "${it.title}"`).toBe(true)
    }
    // And the flagships are actually linked, not merely linkable.
    const linked = items.filter((i) => i.seeIt).map((i) => i.seeIt)
    expect(linked).toContain('canvas')
    expect(linked).toContain('watchdog')
    expect(linked).toContain('oneRow')
  })
})

// ── the paged step ─────────────────────────────────────────────────
describe('WhatsNewV2Step — multi-page showcase', () => {
  it('opens on the summary, with dots and a positional hint', () => {
    render()
    expect(q('whatsnew-heading')).not.toBeNull()
    expect(q('showcase-heading')).toBeNull()
    expect(q('whatsnew-dots')).not.toBeNull()
    // Derived, not hardcoded: 1 summary + one page per flagship.
    expect(q('whatsnew-hint')!.textContent).toContain(`Page 1 of ${1 + SHOWCASES_21.length}`)
  })

  it('Next pages inward without leaving the run; the last page carries the harness CTA', () => {
    render()
    const cta = () => q('whatsnew-cta')!
    expect(cta().textContent).toContain('Next')
    click(cta()) // -> the first flagship
    expect(nexts).toBe(0)
    expect(q(`showcase-page-${SHOWCASES_21[0].id}`)).not.toBeNull()
    expect(q('showcase-eyebrow')!.textContent).toContain(`1 of ${SHOWCASES_21.length}`)
    for (let i = 1; i < SHOWCASES_21.length; i++) click(cta()) // -> walk to the last
    expect(q(`showcase-page-${SHOWCASES_21[SHOWCASES_21.length - 1].id}`)).not.toBeNull()
    expect(cta().textContent).toBe('Continue')
    expect(q('whatsnew-hint')!.textContent).toBe('Nothing to set up.')
    expect(q('whatsnew-skip'), 'skip duplicates the CTA on the last page').toBeNull()
    expect(nexts).toBe(0)
    click(cta())
    expect(nexts).toBe(1)
  })

  it('a "See it" chip jumps straight to its page', () => {
    render()
    click(q('see-watchdog'))
    expect(q('showcase-page-watchdog')).not.toBeNull()
    const ix = SHOWCASES_21.findIndex((pg: { id: string }) => pg.id === 'watchdog')
    expect(q('showcase-eyebrow')!.textContent).toContain(`${ix + 1} of ${SHOWCASES_21.length}`)
    expect(nexts).toBe(0)
  })

  it('the dots jump anywhere, including back to the summary', () => {
    render()
    click(q('whatsnew-dot-oneRow'))
    expect(q('showcase-page-oneRow')).not.toBeNull()
    click(q('whatsnew-dot-summary'))
    expect(q('whatsnew-heading')).not.toBeNull()
    expect(nexts).toBe(0)
  })

  it('Skip leaves the run from an inner page', () => {
    render()
    click(q('whatsnew-cta')) // -> canvas
    click(q('whatsnew-skip'))
    expect(nexts).toBe(1)
  })

  it('each showcase page draws its vignette', () => {
    render()
    click(q('whatsnew-dot-canvas'))
    expect(q('showcase-art-canvas')).not.toBeNull()
    click(q('whatsnew-dot-watchdog'))
    expect(q('showcase-art-watchdog')).not.toBeNull()
    click(q('whatsnew-dot-oneRow'))
    expect(q('showcase-art-oneRow')).not.toBeNull()
  })

  it('a chip renders ONLY when its showcase page exists — the anti-drift guard', async () => {
    // Serve a page set holding only the canvas page: the summary still carries
    // seeIt ids for watchdog and oneRow, so an unguarded chip would render for
    // pages that cannot be jumped to. Deleting the `showcases.some` guard in
    // WhatsNewV2Step fails this test.
    vi.resetModules()
    vi.doMock('../../../src/renderer/onboarding/showcase-pages', async (importOriginal) => {
      const real: any = await importOriginal()
      return { ...real, showcasesFor: () => real.SHOWCASES_21.filter((p: any) => p.id === 'canvas') }
    })
    try {
      const fresh = await import('../../../src/renderer/onboarding/WhatsNewV2Step')
      act(() => {
        root.render(<fresh.WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="h" />)
      })
      expect(container.querySelector('[data-ux-id="see-canvas"]')).not.toBeNull()
      expect(container.querySelector('[data-ux-id="see-watchdog"]')).toBeNull()
      expect(container.querySelector('[data-ux-id="see-oneRow"]')).toBeNull()
    } finally {
      // resetModules does NOT clear the mock registry — without the unmock a
      // failed assertion above would leak the reduced page set into the next
      // test's fresh import and fail it with a misleading message.
      vi.doUnmock('../../../src/renderer/onboarding/showcase-pages')
      vi.resetModules()
    }
  })

  it('a line with no showcase collapses to the old single-page step', async () => {
    vi.resetModules()
    ;(globalThis as any).__APP_VERSION__ = '2.0.5'
    const fresh = await import('../../../src/renderer/onboarding/WhatsNewV2Step')
    act(() => {
      root.render(<fresh.WhatsNewV2Step onNext={() => { nexts++ }} ctaLabel="Continue" hint="Nothing to set up." />)
    })
    expect(container.querySelector('[data-ux-id="whatsnew-dots"]')).toBeNull()
    expect(container.querySelector('[data-ux-id="whatsnew-skip"]')).toBeNull()
    const cta = container.querySelector('[data-ux-id="whatsnew-cta"]')!
    expect(cta.textContent).toBe('Continue')
    click(cta)
    expect(nexts).toBe(1)
    ;(globalThis as any).__APP_VERSION__ = '2.1.0-rc.1'
    vi.resetModules()
  })
})

// ── #463: the showcase tours everything since 2.0, for both audiences ──
describe('#463 — since-2.0 coverage and the first-run cohort', () => {
  it('the flagship set covers the full 2.1-over-2.0 story, canvas first', () => {
    const ids = SHOWCASES_21.map((p) => p.id)
    for (const flagship of ['canvas', 'oneRow', 'panel', 'accounts', 'watchdog']) {
      expect(ids, `missing flagship page "${flagship}"`).toContain(flagship)
    }
    expect(ids[0]).toBe('canvas')
  })

  it('no heading or tagline uses upgrade-only diff framing a first-runner cannot parse', () => {
    // "Three rows became one" reads as gibberish to someone who never saw
    // three rows. A tripwire, not a proof: it catches the phrasings that have
    // actually slipped in ("became", "grew", "used to", "no longer", "now X"
    // comparatives) — review still owns the judgment call.
    for (const p of SHOWCASES_21) {
      const copy = `${p.heading} ${p.tagline}`.toLowerCase()
      for (const phrase of ['became', 'grew', 'used to', 'no longer', 'renamed']) {
        expect(copy, `${p.id}: "${phrase}"`).not.toContain(phrase)
      }
    }
  })

  it('every showcase page\'s art kind renders a drawn vignette', () => {
    for (const p of SHOWCASES_21) {
      act(() => { root.render(<ShowcaseVignette kind={p.art} />) })
      expect(
        container.querySelector(`[data-ux-id="showcase-art-${p.art}"]`),
        `no vignette rendered for art kind "${p.art}"`,
      ).toBeTruthy()
    }
  })

  it('the fresh cohort gets an introduction heading and the FULL story, not a diff', () => {
    metaState.meta = {}
    render({ fresh: true })
    expect(q('whatsnew-heading')!.textContent).toContain("What you're getting")
    expect(q('whatsnew-heading')!.textContent).not.toContain("What's new")
    const text = container.textContent!
    // One item from the 2.0 set and one from the 2.1 set — both present,
    // because a first-runner missed everything.
    expect(text).toContain('Guided setup.')
    expect(text).toContain('Agent Canvas.')
    // ...but a line that only makes sense against a BEFORE stays out.
    expect(text).not.toContain('New name.')
  })

  it('no upgrade-only line carries a See-it link — the fresh page count must not desync', () => {
    // The sub-line says "N of them have a page of their own"; an upgradeOnly
    // item with a seeIt would make that true for upgraders and false for the
    // fresh cohort, silently.
    for (const s2 of sectionsFor(undefined, '2.1.0')) {
      for (const it2 of s2.items) {
        expect(!(it2.upgradeOnly && it2.seeIt), `${it2.title} is upgradeOnly with a seeIt`).toBe(true)
      }
    }
  })

  it('the upgrader still sees the upgrade-only lines', () => {
    render()
    expect(container.textContent).toContain('New name.')
  })

  it('an upgrader keeps the diff heading — fresh framing never leaks', () => {
    render()
    expect(q('whatsnew-heading')!.textContent).toContain("What's new in 2.1")
  })
})
