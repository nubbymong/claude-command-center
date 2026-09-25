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
  const rule = OB_CSS.match(/\.ob-root \.sc-eyebrow \{([^}]*)\}/)?.[1] ?? ''
  const colourToken = rule.match(/(?:^|;)\s*color:\s*var\(--([a-z0-9-]+)\)/)?.[1]

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
const varOf = (decls: string, prop: string): string | undefined =>
  decls.match(new RegExp(`(?:^|;|\\s)${prop}:\\s*var\\(--([a-z0-9-]+)\\)`))?.[1]
const BOTH = [['dark', 0], ['light', 1]] as const

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
  const ringToken = decls.match(/outline:\s*2px solid var\(--([a-z0-9-]+)\)/)?.[1]

  it('is a full-strength 2px ring with a 2px offset, in a token', () => {
    expect(decls, '.focus-ring-strong:focus-visible rule exists').not.toBe('')
    expect(decls).toMatch(/outline:\s*2px solid var\(--[a-z0-9-]+\)/)
    expect(decls).toMatch(/outline-offset:\s*2px/)
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
    const pct = Number(decls.match(/color-mix\(in srgb, var\(--status-warning\) (\d+)%, transparent\)/)?.[1])
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
  const prop = (decls: string, name: string): string | undefined => decls.match(new RegExp(`(?:^|;)\\s*${name}:\\s*([^;]+)`))?.[1]?.trim()
  const background = (decls: string) => prop(decls, 'background') ?? prop(decls, 'background-color')
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
  /** A background over its surface: a token (hex, or an rgba token such as
   *  --ob-soft, painted as a wash), a wash of a token, a neutral rgba wash, or
   *  nothing. Anything else fails, so a new form cannot slip past unmeasured. */
  function paint(decl: string | undefined, surface: string, mode: 0 | 1): string {
    if (!decl || decl === 'transparent' || decl === 'none') return surface
    let m = decl.match(/^var\(--([a-z0-9-]+)\)$/)
    if (m) {
      if (m[1] === 'ob-soft') return obSoftOver(surface, mode)
      return token(m[1], mode)
    }
    m = decl.match(/^color-mix\(in srgb, var\(--([a-z0-9-]+)\) (\d+)%, transparent\)$/)
    if (m) return wash(token(m[1], mode), Number(m[2]) / 100, surface)
    m = decl.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/)
    if (m) return wash('#' + [m[1], m[2], m[3]].map((c) => Number(c).toString(16).padStart(2, '0')).join(''), Number(m[4]), surface)
    throw new Error(`a background this check cannot measure: ${decl}`)
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
          const bg = paint(background(r.decls) ?? background(inherited), surface(mode), mode)
          const c = contrast(fg, bg)
          expect(c, `${name}: ${r.at ? `${r.at} ` : ''}${r.selector} --${fgToken} (${fg}) on ${bg} over ${where} = ${c.toFixed(2)}:1`).toBeGreaterThanOrEqual(MIN)
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
})
