// @vitest-environment jsdom
/**
 * The tip dialog after #361.
 *
 * Four regressions this file exists to hold shut, each of which shipped once:
 *
 *  - **The backdrop closed on CLICK.** Ctrl+C in a terminal fires click events,
 *    so the dialog vanished under people who were copying text. Dismissal is on
 *    mousedown, on the backdrop itself, and never for a context-menu gesture.
 *  - **Five actions on one 512px footer row with nothing nowrap**, so every
 *    label folded in half. jsdom has no layout, so what is checkable is the
 *    contract that makes wrapping impossible: three buttons in the row, the two
 *    "stop showing me this" actions in an overflow menu, every visible label
 *    nowrap, and a footer that is not allowed to wrap.
 *  - **`bg-mauve … text-base`** — Tailwind resolves `text-*` as a font SIZE
 *    first, so the primary button's "colour" was 16px text. The primitives own
 *    the colour now (`--text-on-brand`), and the #360 palette scan polices the
 *    file for real; the assertions here name the specific classes so a
 *    regression reads as itself rather than as a generic scan failure.
 *  - **Emoji as iconography.** The dialog drew 💡 and 📍 while the dock drew a
 *    stroked lightbulb, so the two halves of one feature did not match.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn() }))

const { default: TipModal } = await import('../../../src/renderer/components/TipModal')
const { useTipsStore } = await import('../../../src/renderer/stores/tipsStore')
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
})

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)

/** Arm a tip and put the dialog on screen. */
function open(tip = FREE_TIPS[0]) {
  expect(tip, 'the library must contain at least one unconditional tip').toBeDefined()
  useTipsStore.setState({ currentTipId: tip.id })
  act(() => { root.render(<TipModal onClose={() => { closed++ }} />) })
  expect(q('tip-modal'), 'the dialog must render').not.toBeNull()
  return tip
}

const mouse = (el: Element, type: string, init: MouseEventInit = {}) =>
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })) })

describe('tip dialog -- the backdrop never eats the dialog on a click', () => {
  it('a CLICK on the backdrop does nothing', () => {
    open()
    mouse(q('tip-modal-overlay')!, 'click')
    expect(closed).toBe(0)
  })

  it('a MOUSEDOWN on the backdrop dismisses', () => {
    open()
    mouse(q('tip-modal-overlay')!, 'mousedown', { button: 0 })
    expect(closed).toBe(1)
  })

  it('a mousedown that lands on the panel does NOT dismiss', () => {
    open()
    // The panel is a CHILD of the overlay here (unlike the bar's popovers,
    // whose backdrop is an empty sibling), so the event bubbles to the same
    // handler. Without the target check the dialog closes under the pointer.
    mouse(q('tip-modal')!, 'mousedown', { button: 0 })
    expect(closed).toBe(0)
  })

  it('a right-click on the backdrop does not dismiss on mousedown', () => {
    open()
    // If it did, the backdrop would be gone before the contextmenu event and
    // the gesture would land on the terminal underneath, where it pastes.
    mouse(q('tip-modal-overlay')!, 'mousedown', { button: 2 })
    expect(closed).toBe(0)
  })

  it('...and the contextmenu that follows dismisses inertly, swallowed', () => {
    open()
    const overlay = q('tip-modal-overlay')!
    const evt = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    act(() => { overlay.dispatchEvent(evt) })
    expect(closed).toBe(1)
    expect(evt.defaultPrevented).toBe(true)
  })
})

describe('tip dialog -- the other two ways out still work', () => {
  it('Escape closes', () => {
    open()
    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(closed).toBe(1)
  })

  it('the close glyph closes', () => {
    open()
    act(() => { (q('tip-modal-close') as HTMLButtonElement).click() })
    expect(closed).toBe(1)
  })
})

describe('tip dialog -- the footer cannot wrap (the headline bug)', () => {
  it('carries three action buttons, not five', () => {
    open()
    const footer = q('tip-modal-footer')!
    const labelled = [...footer.querySelectorAll('button')].filter((b) => b.textContent!.trim() !== '')
    expect(labelled.map((b) => b.textContent!.trim())).toHaveLength(3)
  })

  it('every visible footer label is nowrap', () => {
    open()
    const footer = q('tip-modal-footer')!
    for (const b of footer.querySelectorAll('button')) {
      expect(b.className, `"${b.textContent}" may wrap`).toContain('whitespace-nowrap')
    }
  })

  it('the footer row itself is not allowed to wrap', () => {
    open()
    const footer = q('tip-modal-footer')!
    expect(footer.className).toContain('flex')
    expect(footer.className).not.toContain('flex-wrap')
  })

  it('the two "stop showing me this" actions are in the overflow, not the row', () => {
    open()
    expect(q('tip-modal-footer')!.textContent).not.toContain('Silence until restart')
    expect(q('tip-modal-overflow-menu')).toBeNull()
    act(() => { (q('tip-modal-overflow') as HTMLButtonElement).click() })
    const menu = q('tip-modal-overflow-menu')!
    expect(menu.textContent).toContain('Silence until restart')
    expect(menu.textContent).toContain("Don't show this again")
    for (const item of menu.querySelectorAll('button')) {
      expect(item.className).toContain('whitespace-nowrap')
    }
  })

  it('"Silence until restart" still silences, from the overflow', () => {
    open()
    act(() => { (q('tip-modal-overflow') as HTMLButtonElement).click() })
    act(() => { (q('tip-modal-silence') as HTMLButtonElement).click() })
    expect(useTipsStore.getState().silencedUntilRestart).toBe(true)
    expect(closed).toBe(1)
  })

  it('"Don\'t show this again" still dismisses the tip for good', () => {
    const tip = open()
    act(() => { (q('tip-modal-overflow') as HTMLButtonElement).click() })
    act(() => { (q('tip-modal-never') as HTMLButtonElement).click() })
    expect(useTipsStore.getState().tracking.tipsDismissed[tip.id]).toBeTypeOf('number')
    expect(closed).toBe(1)
  })

  it('the overflow menu closes on mousedown, not on click', () => {
    open()
    act(() => { (q('tip-modal-overflow') as HTMLButtonElement).click() })
    mouse(q('tip-modal-overflow-backdrop')!, 'click')
    expect(q('tip-modal-overflow-menu')).not.toBeNull()
    mouse(q('tip-modal-overflow-backdrop')!, 'mousedown', { button: 0 })
    expect(q('tip-modal-overflow-menu')).toBeNull()
    expect(closed, 'dismissing the menu must not dismiss the dialog').toBe(0)
  })
})

describe('tip dialog -- the look', () => {
  const src = read('components/TipModal.tsx')

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
