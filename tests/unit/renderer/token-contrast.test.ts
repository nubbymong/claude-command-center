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

/** Pull a token's value from the Nth block that defines it (0 = dark, 1 = light). */
function token(name: string, occurrence: number): string {
  const all = [...CSS.matchAll(new RegExp(`--${name}\\s*:\\s*(#[0-9a-fA-F]{3,8})`, 'g'))].map((m) => m[1])
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
