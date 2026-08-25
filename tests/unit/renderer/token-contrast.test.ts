/**
 * WCAG contrast for the palette tokens that carry real copy.
 *
 * `--color-overlay1` was #777777 and measured 3.2–4.3:1 against every surface
 * it is drawn on — below the 4.5:1 minimum on ALL of them. It is not a
 * decorative grey: it renders session status ("working", "idle"), group
 * headings, config counts and the Ask Conductor subtitle. Found by
 * canvas_snapshot on the sidebar mockup, 2026-08-21, which is the only reason
 * anyone noticed: nothing in the build measured it.
 *
 * This reads the REAL values out of styles.css rather than restating them, so
 * editing the token is what moves the test — a copy of the hex here would pass
 * happily while the app shipped something else.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const CSS = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/styles.css'), 'utf8')

/** Pull a token's value from the Nth block that defines it (0 = dark, 1 = light).
 *  Exactly two definitions are required: a third block (a new theme, a media
 *  query override) would silently shift the indexing and leave the light
 *  theme untested, so it fails loudly here instead. */
function token(name: string, occurrence: number): string {
  const all = [...CSS.matchAll(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`, 'g'))].map((m) => m[1])
  if (all.length !== 2) throw new Error(`--${name} defined ${all.length} times in styles.css — expected exactly dark + light`)
  const v = all[occurrence]
  if (!v) throw new Error(`--${name} occurrence ${occurrence} not found in styles.css`)
  return v
}

const channel = (c: number): number => {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const pairs = h.length === 3 ? h.split('').map((x) => x + x) : (h.match(/../g) as string[])
  const [r, g, b] = pairs.slice(0, 3).map((x) => parseInt(x, 16))
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

const MIN = 4.5

describe('contrast — sidebar secondary text', () => {
  // The surfaces overlay1 is actually rendered on. `crust` is deliberately
  // absent: in dark mode nothing puts overlay1 there, and in light mode crust
  // is the darkest chrome, where text uses --text-on-chrome instead. Listing a
  // background the token never meets would be a test that fails for a reason
  // nobody can act on.
  const DARK_SURFACES = ['color-base', 'color-mantle', 'color-surface0', 'color-surface1']

  it('reads real values out of styles.css, not a copy', () => {
    // Guards the guard: if the regex stops matching, every assertion below
    // would silently be testing nothing.
    expect(token('color-overlay1', 0)).toMatch(/^#[0-9a-f]{6}$/i)
    expect(token('color-overlay1', 1)).toMatch(/^#[0-9a-f]{6}$/i)
    expect(token('color-overlay1', 0)).not.toBe(token('color-overlay1', 1))
  })

  it('dark: --color-overlay1 clears 4.5:1 on every surface it is drawn on', () => {
    const fg = token('color-overlay1', 0)
    for (const bg of DARK_SURFACES) {
      const r = contrast(fg, token(bg, 0))
      expect(r, `${fg} on --${bg} (${token(bg, 0)}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('light: --color-overlay1 clears 4.5:1 on the surfaces it is drawn on', () => {
    const fg = token('color-overlay1', 1)
    for (const bg of ['color-base', 'color-surface0', 'color-surface1']) {
      const r = contrast(fg, token(bg, 1))
      expect(r, `${fg} on --${bg} (${token(bg, 1)}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
    }
  })

  // #360 introduced --text-on-brand for text sitting ON a --brand fill (the
  // primary dialog buttons). It exists to FIX a contrast bug -- `bg-blue
  // text-base` resolved to a font size, so those labels inherited their colour
  // -- so the pair it was created for needs real coverage in both themes.
  it('--text-on-brand clears 4.5:1 on --brand in both themes', () => {
    for (const [name, mode] of [['dark', 0], ['light', 1]] as const) {
      const fg = token('text-on-brand', mode)
      const bg = token('brand', mode)
      const r = contrast(fg, bg)
      expect(r, `${name}: ${fg} on --brand (${bg}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('--text-on-brand actually flips between the themes', () => {
    // One hardcoded value would clear the ratio in whichever theme it suits and
    // quietly fail the other, which is the whole reason this is a token.
    expect(token('text-on-brand', 0)).not.toBe(token('text-on-brand', 1))
  })

  it('the maths is right — known WCAG anchors', () => {
    // A ratio function that always returned 21 would pass everything above.
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 1)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    // Order must not matter.
    expect(contrast('#777777', '#1a1a1a')).toBeCloseTo(contrast('#1a1a1a', '#777777'), 5)
    // The value that started this, at the ratio that was reported.
    expect(contrast('#777777', '#1a1a1a')).toBeCloseTo(3.89, 1)
  })
})

/* ---- #458: --text-muted and the status-pill recipe ----------------------- */

/** `color-mix(in srgb, A p%, transparent)` painted over an opaque surface:
 *  per-channel sRGB blend, which is exactly what the browser composites. */
function wash(fg: string, pct: number, surface: string): string {
  const px = (h: string) => (h.replace('#', '').match(/../g) as string[]).map((x) => parseInt(x, 16))
  const [a, b] = [px(fg), px(surface)]
  return '#' + a.map((c, i) => Math.round(c * pct + b[i] * (1 - pct)).toString(16).padStart(2, '0')).join('')
}

describe('contrast — #458: muted text and the status-pill recipe', () => {
  // The surfaces the 10-11px muted strings actually sit on: the chrome and
  // panel, the canvas stage and its gutter, and — where MOST of them live —
  // the raised dialogs and overlay menus/popovers (review round 1: the first
  // cut listed only the first four and certified a value that still failed
  // 3.9-4.3:1 on raised/overlay).
  const MUTED_SURFACES = [
    'surface-chrome',
    'surface-panel',
    'surface-stage',
    'surface-stage-gutter',
    'surface-raised',
    'surface-overlay',
  ]
  // Where the wash pins run. The recipe also lives on raised — ui/Dialog's
  // danger buttons (16%), NoteDialog/menus confirms, CommandDialog's Ask
  // strip (brand 12%) — and those all clear at their ACTUAL strengths in
  // both themes (danger@16% raised 4.93 dark, brand@12% raised 4.51 dark).
  // Raised/overlay are still not in this list because pinning them at the
  // generic 14/15% strengths would fail on ONE pre-existing case out of
  // #458's scope: CodexSettingsTab's brand-15%-on-raised button, 4.27:1 in
  // dark — fixing that means brightening dark --brand, the app's identity
  // colour, which is an owner call. Extend the list when that lands.
  const WASH_SURFACES = ['surface-chrome', 'surface-panel', 'surface-stage', 'surface-stage-gutter']

  it('reads real values out of styles.css, not a copy', () => {
    // Guards the guard, same as the overlay1 block: a theme block inserted
    // between dark and light would silently shift occurrence indexing.
    for (const t of ['text-muted', 'brand', 'status-success', 'status-warning', 'status-danger', 'status-info', ...MUTED_SURFACES]) {
      expect(token(t, 0)).toMatch(/^#[0-9a-f]{6}$/i)
      expect(token(t, 1)).toMatch(/^#[0-9a-f]{6}$/i)
      expect(token(t, 0), `--${t} dark and light must differ`).not.toBe(token(t, 1))
    }
  })

  it('--text-muted clears 4.5:1 on every surface it is drawn on, both themes', () => {
    for (const [name, mode] of [['dark', 0], ['light', 1]] as const) {
      const fg = token('text-muted', mode)
      for (const bg of MUTED_SURFACES) {
        const r = contrast(fg, token(bg, mode))
        expect(r, `${name}: ${fg} on --${bg} (${token(bg, mode)}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
      }
    }
  })

  // The house pill recipe: `text-[var(--status-X)]` over a wash of ITSELF
  // (10% pills, 14% library badges, 15% brand Start/Beta pills). In the
  // dark theme the bright status colours clear on these surfaces; the light
  // theme is where the old values measured 2.7-4.4:1. Both themes are pinned
  // so neither can regress.
  it('status text over its own wash clears 4.5:1 at every resting wash strength, both themes', () => {
    for (const [name, mode] of [['dark', 0], ['light', 1]] as const) {
      for (const status of ['status-success', 'status-warning', 'status-danger', 'status-info']) {
        const fg = token(status, mode)
        for (const bg of WASH_SURFACES) {
          for (const pct of [0.10, 0.14, 0.15]) {
            const r = contrast(fg, wash(fg, pct, token(bg, mode)))
            expect(
              r,
              `${name}: --${status} (${fg}) over its ${pct * 100}% wash on --${bg} = ${r.toFixed(2)}:1`,
            ).toBeGreaterThanOrEqual(MIN)
          }
        }
      }
    }
  })

  it('brand text over its own 15% wash clears 4.5:1, both themes', () => {
    // Quick Start's Start pill and the BottomBar Beta pill: text-[var(--brand)]
    // over color-mix(var(--brand) 15%, transparent).
    for (const [name, mode] of [['dark', 0], ['light', 1]] as const) {
      const fg = token('brand', mode)
      for (const bg of WASH_SURFACES) {
        const r = contrast(fg, wash(fg, 0.15, token(bg, mode)))
        expect(r, `${name}: --brand (${fg}) over its 15% wash on --${bg} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
      }
    }
  })

  it('the wash maths is right — anchors', () => {
    // 100% wash is the colour itself; 0% is the surface; a mid wash sits between.
    expect(wash('#ff0000', 1, '#ffffff')).toBe('#ff0000')
    expect(wash('#ff0000', 0, '#ffffff')).toBe('#ffffff')
    expect(wash('#000000', 0.5, '#ffffff')).toBe('#808080')
  })
})
