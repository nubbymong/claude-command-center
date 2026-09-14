/**
 * Shared checks for the E5 dialog token tests (#360).
 *
 * The bar every converted dialog clears (tests/unit/renderer/command-dialog-tokens.test.tsx
 * set it): the panel is the raised surface by token, no Catppuccin palette class
 * survives on ANY element inside, and the overlay has no click-to-close.
 *
 * Imported by the per-dialog tests; not a test file itself.
 */
import { expect } from 'vitest'
import { act } from 'react'

/** Every Catppuccin palette utility we are retiring from dialogs. The set is
 *  wider than the command-dialog test's: the old dialogs also used bg-base,
 *  bg-surface1/2, border-surface0, text-text, the named colours as fills and
 *  text (bg-blue, text-red, text-green, text-mauve...), and their /NN opacity
 *  variants. A hover:/focus:/group-hover: prefix does not excuse one. */
export const PALETTE_CLASS = /^(?:[a-z-]+:)*(?:bg|text|border|ring|accent|from|to|via|divide|outline|placeholder|fill|stroke|shadow)-(?:mantle|base|crust|surface[012]|subtext[01]|overlay[012]|text|mauve|blue|red|green|yellow|peach|lavender|sapphire|sky|teal|pink|maroon|flamingo|rosewater)(?:\/\d+)?$/

/** Every palette class on every element inside `scope` (inclusive). Empty
 *  means the surface is token-driven. */
export function paletteSurvivors(scope: Element): string[] {
  const out: string[] = []
  const all = Array.from(scope.querySelectorAll('[class]'))
  if (scope.hasAttribute('class')) all.unshift(scope)
  for (const el of all) {
    for (const token of (el.getAttribute('class') ?? '').split(/\s+/)) {
      if (PALETTE_CLASS.test(token)) out.push(`${el.tagName.toLowerCase()}[data-testid="${el.getAttribute('data-testid') ?? ''}"] .${token}`)
    }
  }
  return out
}

/** The panel is the raised surface with the subtle border, by token. */
export function expectRaisedPanel(panel: HTMLElement | null) {
  expect(panel, 'a [role=dialog] panel').not.toBeNull()
  expect(panel!.style.background).toBe('var(--surface-raised)')
  expect(panel!.style.border).toContain('var(--border-subtle)')
}

/** A click and a mousedown on the overlay do nothing: no handler, and the
 *  given probe still reports the dialog as open. */
export function expectNoBackdropClose(overlay: HTMLElement | null, stillOpen: () => boolean) {
  expect(overlay, 'the overlay element').not.toBeNull()
  expect(overlay!.onclick, 'no click handler on the overlay').toBeNull()
  expect(overlay!.onmousedown, 'no mousedown handler on the overlay').toBeNull()
  act(() => { overlay!.click() })
  expect(stillOpen(), 'still open after a click on the overlay').toBe(true)
  act(() => { overlay!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })) })
  expect(stillOpen(), 'still open after a mousedown on the overlay').toBe(true)
}

/** Escape (dispatched on window, as the keyboard does) closes it. */
export function pressEscape(target: EventTarget = window) {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
}

/** The primary button is the brand fill. */
export function expectBrandButton(btn: HTMLElement | null) {
  expect(btn, 'the primary button').not.toBeNull()
  expect(btn!.style.background).toBe('var(--brand)')
}
