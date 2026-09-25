/**
 * Two onboarding layout faults the VM visual run found (2026-09-25), pinned
 * as declarations because jsdom performs no layout (the same technique as
 * onboarding-overflow.test.ts):
 *
 *   - item 3: the Welcome brand mark was squeezed to 7px at the app's
 *     minimum window, 1280x720. .hero is a scrolling flex column; the text
 *     cannot shrink below its lines but the SVG mark could. It must not
 *     shrink (the column scrolls instead).
 *   - item 4: a horizontal scrollbar under the pages on a narrow window. The
 *     page columns were sized to a share of the WINDOW (min(Npx, 95vw)),
 *     which plus the 24px side padding of their scroll container (and its
 *     scrollbar) is wider than the window. They are sized to the space left
 *     instead (a percentage of the container), and capped at it for the pages
 *     that set their own width inline.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const css = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/onboarding/onboarding.css'), 'utf-8')

/** The declarations of the single `.ob-root <selector> { ... }` rule. */
function rule(selector: string): string {
  const m = css.match(new RegExp(`\\.ob-root ${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`))
  expect(m, `${selector} rule exists`).toBeTruthy()
  return m![1]
}

/** One declaration's value, e.g. decl(rule('.mark'), 'width'). */
function decl(body: string, prop: string): string | undefined {
  return body.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${prop}:`))?.slice(prop.length + 1).trim()
}

describe('the Welcome (and Finish) brand mark keeps its size', () => {
  it('.mark does not shrink in the .hero column', () => {
    const mark = rule('.mark')
    expect(decl(mark, 'width')).toBe('70px')
    expect(decl(mark, 'height')).toBe('70px')
    expect(decl(mark, 'flex-shrink') ?? decl(mark, 'flex')).toMatch(/^(0|none)$/)
  })

  it('.hero is still the scrolling column the mark sits in (so the mark scrolls instead)', () => {
    const hero = rule('.hero')
    expect(decl(hero, 'flex-direction')).toBe('column')
    expect(decl(hero, 'overflow-y')).toBe('auto')
  })
})

describe('the page columns fit the space inside their scroll container', () => {
  // Each column and the scroll container that holds it, with its side padding.
  const COLUMNS: Array<[string, string]> = [['.p2-inner', '.p2'], ['.sl-inner', '.sl-stage'], ['.rn-page', '.p2']]

  it('no column is sized to a share of the window', () => {
    for (const [col] of COLUMNS) {
      expect(decl(rule(col), 'width'), `${col} width`).not.toMatch(/vw/)
    }
    // Nothing else in the onboarding styles sizes a width to the window.
    const vwWidths = css.split('\n').filter((l) => /(^|[\s;{])(max-|min-)?width:\s*[^;]*\d+vw/.test(l))
    expect(vwWidths).toEqual([])
  })

  it('every column is capped at its container, so an inline width cannot overflow it either', () => {
    for (const [col, container] of COLUMNS) {
      expect(decl(rule(col), 'max-width'), `${col} max-width`).toBe('100%')
      // The container really does pad its sides: the cap is what keeps the
      // column inside them.
      expect(decl(rule(container), 'padding'), `${container} padding`).toMatch(/px/)
    }
  })

  it('the assistants page and Hello Codex size their own columns to the space too (round 2)', () => {
    for (const file of ['AssistantsStep.tsx', 'HelloCodex.tsx']) {
      const source = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/onboarding', file), 'utf-8')
      const widths = [...source.matchAll(/width: '(min\([^']*\))'/g)].map((m) => m[1])
      expect(widths.length, `${file} sets a column width inline`).toBeGreaterThan(0)
      for (const w of widths) expect(w, `${file}: ${w}`).toMatch(/^min\(\d+px, 100%\)$/)
    }
  })
})
