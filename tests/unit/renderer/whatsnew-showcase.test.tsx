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
    // undefined lastSeen yields the widest summary (both section sets).
    const items = sectionsFor(undefined, '2.1.0').flatMap((s) => s.items)
    const pageIds = new Set(SHOWCASES_21.map((p) => p.id))
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
    expect(q('whatsnew-hint')!.textContent).toContain('Page 1 of 4')
  })

  it('Next pages inward without leaving the run; the last page carries the harness CTA', () => {
    render()
    const cta = () => q('whatsnew-cta')!
    expect(cta().textContent).toContain('Next')
    click(cta()) // -> canvas
    expect(nexts).toBe(0)
    expect(q('showcase-page-canvas')).not.toBeNull()
    expect(q('showcase-eyebrow')!.textContent).toContain('1 of 3')
    click(cta()) // -> watchdog
    click(cta()) // -> oneRow (last)
    expect(q('showcase-page-oneRow')).not.toBeNull()
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
    expect(q('showcase-eyebrow')!.textContent).toContain('2 of 3')
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
