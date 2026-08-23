// @vitest-environment jsdom
/**
 * The tip card after #361 (owner's pick C: anchored card, not a modal).
 *
 * What this file holds shut:
 *
 *  - **The card must not block the app.** The old shape was a modal with a
 *    dimmed backdrop, so a TIP cost the user their terminal. The card renders
 *    no overlay at all — nothing with `data-dialog-overlay`, no `aria-modal` —
 *    and a stray click anywhere outside it does nothing. That also retires the
 *    Ctrl+C-fires-click trap by construction: there is no backdrop to eat the
 *    dialog.
 *  - **Five actions on one row wrapped every label** (the original bug). The
 *    contract that makes wrapping impossible: three buttons in the footer, the
 *    two "stop showing me this" actions under the ⋯ in the header, every
 *    visible label nowrap, and a footer that is not allowed to wrap.
 *  - **"Next tip" advances in place.** The modal closed on Next, which read as
 *    the button doing nothing. The card stays up and shows the next tip; when
 *    the rotation runs dry it closes itself.
 *  - **Anchoring falls back sanely.** No pill in the DOM (dock hidden, jsdom)
 *    must mean the bottom-left corner, not 0,0.
 *  - **`bg-mauve … text-base`** — Tailwind resolves `text-*` as a font SIZE
 *    first; the E5 primitives own button colour now (`--text-on-brand`).
 *  - **Emoji as iconography** — the card shares the dock's stroked lightbulb.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))

const { default: TipCard } = await import('../../../src/renderer/components/TipCard')
const { useTipsStore, countUnseenTips } = await import('../../../src/renderer/stores/tipsStore')
const { TIPS_LIBRARY } = await import('../../../src/renderer/tips-library')

const SRC = path.resolve(__dirname, '../../../src/renderer')
/** Comments stripped, so prose ABOUT a retired class is not a finding — the
 *  same rule `dialog-palette-retired.test.ts` uses, and the reason this file
 *  can explain the bugs it guards without tripping over its own explanation. */
const read = (p: string) =>
  fs.readFileSync(path.join(SRC, p), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

const EMPTY = { features: {}, tipsShown: {}, tipsDismissed: {}, tipsActed: {} }
/** A tip with no `requires`/`excludes`, so it resolves with no usage history. */
const FREE_TIPS = TIPS_LIBRARY.filter((t) => !t.requires?.length && !t.excludes?.length)

let container: HTMLDivElement
let root: Root
let closed: number

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  closed = 0
  useTipsStore.setState({ tracking: EMPTY, currentTipId: null, silencedUntilRestart: false, isLoaded: true })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  document.querySelectorAll('[data-ux-id="sidebar-tip-pill"]').forEach((el) => el.remove())
})

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)

/** Arm a tip and put the card on screen. */
function open(tip = FREE_TIPS[0]) {
  expect(tip, 'the library must contain at least one unconditional tip').toBeDefined()
  useTipsStore.setState({ currentTipId: tip.id })
  act(() => { root.render(<TipCard onClose={() => { closed++ }} />) })
  expect(q('tip-card'), 'the card must render').not.toBeNull()
  return tip
}

const mouse = (el: Element, type: string, init: MouseEventInit = {}) =>
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })) })

/** jsdom's innerWidth/innerHeight are getter-only; tests that assert anchor
 *  math pin them explicitly rather than relying on jsdom's 1024×768. */
function setWindowSize(w: number, h: number) {
  Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true })
  Object.defineProperty(window, 'innerHeight', { value: h, configurable: true, writable: true })
}

describe('tip card -- does not block the app', () => {
  it('renders no overlay and no aria-modal', () => {
    open()
    expect(document.querySelector('[data-dialog-overlay]')).toBeNull()
    expect(document.querySelector('[aria-modal]')).toBeNull()
  })

  it('a click outside the card does nothing', () => {
    open()
    mouse(document.body, 'click')
    mouse(document.body, 'mousedown', { button: 0 })
    expect(closed).toBe(0)
    expect(q('tip-card')).not.toBeNull()
  })

  it('is position: fixed, so it floats over the content it does not block', () => {
    open()
    expect(q('tip-card')!.className).toContain('fixed')
  })
})

describe('tip card -- anchoring', () => {
  it('with no pill in the DOM it sits in the bottom-left corner, not at 0,0', () => {
    open()
    const style = (q('tip-card') as HTMLElement).style
    expect(style.left).toBe('12px')
    expect(style.bottom).toBe('12px')
  })

  it('with a pill it opens to the right of it, bottom-aligned', () => {
    const pill = document.createElement('button')
    pill.setAttribute('data-ux-id', 'sidebar-tip-pill')
    // jsdom has no layout; hand the pill the rect the sidebar would give it.
    pill.getBoundingClientRect = () =>
      ({ left: 8, right: 264, top: 700, bottom: 740, width: 256, height: 40, x: 8, y: 700, toJSON: () => ({}) }) as DOMRect
    document.body.appendChild(pill)
    setWindowSize(1280, 800)
    open()
    const style = (q('tip-card') as HTMLElement).style
    expect(style.left).toBe(`${264 + 10}px`)
    expect(style.bottom).toBe(`${800 - 740}px`)
  })

  it('clamps to the window when the pill sits too far right', () => {
    const pill = document.createElement('button')
    pill.setAttribute('data-ux-id', 'sidebar-tip-pill')
    pill.getBoundingClientRect = () =>
      ({ left: 1000, right: 1240, top: 700, bottom: 740, width: 240, height: 40, x: 1000, y: 700, toJSON: () => ({}) }) as DOMRect
    document.body.appendChild(pill)
    setWindowSize(1280, 800)
    open()
    // 1240 + 10 would push a 400px card past the right edge; it clamps back.
    expect((q('tip-card') as HTMLElement).style.left).toBe(`${1280 - 400 - 12}px`)
  })
})

describe('tip card -- the ways out', () => {
  it('Escape closes', () => {
    open()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(closed).toBe(1)
  })

  it('the close glyph closes', () => {
    open()
    act(() => { (q('tip-card-close') as HTMLButtonElement).click() })
    expect(closed).toBe(1)
  })

  it('closes itself when the rotation runs dry (currentTipId goes null)', () => {
    open()
    act(() => { useTipsStore.setState({ currentTipId: null }) })
    expect(closed).toBe(1)
  })
})

describe('tip card -- Next advances in place', () => {
  it('shows the next tip without closing', () => {
    const tip = open()
    act(() => { (q('tip-card-next') as HTMLButtonElement).click() })
    expect(closed).toBe(0)
    expect(q('tip-card')).not.toBeNull()
    const after = useTipsStore.getState().currentTipId
    expect(after, 'a fresh library must have a second tip to advance to').not.toBeNull()
    expect(after).not.toBe(tip.id)
  })

  it('stamps each tip it draws as shown (idempotently)', () => {
    const tip = open()
    expect(useTipsStore.getState().tracking.tipsShown[tip.id]).toBeTypeOf('number')
    act(() => { (q('tip-card-next') as HTMLButtonElement).click() })
    const nextId = useTipsStore.getState().currentTipId!
    expect(useTipsStore.getState().tracking.tipsShown[nextId]).toBeTypeOf('number')
  })

  it('the unseen counter reads from live tracking and hides at zero', () => {
    open()
    // The card stamped the current tip on mount, so the header counts the rest.
    const unseen = countUnseenTips(useTipsStore.getState().tracking)
    if (unseen > 0) {
      expect(q('tip-card-unseen')!.textContent).toBe(`${unseen} more you have not seen`)
    }
    // Stamp everything: the counter line must disappear rather than say "0 more".
    act(() => {
      const now = Date.now()
      useTipsStore.setState((s) => ({
        tracking: { ...s.tracking, tipsShown: Object.fromEntries(TIPS_LIBRARY.map((t) => [t.id, now])) },
      }))
    })
    expect(q('tip-card-unseen')).toBeNull()
  })
})

describe('tip card -- the footer cannot wrap (the headline bug)', () => {
  it('carries three action buttons, not five', () => {
    open()
    const footer = q('tip-card-footer')!
    const labelled = [...footer.querySelectorAll('button')].filter((b) => b.textContent!.trim() !== '')
    expect(labelled.map((b) => b.textContent!.trim())).toHaveLength(3)
  })

  it('every visible footer label is nowrap', () => {
    open()
    const footer = q('tip-card-footer')!
    for (const b of footer.querySelectorAll('button')) {
      expect(b.className, `"${b.textContent}" may wrap`).toContain('whitespace-nowrap')
    }
  })

  it('the footer row itself is not allowed to wrap', () => {
    open()
    const footer = q('tip-card-footer')!
    expect(footer.className).toContain('flex')
    expect(footer.className).not.toContain('flex-wrap')
  })
})

describe('tip card -- the "stop showing me this" actions live under the header ⋯', () => {
  it('they are in the header menu, not the footer', () => {
    open()
    expect(q('tip-card-footer')!.textContent).not.toContain('Silence until restart')
    expect(q('tip-card-overflow-menu')).toBeNull()
    expect(q('tip-card-header')!.contains(q('tip-card-overflow'))).toBe(true)
    act(() => { (q('tip-card-overflow') as HTMLButtonElement).click() })
    const menu = q('tip-card-overflow-menu')!
    expect(menu.textContent).toContain('Silence until restart')
    expect(menu.textContent).toContain("Don't show this again")
    for (const item of menu.querySelectorAll('button')) {
      expect(item.className).toContain('whitespace-nowrap')
    }
  })

  it('"Silence until restart" still silences', () => {
    open()
    act(() => { (q('tip-card-overflow') as HTMLButtonElement).click() })
    act(() => { (q('tip-card-silence') as HTMLButtonElement).click() })
    expect(useTipsStore.getState().silencedUntilRestart).toBe(true)
    expect(closed).toBeGreaterThanOrEqual(1)
  })

  it('"Don\'t show this again" still dismisses the tip for good', () => {
    const tip = open()
    act(() => { (q('tip-card-overflow') as HTMLButtonElement).click() })
    act(() => { (q('tip-card-never') as HTMLButtonElement).click() })
    expect(useTipsStore.getState().tracking.tipsDismissed[tip.id]).toBeTypeOf('number')
    expect(closed).toBeGreaterThanOrEqual(1)
  })

  it('the menu closes on mousedown, not on click, and never closes the card', () => {
    open()
    act(() => { (q('tip-card-overflow') as HTMLButtonElement).click() })
    mouse(q('tip-card-overflow-backdrop')!, 'click')
    expect(q('tip-card-overflow-menu')).not.toBeNull()
    mouse(q('tip-card-overflow-backdrop')!, 'mousedown', { button: 0 })
    expect(q('tip-card-overflow-menu')).toBeNull()
    expect(closed, 'dismissing the menu must not dismiss the card').toBe(0)
  })

  it('a right-click on the menu backdrop dismisses the menu inertly, swallowed', () => {
    open()
    act(() => { (q('tip-card-overflow') as HTMLButtonElement).click() })
    mouse(q('tip-card-overflow-backdrop')!, 'mousedown', { button: 2 })
    expect(q('tip-card-overflow-menu'), 'a right-button mousedown must not dismiss').not.toBeNull()
    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    act(() => { q('tip-card-overflow-backdrop')!.dispatchEvent(evt) })
    expect(q('tip-card-overflow-menu')).toBeNull()
    expect(evt.defaultPrevented).toBe(true)
    expect(closed).toBe(0)
  })
})

describe('tip card -- the look', () => {
  const src = read('components/TipCard.tsx')

  it('draws marks, never emoji', () => {
    expect(src.match(/\p{Extended_Pictographic}/gu) ?? []).toEqual([])
    // ...and the ban on `\u{...}` escapes in JSX (esbuild) is not worked around.
    expect(src).not.toMatch(/\\u\{/)
  })

  it("shares the dock's stroked lightbulb rather than drawing its own", () => {
    expect(src).toMatch(/LightbulbMark/)
    expect(read('components/sidebar/AskConductorDock.tsx')).toMatch(
      /import \{ LightbulbMark \} from '\.\.\/ui\/LightbulbMark'/,
    )
  })

  it('keeps the tips accent peach, and does not reach for the retired palette', () => {
    expect(src).toContain('var(--accent-tip)')
    for (const retired of ['text-mauve', 'bg-mauve', 'hover:bg-pink', 'bg-mantle', 'border-surface0', 'text-subtext0', 'text-overlay0', 'bg-black/60']) {
      expect(src, `${retired} is retired`).not.toContain(retired)
    }
    // `text-base` is the size-and-colour trap, not a colour at all.
    expect(src).not.toMatch(/className="[^"]*\btext-base\b/)
  })

  it('the accent is a theme token defined in both themes', () => {
    const css = fs.readFileSync(path.join(SRC, 'styles.css'), 'utf8')
    expect([...css.matchAll(/--accent-tip:\s*#[0-9a-f]{6};/g)]).toHaveLength(2)
  })
})

describe('tip copy', () => {
  const lib = read('tips-library.ts')

  it('names the Browser button by its current label', () => {
    expect(lib).not.toContain('Snap and Web')
    expect(lib).toContain('beside Browser')
  })

  it('carries no emoji in any headline -- the lightbulb is the only mark', () => {
    for (const tip of TIPS_LIBRARY) {
      for (const content of [tip.variants.primary, tip.variants.postUse]) {
        if (!content) continue
        expect(content.shortText.match(/\p{Extended_Pictographic}/gu) ?? [], tip.id).toEqual([])
        // A headline that starts with punctuation is the tell that a mark was
        // stripped but its separator was left behind.
        expect(content.shortText, tip.id).toMatch(/^[A-Za-z0-9]/)
      }
    }
  })

  it('keeps headlines inside what two clamped lines of the dock row can hold', () => {
    // ~30 characters per line at 11px in a 256px rail, minus the mark and the
    // counter badge. The ceiling is deliberately generous: #377 is the content
    // pass, this only has to prove the layout is not being handed something no
    // layout could show.
    const CEILING = 64
    const over = TIPS_LIBRARY
      .flatMap((t) => [t.variants.primary, t.variants.postUse].filter(Boolean))
      .map((c) => c!.shortText)
      .filter((s) => s.length > CEILING)
    expect(over).toEqual([])
  })
})
