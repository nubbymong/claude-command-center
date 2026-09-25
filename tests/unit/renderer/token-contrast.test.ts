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
import { SUB_TOOL_PILL_TOKEN, SUB_TOOL_PILL_WASH } from '../../../src/renderer/components/conductor-mcp/sub-tool-tones'

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
  // generic 14/15% strengths fails on one pairing out of #458's scope: brand
  // at 15% on raised, 4.27:1 in dark. Its one known user, the Codex settings
  // tab's sign-in button, was retired with that tab (WP2 commit 6g), but the
  // pairing itself still fails at that strength, so pinning raised needs
  // dark --brand brightened (the app's identity colour, an owner call) or the
  // pin taken at the strengths raised actually uses. Extend the list then.
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

  it('the completion confirm — surface-chrome text on a solid status-success fill — clears 4.5:1, both themes (#476)', () => {
    // CanvasCompleteButton's armed confirm is the one solid status fill in the
    // pane chrome; --color-crust there measured 4.03:1 on light and the pair
    // was unpinned, which is exactly how the #458 regressions happened.
    for (const [name, mode] of [['dark', 0], ['light', 1]] as const) {
      const fg = token('surface-chrome', mode)
      const bg = token('status-success', mode)
      const r = contrast(fg, bg)
      expect(r, `${name}: --surface-chrome (${fg}) on solid --status-success (${bg}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
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

/* ---- the onboarding showcase eyebrow (VM audit 2026-09-25) --------------- */

describe('contrast: the showcase eyebrow on the onboarding pages', () => {
  // The page counter above the heading, on Hello Codex and on the release
  // notes' feature showcase: 11px copy, so 4.5:1. Its colour was --ob, which measured
  // 4.32:1 on the light theme's --surface-base. The colour is READ from
  // onboarding.css, so the rule is what moves the test.
  const OB_CSS = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/onboarding/onboarding.css'), 'utf8')
  // The one rule for it, read declaration by declaration (see declarations() below).
  const rule = ruleOf(OB_CSS, '.ob-root .sc-eyebrow')
  const colourToken = varOf(rule, 'color')

  /** `--ob-soft: rgba(r,g,b,a)` in the Nth theme block: the onboarding
   *  page's background glow (.glow), which the eyebrow can sit over. */
  function obSoft(occurrence: number): { hex: string; alpha: number } {
    const all = [...CSS.matchAll(/--ob-soft\s*:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g)]
    if (all.length !== 2) throw new Error(`--ob-soft defined ${all.length} times in styles.css; expected exactly dark + light`)
    const m = all[occurrence]
    const hex = '#' + [m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join('')
    return { hex, alpha: Number(m[4]) }
  }

  it('reads the eyebrow colour out of onboarding.css, and it is a token', () => {
    expect(rule, '.sc-eyebrow rule exists').not.toBe('')
    expect(colourToken, '.sc-eyebrow colour is a var(--token)').toBeTruthy()
  })

  it('clears 4.5:1 on --surface-base, and over the page glow at its strongest, both themes', () => {
    for (const [name, mode] of [['dark', 0], ['light', 1]] as const) {
      const fg = token(colourToken!, mode)
      const base = token('surface-base', mode)
      const flat = contrast(fg, base)
      expect(flat, `${name}: --${colourToken} (${fg}) on --surface-base (${base}) = ${flat.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
      const glow = obSoft(mode)
      const tinted = wash(glow.hex, glow.alpha, base)
      const r = contrast(fg, tinted)
      expect(r, `${name}: --${colourToken} (${fg}) over the glow (${tinted}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
    }
  })
})

/* ---- the VM visual capture at 38cbc9d7 (WP2 final fixes) ----------------- */

const OB_CSS_TEXT = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/onboarding/onboarding.css'), 'utf8')

type CssRule = { selectors: string[]; decls: string; at: string | null }
/** Every style rule in a stylesheet: its selector list (whitespace
 *  normalised), its declarations and the at-rule it sits in (@media,
 *  @supports). Keyframe steps are not style rules and are left out. Comments
 *  and quoted strings (single or double, with escapes) are skipped, so a
 *  brace inside either never ends a rule. Reading every rule, not the first a
 *  regex meets, is what lets the checks below see an override later in the
 *  file or in a descendant context. What it cannot read, it refuses: a `{`
 *  inside a style rule (CSS nesting), a `}` with nothing open, or anything
 *  left unterminated throws, so nothing is skipped in silence. */
function cssRules(css: string): CssRule[] {
  const out: CssRule[] = []
  const stack: string[] = []
  let buf = ''
  let i = 0
  /** At a comment or a quoted string: step past it, returning its text
   *  (a comment reads as nothing); otherwise null. */
  const skip = (): string | null => {
    const ch = css[i]
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2)
      if (end < 0) throw new Error('an unterminated comment in the stylesheet')
      i = end + 1
      return ''
    }
    if (ch !== '"' && ch !== "'") return null
    let j = i + 1
    while (j < css.length && css[j] !== ch) j += css[j] === '\\' ? 2 : 1
    if (j >= css.length) throw new Error('an unterminated string in the stylesheet')
    const text = css.slice(i, j + 1)
    i = j
    return text
  }
  for (; i < css.length; i++) {
    const skipped = skip()
    if (skipped !== null) { buf += skipped; continue }
    const ch = css[i]
    if (ch === ';') { buf = ''; continue } // a statement at-rule (@import) or a declaration in an at-rule body
    if (ch === '}') {
      if (!stack.length) throw new Error('a "}" with nothing open in the stylesheet')
      stack.pop()
      buf = ''
      continue
    }
    if (ch !== '{') { buf += ch; continue }
    const prelude = buf.trim()
    buf = ''
    if (prelude.startsWith('@')) { stack.push(prelude); continue }
    // A style rule: its body runs to its own `}`, strings and comments skipped.
    let decls = ''
    for (i++; i < css.length; i++) {
      const s = skip()
      if (s !== null) { decls += s; continue }
      if (css[i] === '{') throw new Error(`a rule nested inside "${prelude}": CSS nesting is not something this check reads`)
      if (css[i] === '}') break
      decls += css[i]
    }
    if (i >= css.length) throw new Error(`the rule "${prelude}" is never closed`)
    if (!stack.some((s) => s.startsWith('@keyframes'))) {
      out.push({ selectors: prelude.split(',').map((s) => s.trim().replace(/\s+/g, ' ')), decls, at: stack.at(-1) ?? null })
    }
  }
  if (stack.length) throw new Error(`"${stack.at(-1)}" is never closed`)
  return out
}
/** The declarations of the ONE rule with this exact selector: none, or a
 *  second rule for it (in a media query included), fails, so an override
 *  can never hide behind the first match. */
function ruleOf(css: string, selector: string): string {
  const want = selector.trim().replace(/\s+/g, ' ')
  const hits = cssRules(css).filter((r) => r.selectors.includes(want))
  if (hits.length !== 1) throw new Error(`expected exactly one rule for "${want}", found ${hits.length}`)
  return hits[0].decls
}
/** Every declaration in a rule body, by property name (lower case; a custom
 *  property keeps its case): split on the `;` that are outside parentheses
 *  and quoted strings (a data: URL, a string with a `;` in it), each read as
 *  `name : value` with space allowed either side of the colon. A property
 *  declared twice in one rule THROWS: the browser paints the last one (or
 *  the !important one), and reading either would be a guess, so a rule the
 *  checks read has to say each thing once. A value keeps any !important, so
 *  a check that expects a plain token or colour fails on it rather than
 *  reading past it. */
function declarations(decls: string): Map<string, string> {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let cur = ''
  for (let i = 0; i < decls.length; i++) {
    const ch = decls[i]
    cur += ch
    if (quote) {
      if (ch === '\\') cur += decls[++i] ?? ''
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ';' && depth === 0) {
      parts.push(cur.slice(0, -1))
      cur = ''
    }
  }
  if (quote || depth !== 0) throw new Error(`a declaration block this check cannot split: ${decls.trim()}`)
  parts.push(cur)
  const out = new Map<string, string>()
  for (const part of parts) {
    if (!part.trim()) continue
    const m = part.match(/^\s*(-?-?[A-Za-z_][\w-]*)\s*:([\s\S]*)$/)
    if (!m) throw new Error(`a declaration this check cannot read: ${part.trim()}`)
    const name = m[1].startsWith('--') ? m[1] : m[1].toLowerCase()
    const value = m[2].trim()
    if (out.has(name)) throw new Error(`"${name}" declared twice in one rule (${out.get(name)} / ${value}): the browser paints the last one, so say it once`)
    out.set(name, value)
  }
  return out
}
/** A declaration's value in a rule, or undefined. */
function prop(decls: string, name: string): string | undefined {
  return declarations(decls).get(name)
}
/** The token a declaration names when its whole value is var(--token). */
function varOf(decls: string, name: string): string | undefined {
  return prop(decls, name)?.match(/^var\(--([a-z0-9-]+)\)$/)?.[1]
}
const BOTH = [['dark', 0], ['light', 1]] as const
/** A rule's background, whichever property sets it. More than one of them in
 *  one rule is not modelled, so it throws rather than reading one. */
function background(decls: string): string | undefined {
  const set = ['background', 'background-color', 'background-image'].map((p) => prop(decls, p)).filter((v) => v !== undefined)
  if (set.length > 1) throw new Error(`a rule that sets its background twice (${set.join(' / ')}): not something this check models`)
  return set[0]
}

/* ---- a background as the browser paints it: solid, wash or gradient ---- */

type Rgba = { r: number; g: number; b: number; a: number }
function rgbaOfHex(hex: string): Rgba {
  const h = hex.replace('#', '')
  const pairs = h.length <= 4 ? h.split('').map((x) => x + x) : (h.match(/../g) as string[])
  const [r, g, b] = pairs.slice(0, 3).map((x) => parseInt(x, 16))
  return { r, g, b, a: pairs[3] ? parseInt(pairs[3], 16) / 255 : 1 }
}
const hexOf = (c: Rgba): string => '#' + [c.r, c.g, c.b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')
/** A colour painted over an opaque one. */
const onto = (c: Rgba, under: Rgba): Rgba => ({
  r: c.r * c.a + under.r * (1 - c.a), g: c.g * c.a + under.g * (1 - c.a), b: c.b * c.a + under.b * (1 - c.a), a: 1,
})
/** An rgba() token (--ob-soft, --ob-line) from the Nth theme block. */
function rgbaToken(name: string, mode: 0 | 1): Rgba {
  const all = [...CSS.matchAll(new RegExp(`--${name}\\s*:\\s*rgba\\((\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\)`, 'g'))]
  if (all.length !== 2) throw new Error(`--${name} defined as rgba() ${all.length} times in styles.css; expected exactly dark + light`)
  const m = all[mode]
  return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: Number(m[4]) }
}
/** Split at the commas (or the whitespace) that are not inside parentheses. */
function topLevel(s: string, sep: ',' | ' '): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth === 0 && (sep === ',' ? ch === ',' : /\s/.test(ch))) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  if (depth !== 0) throw new Error(`unbalanced parentheses in "${s}"`)
  if (cur.trim()) out.push(cur.trim())
  return out
}
/** One CSS colour in a theme: var(--token) (the fallback after a comma is
 *  never used, as token() requires the token in both themes), #hex, rgb() or
 *  rgba(), transparent, or color-mix(in srgb, A [p%], B [q%]) mixed as the
 *  browser mixes it (premultiplied). Anything else throws. */
function colourOf(text: string, mode: 0 | 1): Rgba {
  const s = text.trim()
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return rgbaOfHex(s)
  let m = s.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/)
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) }
  m = s.match(/^var\(--([a-z0-9-]+)(?:,.*)?\)$/)
  if (m) return new RegExp(`--${m[1]}\\s*:\\s*rgba\\(`).test(CSS) ? rgbaToken(m[1], mode) : rgbaOfHex(token(m[1], mode))
  m = s.match(/^color-mix\(in srgb,(.*)\)$/)
  if (m) {
    const parts = topLevel(m[1], ',').map((p) => {
      const w = topLevel(p, ' ')
      if (w.length > 2 || (w.length === 2 && !/^[\d.]+%$/.test(w[1]))) throw new Error(`a color-mix term this check cannot read: ${p}`)
      return { c: colourOf(w[0], mode), pct: w.length === 2 ? parseFloat(w[1]) / 100 : undefined }
    })
    if (parts.length !== 2) throw new Error(`a color-mix of ${parts.length} colours: ${s}`)
    const [A, B] = parts
    const pa = A.pct ?? (B.pct === undefined ? 0.5 : 1 - B.pct)
    const pb = B.pct ?? 1 - pa
    if (Math.abs(pa + pb - 1) > 1e-9) throw new Error(`color-mix percentages that do not add up to 100%: ${s}`)
    const a = A.c.a * pa + B.c.a * pb
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
    const ch = (k: 'r' | 'g' | 'b') => (A.c[k] * A.c.a * pa + B.c[k] * B.c.a * pb) / a
    return { r: ch('r'), g: ch('g'), b: ch('b'), a }
  }
  throw new Error(`a colour this check cannot read: ${s}`)
}
const GRADIENT = /^(?:repeating-)?(?:linear|radial|conic)-gradient\((.*)\)$/
/** A gradient's first argument when it is its direction or shape, not a colour stop. */
const DIRECTION = /^(?:-?[\d.]+(?:deg|turn|rad|grad)\s|to\s|from\s|at\s|circle\s|ellipse\s|closest-|farthest-|[\d.]+(?:%|px)\s)/
/** Every colour a background paints over an opaque surface. A background is
 *  a list of layers, top first, each a colour or a gradient. A gradient gives
 *  each of its stops AND the points between them (16 steps a segment,
 *  interpolated as the browser does it, which for stops painted over one
 *  surface is a straight blend), so a stop that passes cannot hide a stretch
 *  that fails. A stop position is allowed; a colour hint or anything else
 *  this cannot read throws, so no layer is passed over. */
function backgroundColours(decl: string | undefined, surface: string, mode: 0 | 1): string[] {
  if (!decl || decl === 'none') return [surface]
  let under: Rgba[] = [rgbaOfHex(surface)]
  for (const layer of topLevel(decl, ',').reverse()) {
    const g = layer.match(GRADIENT)
    if (!g) {
      const c = colourOf(layer, mode)
      under = under.map((u) => onto(c, u))
      continue
    }
    const stops = topLevel(g[1], ',').flatMap((arg, i) => {
      if (i === 0 && DIRECTION.test(`${arg} `)) return []
      const [colour, ...at] = topLevel(arg, ' ')
      for (const p of at) if (!/^-?[\d.]+(?:%|px)?$/.test(p)) throw new Error(`a gradient stop this check cannot read: ${arg}`)
      return [colourOf(colour, mode)]
    })
    if (stops.length < 2) throw new Error(`a gradient with ${stops.length} colour stop(s): ${layer}`)
    under = under.flatMap((u) => {
      const painted = stops.map((c) => onto(c, u))
      const out: Rgba[] = [painted[0]]
      for (let k = 1; k < painted.length; k++) {
        const [p, q] = [painted[k - 1], painted[k]]
        for (let t = 1; t <= 16; t++) {
          const f = t / 16
          out.push({ r: p.r + (q.r - p.r) * f, g: p.g + (q.g - p.g) * f, b: p.b + (q.b - p.b) * f, a: 1 })
        }
      }
      return out
    })
  }
  return [...new Set(under.map(hexOf))]
}
/** The onboarding page (--surface-base) and the page under its background
 *  glow (.glow), every step of the glow. */
function pageAndGlow(m: 0 | 1): string[] {
  return backgroundColours(background(ruleOf(OB_CSS_TEXT, '.ob-root .glow')), token('surface-base', m), m)
}

describe('contrast: the Conductor MCP status pills', () => {
  // 12px text in a token over a wash of itself, on the card's --surface-raised.
  // The capture measured "Unavailable" (--color-yellow) at 4.07:1 in light and
  // "Off" (--color-overlay1) at 4.09:1 in dark.

  it('every pill tone clears 4.5:1 over its own wash on --surface-raised, both themes', () => {
    expect(Object.keys(SUB_TOOL_PILL_TOKEN).sort()).toEqual(['green', 'overlay1', 'red', 'yellow'])
    for (const [name, mode] of BOTH) {
      const card = token('surface-raised', mode)
      for (const [tone, t] of Object.entries(SUB_TOOL_PILL_TOKEN)) {
        const fg = token(t, mode)
        const bg = wash(fg, SUB_TOOL_PILL_WASH / 100, card)
        const r = contrast(fg, bg)
        expect(r, `${name}: ${tone} = --${t} (${fg}) over its ${SUB_TOOL_PILL_WASH}% wash on --surface-raised = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
      }
    }
  })
})

describe('contrast: the strong keyboard focus ring (switches, Settings selects)', () => {
  // A 2px ring at full strength, set off by a 2px gap: the ring meets the
  // surface behind the control, not its fill, so it needs 3:1 (non-text UI)
  // against every surface a switch or a Settings select is drawn on: the
  // Settings card and its nested panels, the page, and a dialog.
  const decls = ruleOf(CSS, '.focus-ring-strong:focus-visible')
  const ringToken = prop(decls, 'outline')?.match(/^2px solid var\(--([a-z0-9-]+)\)$/)?.[1]

  it('is a full-strength 2px ring with a 2px offset, in a token', () => {
    expect(decls, '.focus-ring-strong:focus-visible rule exists').not.toBe('')
    expect(prop(decls, 'outline')).toMatch(/^2px solid var\(--[a-z0-9-]+\)$/)
    expect(prop(decls, 'outline-offset')).toBe('2px')
    expect(ringToken).toBeTruthy()
  })

  it('clears 3:1 against the surfaces it meets, both themes', () => {
    for (const [name, mode] of BOTH) {
      const ring = token(ringToken!, mode)
      for (const bg of ['surface-raised', 'surface-base', 'surface-panel', 'surface-overlay']) {
        const r = contrast(ring, token(bg, mode))
        expect(r, `${name}: --${ringToken} (${ring}) against --${bg} (${token(bg, mode)}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3)
      }
    }
  })
})

describe('contrast: Set up Codex, the link and the caution badge', () => {
  it('the .cx-link colour is a token that clears 4.5:1 on the page (--surface-base), both themes', () => {
    // "Check this computer's sign-in again" (12px): --ob measured 4.32:1 in light.
    const colour = varOf(ruleOf(OB_CSS_TEXT, '.ob-root .cx-link'), 'color')
    expect(colour, '.cx-link colour is a var(--token)').toBeTruthy()
    for (const [name, mode] of BOTH) {
      const r = contrast(token(colour!, mode), token('surface-base', mode))
      expect(r, `${name}: --${colour} on --surface-base = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
    }
  })

  it('the caution badge (.badge.warn) is --status-warning over its own wash, 4.5:1 on its row (--surface-raised), both themes', () => {
    // The "!" of a CLI newer than tested (13px bold): amber, as Settings,
    // Accounts shows the same state. The blue it had measured 4.29:1.
    const decls = ruleOf(OB_CSS_TEXT, '.ob-root .badge.warn')
    expect(varOf(decls, 'color')).toBe('status-warning')
    const pct = Number(background(decls)?.match(/^color-mix\(in srgb, var\(--status-warning\) (\d+)%, transparent\)$/)?.[1])
    expect(pct).toBeGreaterThan(0)
    for (const [name, mode] of BOTH) {
      const fg = token('status-warning', mode)
      const r = contrast(fg, wash(fg, pct / 100, token('surface-raised', mode)))
      expect(r, `${name}: --status-warning over its ${pct}% wash on --surface-raised = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
    }
  })
})

describe('contrast: every onboarding badge and badge-like pill, both themes', () => {
  // EVERY rule in onboarding.css whose selector names one of these classes is
  // read, wherever it is (a later rule for the same selector, a descendant
  // context, a media query): a rule that sets a text colour or a background
  // must be measured below on the surfaces it sits on, or be listed as exempt
  // with a reason. Small text, so 4.5:1. The azure ones measured 4.3:1 (--ob
  // over --ob-soft), the pending grey 4.27:1 in dark, "Beta" 3.52:1 on a
  // selected assistants card.
  //
  // What it models: a rule is found by the CLASS NAMES its selector spells
  // (.badge, .wait, ...). A selector that reaches a badge another way (an
  // attribute selector such as [class~="wait"], a tag or an id) is not found,
  // and a change to an ancestor's surface (a card whose background changes)
  // is only measured where it is listed in MEASURE below.
  const FAMILIES = new Set(['badge', 'ma-badge', 'rn-badge', 'hc-badge', 'ob-new', 'pill', 'opt-tag', 'as-beta'])
  type Surface = [string, (mode: 0 | 1) => string]
  const raised: Surface = ['--surface-raised', (m) => token('surface-raised', m)]
  const base: Surface = ['--surface-base (the page)', (m) => token('surface-base', m)]
  const panel: Surface = ['--surface-panel', (m) => token('surface-panel', m)]
  const stage: Surface = ['--surface-stage', (m) => token('surface-stage', m)]
  /** --ob-soft (an rgba token) painted over a surface: a selected card. */
  function obSoftOver(surface: string, mode: 0 | 1): string {
    const all = [...CSS.matchAll(/--ob-soft\s*:\s*rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/g)]
    if (all.length !== 2) throw new Error(`--ob-soft defined ${all.length} times in styles.css; expected exactly dark + light`)
    const m = all[mode]
    return wash('#' + [m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join(''), Number(m[4]), surface)
  }
  const selectedCard: Surface = ['a selected card (--ob-soft over --surface-raised)', (m) => obSoftOver(token('surface-raised', m), m)]
  // The check rows and account rows are --surface-raised; an account row
  // switched off is transparent over the page; the Hello Codex vignette is
  // --surface-panel; the release-notes tiles are --surface-stage (their
  // badges carry their own fill); "New in this release" is on the page; the
  // approval card and the option rows are --surface-raised; an assistants
  // card is --surface-raised, and a selected one lays --ob-soft over it.
  const MEASURE: Record<string, Surface[]> = {
    '.ob-root .ob-new': [base],
    '.ob-root .badge.ok': [raised],
    '.ob-root .badge.wait': [raised],
    '.ob-root .badge.warn': [raised],
    '.ob-root .badge.pending': [raised],
    '.ob-root .approve .ah .pill': [raised],
    '.ob-root .ma-badge': [raised],
    '.ob-root .ma-badge.off': [base],
    '.ob-root .opt-tag': [raised],
    '.ob-root .rn-badge.rn-now': [stage],
    '.ob-root .rn-badge.rn-beta': [stage],
    '.ob-root .rn-badge.rn-b22': [stage],
    '.ob-root .as-beta': [raised, selectedCard],
    '.ob-root .hc-badge': [panel],
    '.ob-root .hc-badge.def': [panel],
    '.ob-root .hc-badge.rev': [panel],
    '.ob-root .hc-badge.warn': [panel],
  }
  /** Rules that set a colour or background here but are not drawn as a badge
   *  (none today): selector -> why. */
  const EXEMPT: Record<string, string> = {}

  const rules = cssRules(OB_CSS_TEXT).flatMap((r) => r.selectors.map((selector) => ({ selector, decls: r.decls, at: r.at })))
  const named = rules.filter((r) => [...r.selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].some((m) => FAMILIES.has(m[1])))
  /** Anything that changes how the text reads against its fill counts: a
   *  rule setting it must be measured or exempted. */
  const PAINTING = ['color', '-webkit-text-fill-color', 'opacity']
  const paints = (decls: string) => PAINTING.some((p) => prop(decls, p) !== undefined) || background(decls) !== undefined
  /** The one plain base rule of a variant's family (.ob-root .<family>), whose
   *  colour and background a variant inherits when it sets none. */
  function familyBase(selector: string): string {
    const m = selector.match(/^\.ob-root \.([a-z0-9-]+)\.[a-z0-9-]+$/)
    if (!m) return ''
    const bases = rules.filter((r) => r.selector === `.ob-root .${m[1]}`)
    if (bases.length > 1) throw new Error(`more than one base rule for .${m[1]}`)
    return bases[0]?.decls ?? ''
  }

  it('every rule naming a badge or pill class that paints is measured or exempt, and every measured selector exists', () => {
    expect(named.length).toBeGreaterThanOrEqual(17)
    const unmeasured = named.filter((r) => paints(r.decls) && !(r.selector in MEASURE) && !(r.selector in EXEMPT))
      .map((r) => `${r.at ? `${r.at} ` : ''}${r.selector} { ${r.decls.trim()} }`)
    expect(unmeasured, `rules that paint a badge or pill but are not measured:\n${unmeasured.join('\n')}`).toEqual([])
    for (const selector of Object.keys(MEASURE)) expect(named.some((r) => r.selector === selector), `${selector} has no rule`).toBe(true)
    for (const [selector, why] of Object.entries(EXEMPT)) expect(why.length, `${selector} exempt without a reason`).toBeGreaterThan(10)
  })

  it('every measured rule, each one wherever it appears, clears 4.5:1 on its own fill and every surface it sits on, both themes', () => {
    for (const r of named.filter((x) => x.selector in MEASURE)) {
      const inherited = familyBase(r.selector)
      // The measurement below models colour and background only.
      for (const p of ['-webkit-text-fill-color', 'opacity']) {
        expect(prop(r.decls, p) ?? prop(inherited, p), `${r.selector} sets ${p}, which this measurement does not model: drop it, or extend this check to model it`).toBeUndefined()
      }
      const colour = prop(r.decls, 'color') ?? prop(inherited, 'color')
      const fgToken = colour?.match(/^var\(--([a-z0-9-]+)\)$/)?.[1]
      expect(fgToken, `${r.selector} text is a var(--token) (${colour})`).toBeTruthy()
      for (const [name, mode] of BOTH) {
        for (const [where, surface] of MEASURE[r.selector]) {
          const fg = token(fgToken!, mode)
          // Every colour the fill paints: one for a token or a wash, every
          // stop and the stretches between them for a gradient.
          for (const bg of backgroundColours(background(r.decls) ?? background(inherited), surface(mode), mode)) {
            const c = contrast(fg, bg)
            expect(c, `${name}: ${r.at ? `${r.at} ` : ''}${r.selector} --${fgToken} (${fg}) on ${bg} over ${where} = ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
          }
        }
      }
    }
  })

  it('the rule reader sees every rule: a later duplicate, a descendant context and a media query', () => {
    const sample = '.ob-root .x { color: red; }\n/* { not a rule } */\n@media (max-width: 1px) { .ob-root .x { color: blue; } }\n.ob-root .row .x, .ob-root .y { background-color: green; }\n@keyframes k { 50% { opacity: 0; } }\n.ob-root .x { color: green; }'
    const got = cssRules(sample).flatMap((r) => r.selectors.map((s) => `${r.at ?? ''}|${s}|${r.decls.trim()}`))
    expect(got).toEqual([
      '|.ob-root .x|color: red;',
      '@media (max-width: 1px)|.ob-root .x|color: blue;',
      '|.ob-root .row .x|background-color: green;',
      '|.ob-root .y|background-color: green;',
      '|.ob-root .x|color: green;',
    ])
    expect(() => ruleOf(sample, '.ob-root .x')).toThrow(/exactly one/)
    expect(ruleOf(sample, '.ob-root .y')).toBe(' background-color: green; ')
    expect(background(' background-color: green; ')).toBe('green')
  })

  it('the rule reader never skips in silence: a brace in a string is text, nesting and a stray brace throw', () => {
    // A "}" inside a quoted string (either quote, escapes included) does not
    // end the rule: the declarations after it are read, so a paint there is seen.
    const braced = `.ob-root .badge.wait { content: "}"; quotes: '\\'}'; color: var(--ob); background: var(--ob-soft); }`
    const got = cssRules(braced)
    expect(got).toHaveLength(1)
    expect(prop(got[0].decls, 'color')).toBe('var(--ob)')
    expect(background(got[0].decls)).toBe('var(--ob-soft)')
    // Native CSS nesting is not read: it throws rather than being passed over.
    expect(() => cssRules('.ob-root .checkrow { .badge.wait { color: var(--ob); } }')).toThrow(/nest/)
    expect(() => cssRules('.ob-root .x { color: red; } }')).toThrow(/nothing open/)
    expect(() => cssRules('.ob-root .x { content: "} ; }')).toThrow(/unterminated string/)
    expect(() => cssRules('@media (x) { .ob-root .x { color: red; }')).toThrow(/never closed/)
  })

  it('the declaration reader: a space before the colon is read, a property said twice throws, a ; in parentheses or a string does not split', () => {
    // A space before the colon (or capitals) is still the declaration.
    expect(prop(' background : linear-gradient(#000, #fff); ', 'background')).toBe('linear-gradient(#000, #fff)')
    expect(prop('COLOR: red', 'color')).toBe('red')
    // The browser paints the last of two; the reader refuses to guess, whichever property is asked for.
    expect(() => prop('background: red; color: blue; background: green;', 'background')).toThrow(/twice/)
    expect(() => prop('color: red; Color : blue', 'opacity')).toThrow(/twice/)
    // A ; inside a data: URL or a string does not end the declaration.
    const d = `background: url(data:image/png;base64,AAAA); content: "a;b"; color: red`
    expect(prop(d, 'background')).toBe('url(data:image/png;base64,AAAA)')
    expect(prop(d, 'content')).toBe('"a;b"')
    expect(prop(d, 'color')).toBe('red')
    // !important stays in the value, so a check that expects a plain token fails on it.
    expect(varOf('color: var(--ob) !important', 'color')).toBeUndefined()
    expect(varOf('color: var(--ob)', 'color')).toBe('ob')
    // What it cannot read throws.
    expect(() => declarations('color red;')).toThrow(/cannot read/)
    expect(() => declarations('background: url(a;')).toThrow(/cannot split/)
  })
})

/* ---- text on an onboarding gradient (VM capture at 7a3245ba) ------------- */

describe('contrast: text on an onboarding gradient, at every stop and between them, both themes', () => {
  // The Next / Continue / Let's go buttons (.cta) and the GitHub step's and
  // the version check's buttons (.run) put a 13.5-15px label on a 135deg
  // gradient. In light it started at #2f9bff: 3.3:1 under the first letters.
  // EVERY rule in onboarding.css whose background is a gradient is either
  // measured here, against each text colour drawn on it, at every stop and
  // along the stretches between them, or exempt with a reason. A gradient
  // that is itself the text (background-clip: text) is measured against what
  // is behind it. A :disabled rule (opacity) is not measured: WCAG exempts a
  // disabled control.
  // Read inside each test, so a rule the reader refuses fails a test with its
  // reason rather than stopping the whole file from loading.
  const gRules = () => cssRules(OB_CSS_TEXT)
    .flatMap((r) => r.selectors.map((selector) => ({ selector, decls: r.decls, at: r.at })))
    .filter((r) => /gradient\(/.test(background(r.decls) ?? ''))
  const page = (m: 0 | 1) => [token('surface-base', m)]
  /** The release notes' roadmap band, a wash of --surface-raised over the page. */
  const roadmap = (m: 0 | 1) => backgroundColours(background(ruleOf(OB_CSS_TEXT, '.ob-root .rn-roadmap')), token('surface-base', m), m)
  type Target = { text: string[]; behind: (m: 0 | 1) => string[]; min: number; clip?: true }
  /** selector -> the rules whose `color` is drawn on it (its own, or the
   *  children that sit on it), what is behind it, and the minimum ratio. */
  const MEASURE: Record<string, Target> = {
    '.ob-root .cta': { text: ['.ob-root .cta'], behind: page, min: MIN },
    '.ob-root .run': { text: ['.ob-root .run'], behind: page, min: MIN },
    // A selected assistants card: its title inherits the card's colour; the
    // Beta pill carries its own fill and is measured with the badges.
    '.ob-root .as-card.sel': { text: ['.ob-root .as-card', '.ob-root .as-sub'], behind: page, min: MIN },
    // The live roadmap tile: its name and caption (its badge carries its own fill).
    '.ob-root .rn-tile.rn-live': { text: ['.ob-root .rn-tile', '.ob-root .rn-tname', '.ob-root .rn-tsub'], behind: roadmap, min: MIN },
    // The product name, 46px at weight 800, is large text: 3:1.
    '.ob-root .rn-name': { text: [], behind: pageAndGlow, min: 3, clip: true },
  }
  const EXEMPT: Record<string, string> = {
    '.ob-root .glow': 'the page background glow, an empty element; text over it sits on at most --ob-soft over the page, which the eyebrow and the product name checks measure',
    '.ob-root .sl-spot': 'an empty spotlight in the status line scene; what sits over it is the switches (no text) and the strip, which has its own --surface-raised fill',
    '.ob-root .mini.s': 'the split-theme swatch on the theme choice: a picture of the two themes, no text',
    '.ob-root .mini.s .rail': 'the rail of the split-theme swatch, no text',
    '.ob-root .sv-keel': 'a 2px rule beside the mode name, no text',
  }

  it('every rule with a gradient background is measured or exempt, and each listed one is exactly one rule', () => {
    const G_RULES = gRules()
    const unlisted = G_RULES.filter((r) => !(r.selector in MEASURE) && !(r.selector in EXEMPT))
      .map((r) => `${r.at ? `${r.at} ` : ''}${r.selector} { ${r.decls.trim()} }`)
    expect(unlisted, `gradient backgrounds that are not measured:\n${unlisted.join('\n')}`).toEqual([])
    for (const selector of [...Object.keys(MEASURE), ...Object.keys(EXEMPT)]) {
      expect(G_RULES.filter((r) => r.selector === selector), `${selector}: exactly one rule, and its background is a gradient`).toHaveLength(1)
    }
    for (const [selector, why] of Object.entries(EXEMPT)) expect(why.length, `${selector} exempt without a reason`).toBeGreaterThan(10)
  })

  it('the text on each measured gradient clears its minimum at every stop and between them, both themes', () => {
    for (const [selector, t] of Object.entries(MEASURE)) {
      const decls = ruleOf(OB_CSS_TEXT, selector)
      const clipped = prop(decls, 'background-clip') === 'text' || prop(decls, '-webkit-background-clip') === 'text'
      expect(clipped, `${selector}: background-clip: text is ${clipped}, the table says ${Boolean(t.clip)}`).toBe(Boolean(t.clip))
      if (t.clip) expect(prop(decls, 'color'), `${selector}: the gradient is the text`).toBe('transparent')
      // Colour and background are what is modelled; these would change it.
      for (const src of [selector, ...t.text]) {
        for (const p of ['opacity', '-webkit-text-fill-color']) {
          expect(prop(ruleOf(OB_CSS_TEXT, src), p), `${src} sets ${p}, which this measurement does not model`).toBeUndefined()
        }
      }
      for (const [name, mode] of BOTH) {
        for (const behind of t.behind(mode)) {
          const fills = backgroundColours(background(decls), behind, mode)
          const pairs: [string, string, string][] = t.clip
            ? fills.map((f) => [f, behind, 'the text itself'])
            : t.text.flatMap((src) => {
                const value = prop(ruleOf(OB_CSS_TEXT, src), 'color')
                expect(value, `${src} sets a text colour`).toBeTruthy()
                const fg = colourOf(value!, mode)
                expect(fg.a, `${src}: its text colour is opaque`).toBe(1)
                return fills.map((f): [string, string, string] => [hexOf(fg), f, `${src} ${value}`])
              })
          for (const [fg, bg, what] of pairs) {
            const c = contrast(fg, bg)
            expect(c, `${name}: ${selector}, ${what} (${fg}) on ${bg} = ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(t.min)
          }
        }
      }
    }
  })

  it("the guided tour's Next button draws the .cta gradient and label, so the check above covers it", () => {
    const tour = fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/components/GuidedTour.tsx'), 'utf8')
    const found = [...tour.matchAll(/background: '((?:linear|radial|conic)-gradient\([^']*\))', color: '([^']*)'/g)]
    expect(found, 'one gradient button in the tour').toHaveLength(1)
    // The hex after a token's comma is a fallback, used only where the token is undefined.
    const bare = (s: string) => s.replace(/var\((--[a-z0-9-]+),[^()]*\)/g, 'var($1)')
    const cta = ruleOf(OB_CSS_TEXT, '.ob-root .cta')
    expect(bare(found[0][1])).toBe(background(cta))
    expect(bare(found[0][2])).toBe(bare(prop(cta, 'color')!))
  })

  it('the background reader: stops, the stretches between, layers, washes, and what it refuses', () => {
    // Black to white over anything: both ends and the grey between.
    const bw = backgroundColours('linear-gradient(90deg, #000000, #ffffff)', '#123456', 0)
    expect(bw[0]).toBe('#000000')
    expect(bw.at(-1)).toBe('#ffffff')
    expect(bw).toContain('#808080')
    expect(bw).toHaveLength(17)
    // A translucent stop is painted over the surface; stop positions are read past.
    expect(backgroundColours('radial-gradient(circle, rgba(0,0,0,.5) 0%, rgba(0,0,0,0) 62%)', '#ffffff', 0)[0]).toBe('#808080')
    // Layers, top first: the top one is painted over the one under it.
    expect(backgroundColours('linear-gradient(rgba(0,0,0,.5), rgba(0,0,0,.5)), #ffffff', '#000000', 0)).toEqual(['#808080'])
    // color-mix: a wash matches wash(); two opaque colours blend; a translucent one mixes premultiplied.
    expect(backgroundColours('color-mix(in srgb, #ff0000 50%, transparent)', '#ffffff', 0)).toEqual([wash('#ff0000', 0.5, '#ffffff')])
    expect(hexOf(colourOf('color-mix(in srgb, #000000 25%, #ffffff)', 0))).toBe('#bfbfbf')
    expect(colourOf('color-mix(in srgb, rgba(0,0,0,.5) 50%, #ffffff)', 0).a).toBeCloseTo(0.75)
    // A token reads the real value, with or without a fallback.
    expect(hexOf(colourOf('var(--ob-on, #04121f)', 1))).toBe(token('ob-on', 1))
    // What it cannot read throws: an unknown colour, an unknown first argument, a colour hint, two background properties.
    expect(() => backgroundColours('linear-gradient(90deg, hsl(0 0% 0%), #fff)', '#000000', 0)).toThrow(/cannot read/)
    expect(() => backgroundColours('linear-gradient(sideways, #000, #fff)', '#000000', 0)).toThrow(/cannot read/)
    expect(() => backgroundColours('linear-gradient(#000, 30%, #fff)', '#000000', 0)).toThrow(/cannot read/)
    expect(() => background('background: red; background-image: none;')).toThrow(/twice/)
  })
})

/* ---- --ob-bright as a text colour ---------------------------------------- */

describe('contrast: text drawn in --ob-bright on the onboarding pages, both themes', () => {
  // --ob-bright is the light end of the button gradient and a text colour too:
  // the section heads on What's New and the command bar step (11px capitals)
  // and the prompt marks in the Hello Codex pictures (12px mono; 4.54:1 on the
  // light panel, the tightest). EVERY rule whose text colour uses --ob-bright
  // is listed here with what is behind it, read from the container's rule; a
  // new one fails until it is listed.
  const containerFill = (selector: string) => (m: 0 | 1) =>
    backgroundColours(background(ruleOf(OB_CSS_TEXT, selector)), token('surface-base', m), m)
  const BEHIND: Record<string, (m: 0 | 1) => string[]> = {
    '.ob-root .wn-sec-h': pageAndGlow,
    // .hc-term sits in the vignette (.hc-vig) and has no fill of its own.
    '.ob-root .hc-term .p': containerFill('.ob-root .hc-vig'),
    // The prompt under the resume picker, inside the picker's box (.hc-tui).
    '.ob-root .hc-prompt': containerFill('.ob-root .hc-tui'),
  }
  // Read inside each test (see gRules above).
  const brightRules = () => cssRules(OB_CSS_TEXT)
    .flatMap((r) => r.selectors.map((selector) => ({ selector, decls: r.decls, at: r.at })))
    .filter((r) => /var\(--ob-bright\b/.test(prop(r.decls, 'color') ?? ''))

  it('every rule whose text is --ob-bright is listed, and every listed one has such a rule', () => {
    const bright = brightRules()
    const unlisted = bright.filter((r) => !(r.selector in BEHIND)).map((r) => `${r.at ? `${r.at} ` : ''}${r.selector} { ${r.decls.trim()} }`)
    expect(unlisted, `--ob-bright text that is not measured:\n${unlisted.join('\n')}`).toEqual([])
    for (const selector of Object.keys(BEHIND)) expect(bright.some((r) => r.selector === selector), `${selector} has a rule drawing --ob-bright text`).toBe(true)
  })

  it('each one clears 4.5:1 on everything behind it, both themes', () => {
    for (const r of brightRules()) {
      for (const p of ['opacity', '-webkit-text-fill-color']) {
        expect(prop(r.decls, p), `${r.selector} sets ${p}, which this measurement does not model`).toBeUndefined()
      }
      for (const [name, mode] of BOTH) {
        const fg = colourOf(prop(r.decls, 'color')!, mode)
        expect(fg.a, `${r.selector}: its text colour is opaque`).toBe(1)
        for (const bg of BEHIND[r.selector](mode)) {
          const c = contrast(hexOf(fg), bg)
          expect(c, `${name}: ${r.at ? `${r.at} ` : ''}${r.selector} ${prop(r.decls, 'color')} (${hexOf(fg)}) on ${bg} = ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
        }
      }
    }
  })
})

/* ---- Settings: the page breadcrumb, the selected tab, small grey text ---- */

describe('contrast: the page header breadcrumb, the selected Settings tab and small grey text in Settings and Accounts', () => {
  // The capture measured the breadcrumb ("Settings" then the section, on every
  // page) at 2.4:1, the Accounts helper line at 2.10 dark / 3.18 light (both
  // --color-overlay0 at 11px) and the selected Settings tab at 4.17:1 in light.
  // These read the real sources, so a class change is what moves the test.
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../../src/renderer/components', rel), 'utf8')
  const PAGE_FRAME = read('PageFrame.tsx')
  const SETTINGS = read('SettingsPage.tsx')
  const ACCOUNTS = read('AccountsPanel.tsx')
  /** A text colour utility, as a token name: text-[var(--x)] -> x. */
  const tokenClass = (cls: string) => cls.match(/(?:^|\s)text-\[var\(--([a-z0-9-]+)\)\]/)?.[1]

  it('the breadcrumb context and its separator are a pinned token that clears 4.5:1 on the page header, both themes', () => {
    const header = PAGE_FRAME.match(/px-3 py-1\.5 shrink-0" style=\{\{ background: 'var\(--([a-z0-9-]+)\)'/)?.[1]
    expect(header, 'the page header background is a var(--token)').toBeTruthy()
    const block = PAGE_FRAME.slice(PAGE_FRAME.indexOf('{context && ('), PAGE_FRAME.indexOf('</>', PAGE_FRAME.indexOf('{context && (')))
    const spans = [...block.matchAll(/<span className="([^"]*)">/g)].map((m) => m[1])
    expect(spans, 'the separator and the context').toHaveLength(2)
    for (const cls of spans) {
      const t = tokenClass(cls)
      expect(t, `the breadcrumb colour is a var(--token) utility (${cls})`).toBeTruthy()
      for (const [name, mode] of BOTH) {
        const r = contrast(token(t!, mode), token(header!, mode))
        expect(r, `${name}: --${t} on --${header} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
      }
    }
  })

  it('the selected Settings tab label clears 4.5:1 over its own wash on the rail, both themes', () => {
    const rail = PAGE_FRAME.match(/w-44 shrink-0[^"]*" style=\{\{ background: 'var\(--([a-z0-9-]+)\)'/)?.[1]
    expect(rail, 'the rail background is a var(--token)').toBeTruthy()
    const body = SETTINGS.slice(SETTINGS.indexOf('export function TabsRail('))
    const fill = body.match(/background: active \? 'color-mix\(in srgb, var\(--([a-z0-9-]+)\) (\d+)%, transparent\)'/)
    const label = body.match(/color: active \? 'var\(--([a-z0-9-]+)\)'/)?.[1]
    expect(fill, 'the selected tab fill is a wash of a token').toBeTruthy()
    expect(label, 'the selected tab label is a var(--token)').toBeTruthy()
    for (const [name, mode] of BOTH) {
      const bg = wash(token(fill![1], mode), Number(fill![2]) / 100, token(rail!, mode))
      const r = contrast(token(label!, mode), bg)
      expect(r, `${name}: --${label} over a ${fill![2]}% wash of --${fill![1]} on --${rail} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
    }
  })

  it("the Settings tabs' keyboard focus is the strong ring drawn inside, set off by a band of the rail's surface, clearing 3:1 against it, both themes", () => {
    // The tabs run edge to edge in the scrolling rail, so a ring outside them
    // would be clipped at its sides: the inset form draws the same ring inside.
    // On a selected tab the ring would meet the tab's tint (2.91:1 in light),
    // so a band of the rail's surface sits inside it: the ring meets the rail
    // on both sides.
    const body = SETTINGS.slice(SETTINGS.indexOf('export function TabsRail('))
    const tab = body.slice(body.indexOf('onClick={() => onChange(tab.id)}'))
    expect(tab.match(/className="([^"]*)"/)?.[1]?.split(/\s+/), 'the tab button').toContain('focus-ring-strong-inset')
    const inset = ruleOf(CSS, '.focus-ring-strong-inset:focus-visible')
    const strong = ruleOf(CSS, '.focus-ring-strong:focus-visible')
    expect(prop(inset, 'outline'), 'the same ring as the strong form').toBe(prop(strong, 'outline'))
    expect(prop(inset, 'outline-offset')).toBe('-2px')
    const ringToken = prop(inset, 'outline')?.match(/^2px solid var\(--([a-z0-9-]+)\)$/)?.[1]
    expect(ringToken).toBeTruthy()
    const rail = PAGE_FRAME.match(/w-44 shrink-0[^"]*" style=\{\{ background: 'var\(--([a-z0-9-]+)\)'/)?.[1]
    expect(rail).toBeTruthy()
    // The band: an inset shadow wider than the ring (so some of it shows), in the rail's own token.
    const band = prop(inset, 'box-shadow')?.match(/^inset 0 0 0 (\d+)px var\(--([a-z0-9-]+)\)$/)
    expect(band, 'an inset band behind the ring').toBeTruthy()
    expect(Number(band![1])).toBeGreaterThanOrEqual(4)
    expect(band![2], 'the band is the rail surface').toBe(rail)
    for (const [name, mode] of BOTH) {
      const ring = token(ringToken!, mode)
      const railBg = token(rail!, mode)
      const r = contrast(ring, railBg)
      expect(r, `${name}: --${ringToken} (${ring}) against the rail and the band (--${rail}, ${railBg}) = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(3)
    }
  })

  it('a focused selected colour swatch shows both rings: the focus ring sits outside the selection ring, with a gap', () => {
    // The selection ring is a box-shadow (a 2px gap, then a 2px ring); a focus
    // ring at the usual 2px offset painted over it, so a focused selected
    // swatch looked like a focused unselected one. The outset form is the same
    // ring further out; the gap between the two shows the card, which the
    // strong ring is pinned against above.
    const outset = ruleOf(CSS, '.focus-ring-strong-outset:focus-visible')
    expect(prop(outset, 'outline'), 'the same ring as the strong form').toBe(prop(ruleOf(CSS, '.focus-ring-strong:focus-visible'), 'outline'))
    const offset = Number(prop(outset, 'outline-offset')?.match(/^(\d+)px$/)?.[1])
    const swatch = ACCOUNTS.slice(ACCOUNTS.indexOf('data-testid={`colour-swatch-'))
    const el = swatch.slice(0, swatch.indexOf('/>'))
    expect(el.match(/className="([^"]*)"/)?.[1]?.split(/\s+/), 'the swatch draws the outset ring').toContain('focus-ring-strong-outset')
    const shadow = el.match(/boxShadow: isSelected \? `([^`]*)`/)?.[1]
    expect(shadow, 'the selection ring is a box-shadow').toBeTruthy()
    const spreads = topLevel(shadow!, ',').map((l) => Number(l.match(/^0 0 0 (\d+)px /)?.[1]))
    expect(spreads.every((n) => n > 0), `every selection layer is read: ${shadow}`).toBe(true)
    const reach = Math.max(...spreads)
    expect(offset - reach, `the focus ring (offset ${offset}px) clears the selection ring (${reach}px) by a 2px gap`).toBeGreaterThanOrEqual(2)
    // The swatches sit far enough apart that the ring (offset plus width) stays
    // clear of the next swatch, with room to spare (Tailwind gap-N is N x 4px).
    const width = Number(prop(outset, 'outline')?.match(/^(\d+)px /)?.[1])
    const row = ACCOUNTS.slice(0, ACCOUNTS.indexOf('data-testid={`colour-swatch-'))
    const gap = Number(row.slice(row.lastIndexOf('<div className="flex flex-wrap gap-')).match(/^<div className="flex flex-wrap gap-(\d+(?:\.\d+)?)"/)?.[1]) * 4
    expect(gap - (offset + width), `the swatch gap (${gap}px) clears the focus ring (${offset + width}px) by 2px`).toBeGreaterThanOrEqual(2)
  })

  it('Settings, the Accounts panel and the page header draw no text in --color-overlay0 (2.1-3.2:1); the status line preview, which copies the status line, is the one place left', () => {
    // The text-overlay0 utility under any variant (hover:, placeholder:,
    // group-hover: ...) and at any opacity (text-overlay0/60), the variable as
    // an arbitrary text colour, or the variable as an inline colour.
    const grey = /(?:^|[\s"'`{:])text-overlay0(?:\/\d+)?(?=[\s"'`}]|$)|text-\[var\(--color-overlay0\)\]|color: [^,}]*'var\(--color-overlay0\)'/
    for (const s of ['className="hover:text-overlay0"', 'className="a text-overlay0/60"', 'className="placeholder:text-overlay0 x"', "{'text-overlay0'}", 'className="text-[var(--color-overlay0)]"', "style={{ color: 'var(--color-overlay0)' }}"]) {
      expect(grey.test(s), `the ban matches ${s}`).toBe(true)
    }
    for (const s of ['className="text-overlay1"', "'bg-overlay0'", 'className="border border-overlay0/30"', 'className="text-overlay00"']) {
      expect(grey.test(s), `the ban leaves ${s}`).toBe(false)
    }
    const start = SETTINGS.indexOf('function StatusLinePreview(')
    const end = SETTINGS.indexOf('function MockRateDots(')
    expect(start, 'the status line preview is found').toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const sources: [string, string][] = [
      ['SettingsPage.tsx', SETTINGS.slice(0, start) + SETTINGS.slice(end)],
      ['AccountsPanel.tsx', ACCOUNTS],
      // Drawn inside each Claude account row of the Accounts panel.
      ['settings/AccountWebSession.tsx', read('settings/AccountWebSession.tsx')],
      ['settings/AccountIsolationNotice.tsx', read('settings/AccountIsolationNotice.tsx')],
      ['PageFrame.tsx', PAGE_FRAME],
    ]
    const hits = sources.flatMap(([f, s]) => s.split(/\r?\n/).filter((l) => grey.test(l)).map((l) => `${f}: ${l.trim()}`))
    expect(hits, `--color-overlay0 text:\n${hits.join('\n')}`).toEqual([])
    // What replaced it is --text-muted, pinned on every surface these sit on
    // (the settings cards are --surface-raised, the page --surface-stage, the
    // header and the rail --surface-panel) by the #458 block above.
    for (const [name, mode] of BOTH) {
      for (const bg of ['surface-raised', 'surface-stage', 'surface-panel']) {
        const r = contrast(token('text-muted', mode), token(bg, mode))
        expect(r, `${name}: --text-muted on --${bg} = ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
      }
    }
  })
})
