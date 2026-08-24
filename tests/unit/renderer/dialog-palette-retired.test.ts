/**
 * #360 acceptance, encoded: "grep for the old dialog classes in components
 * returns nothing that is a dialog".
 *
 * This test WALKS `src/renderer` and classifies every file, rather than
 * iterating a list of files someone remembered to add. The first version of
 * this file was a hardcoded allowlist, and it certified the migration green
 * while `CanvasLibrary.tsx` sat un-migrated and unnoticed — a guard that only
 * looks where you point it cannot tell you that you pointed it in the wrong
 * place. So the detector is deliberately BROAD (it over-matches), and
 * everything it should not police is written down below with a reason. An
 * over-match costs one line in an exclusion map; a miss is silent.
 *
 * Shape borrowed from `no-direct-config-save.test.ts`: recursive walk, explicit
 * allow-map, plus guards that keep the map honest and the detectors sharp.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

const ROOT = path.resolve(__dirname, '../../../src/renderer')
const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, '/')

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(ent.name) && !/\.d\.ts$/.test(ent.name)) out.push(p)
  }
  return out
}

/* ---- what counts as a dialog ------------------------------------------- */

/** The file NAME ends in a dialog word (`…Modal.tsx`, `…ContextMenu.tsx`). */
const NAME = /(Dialog|Modal|Confirm|Picker|Prompt|Menu|Popover|Popup|Overlay|Drawer|Sheet|Gate)\.tsx$/
/** A JSX `role="dialog"`, not the same text inside a CSS selector string —
 *  `TerminalView` queries `[role="dialog"][aria-modal="true"]` to find out
 *  whether a dialog is open, which does not make it one. */
const JSX_ROLE = /(?<!\[)role=["'](?:dialog|alertdialog|menu)["']/
const JSX_ARIA_MODAL = /(?<!\[)aria-modal[=\s]/
/** A full-bleed layer plus something that closes: the hand-rolled modal shape
 *  that has no role at all. This is what catches a `CanvasLibrary`. */
const FULLBLEED = /className=(?:"[^"]*|\{`[^`]*)\binset-0\b/
const CLOSEISH = /\bonClose\b|\bonCancel\b|\bonDismiss\b/

function dialogShape(src: string, file: string): string | null {
  if (NAME.test(path.basename(file))) return 'name'
  if (JSX_ROLE.test(src)) return 'jsx-role'
  if (JSX_ARIA_MODAL.test(src)) return 'aria-modal'
  if (FULLBLEED.test(src) && CLOSEISH.test(src)) return 'full-bleed+close'
  return null
}

/* ---- what counts as the old palette ------------------------------------ */

const COLOURS =
  'mantle|base|crust|surface[012]|subtext[01]|overlay[012]|text|mauve|blue|red|green|yellow|peach|lavender|sapphire|sky|teal|pink|maroon|flamingo|rosewater'
const PREFIXES = 'bg|text|border|ring|accent|from|to|via|divide|outline|placeholder|fill|stroke|shadow'
/** A palette utility with any variant prefix (hover:, group-hover:…) and any
 *  /NN opacity suffix. */
const PALETTE = new RegExp(`\\b(?:[a-z-]+:)*(?:${PREFIXES})-(?:${COLOURS})(?:\\/\\d+)?\\b`, 'g')
/** The pre-rename inline vars, `var(--color-surface1)`. */
const PALETTE_VAR = /var\(\s*--color-[a-z0-9-]+/g

/**
 * `text-base` is NOT a colour. Tailwind resolves `text-*` in the font-size
 * namespace first, so `text-base` is 1rem — which is the very bug #360 fixed
 * (`bg-blue text-base` buttons inherited their text colour instead of getting
 * a dark one). Genuine font-size uses are legitimate and stay.
 */
const FONT_SIZE_NOT_A_COLOUR = /^text-base$/

/** Strip comments so prose *describing* the retired classes is not a finding. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function paletteHits(src: string): string[] {
  const hits: string[] = []
  for (const m of src.match(PALETTE) ?? []) {
    if (FONT_SIZE_NOT_A_COLOUR.test(m.replace(/^(?:[a-z-]+:)*/, ''))) continue
    hits.push(m)
  }
  hits.push(...(src.match(PALETTE_VAR) ?? []))
  return hits
}

const hitsOf = (file: string) =>
  paletteHits(stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8')))

/* ---- the exclusions, each with a reason -------------------------------- */

/** Dialogs owned by another issue. They ARE dialogs and they DO still grep.
 *
 *  `components/TipCard.tsx` (né TipModal) left this map in #361: the tip card
 *  is now built on the primitives, so it is policed by the scan like any other. */
const TRACKED_ELSEWHERE: Record<string, string> = {
  'components/CommandBar.tsx': 'the command bar — issue #359',
  'components/command-bar/ArgsPopover.tsx': 'the command bar — issue #359',
  'components/command-bar/chips.tsx': 'the command bar — issue #359',
}

/** Files the broad detector matches that are not dialogs at all. Each of these
 *  is an over-match we accept in exchange for never missing a real one. */
const NOT_A_DIALOG: Record<string, string> = {
  'components/AgentCanvasPane.tsx':
    'a pane, not a dialog: its inset-0 layers are the canvas/iframe/marquee ' +
    'layers, and its onClose props are passed DOWN to the dialogs it renders ' +
    '(CanvasLibrary, CanvasEmptyState), which are policed on their own',
  'components/CanvasHistoryControl.tsx':
    'pane chrome, not a dialog: the version stepper + History dropdown that ' +
    'lives in AgentCanvasPane\'s toolbar (role="menu" is the dropdown). Its ' +
    'palette classes are the mode/kind colours (mauve = plan, blue = mockup) ' +
    'shared with that excluded chrome, which have no semantic token',
  'components/TerminalView.tsx':
    'queries [role="dialog"][aria-modal="true"] to detect whether a dialog is ' +
    'open; it does not render one',
}

/**
 * Files where only PART of the file is a dialog — the surrounding page or
 * chrome is out of #360's scope. `existsSync` alone would prove nothing, so
 * each carries the palette count at the time of the migration and the file may
 * never exceed it. Reverting a migrated menu to `bg-surface0` pushes the count
 * up and fails here; migrating more of the file lets the number come down.
 */
const PARTIAL_MAX: Record<string, { max: number; what: string }> = {
  'App.tsx': { max: 11, what: 'the "Name this machine" modal and the closing overlay' },
  'components/BottomBar.tsx': { max: 1, what: 'the CLI-not-found confirm modal' },
  'components/github/GitHubPanel.tsx': { max: 1, what: 'the setup modal' },
  'components/TabBar.tsx': { max: 9, what: 'the tab context menu' },
  'components/AgentLibrary.tsx': { max: 30, what: 'the template context menu' },
  'components/CloudAgentsPage.tsx': { max: 86, what: 'the agent context menu' },
  'components/ScreenshotButton.tsx': { max: 5, what: 'the dropdown menu' },
  'components/MultiAccountStatusline.tsx': {
    max: 3,
    what: 'the account overflow popover (already on E5; the hits are footer chrome)',
  },
}

const EXCLUDED = new Set([
  ...Object.keys(TRACKED_ELSEWHERE),
  ...Object.keys(NOT_A_DIALOG),
  ...Object.keys(PARTIAL_MAX),
])

/* ---- the scan ----------------------------------------------------------- */

interface Scanned { rel: string; shape: string; src: string; hits: string[] }

const scanned: Scanned[] = walk(ROOT)
  .map((file) => {
    const src = stripComments(fs.readFileSync(file, 'utf8'))
    const shape = dialogShape(src, file)
    return shape ? { rel: rel(file), shape, src, hits: paletteHits(src) } : null
  })
  .filter((x): x is Scanned => x !== null)

describe('#360 — the old palette is retired from every dialog in the tree', () => {
  it('the walk actually reaches the dialogs (it cannot pass by scanning nothing)', () => {
    expect(scanned.length).toBeGreaterThan(40)
    // Spot-check files that must be in scope, including the one the previous
    // allowlist version of this test missed entirely.
    for (const must of [
      'components/CanvasLibrary.tsx',
      'components/SessionDialog.tsx',
      'components/ui/Dialog.tsx',
      'components/tokenomics/SessionDetailDrawer.tsx',
      'components/sidebar/ConfigContextMenu.tsx',
    ]) {
      expect(scanned.map((s) => s.rel), `${must} must be classified as a dialog`).toContain(must)
    }
  })

  it('no dialog outside the documented exclusions carries a palette class', () => {
    const offenders = scanned
      .filter((s) => !EXCLUDED.has(s.rel) && s.hits.length > 0)
      .map((s) => `${s.rel} [${s.shape}]: ${[...new Set(s.hits)].join(', ')}`)
    expect(offenders).toEqual([])
  })

  it('partially-migrated files never gain palette classes back', () => {
    const regressions: string[] = []
    for (const [file, { max }] of Object.entries(PARTIAL_MAX)) {
      const n = hitsOf(file).length
      if (n > max) regressions.push(`${file}: ${n} palette hits, ceiling is ${max}`)
    }
    expect(regressions).toEqual([])
  })
})

describe('#360 — the exclusion lists stay honest', () => {
  it('every excluded file still exists', () => {
    for (const file of EXCLUDED) {
      expect(fs.existsSync(path.join(ROOT, file)), `${file} is excluded but gone`).toBe(true)
    }
  })

  it('no exclusion is stale — a file that no longer greps must leave the list', () => {
    // Without this, an exclusion outlives the reason for it and the scan
    // quietly shrinks. Anything that reaches zero should be deleted from the
    // map so the guard starts policing it for real.
    const stale: string[] = []
    for (const file of [...Object.keys(TRACKED_ELSEWHERE), ...Object.keys(PARTIAL_MAX)]) {
      if (hitsOf(file).length === 0) stale.push(`${file} is clean now — remove it from the exclusions`)
    }
    expect(stale).toEqual([])
  })

  it('the dialogs deferred to other issues are named, not silently skipped', () => {
    expect(TRACKED_ELSEWHERE['components/CommandBar.tsx']).toMatch(/#359/)
    // #361 migrated the tip dialog (now the anchored TipCard), so it must NOT
    // be deferred any more — it is in the policed set, and the scan above is
    // what proves it stays clean.
    expect(TRACKED_ELSEWHERE['components/TipCard.tsx']).toBeUndefined()
    expect(scanned.map((s) => s.rel)).toContain('components/TipCard.tsx')
    // Every exclusion carries a human reason, not just a path.
    for (const reason of [...Object.values(TRACKED_ELSEWHERE), ...Object.values(NOT_A_DIALOG)]) {
      expect(reason.length).toBeGreaterThan(20)
    }
  })
})

describe('#360 — the palette detector is sharp', () => {
  it('fires on palette classes, including variants and opacity suffixes', () => {
    const sample = 'const a = <div className="bg-mantle text-subtext0 hover:bg-surface1/50" />'
    expect(stripComments(sample).match(PALETTE)).toEqual(['bg-mantle', 'text-subtext0', 'hover:bg-surface1/50'])
    expect('var(--color-surface1)'.match(PALETTE_VAR)).toHaveLength(1)
    expect(paletteHits('border-surface0 ring-blue divide-crust')).toHaveLength(3)
    // …inside a color-mix, where the var is not at the start of the value.
    expect(paletteHits('background: color-mix(in srgb, var(--color-red) 15%, transparent)')).toHaveLength(1)
  })

  it('does not fire on tokens, or on the font-size utility', () => {
    expect(paletteHits('bg-[var(--surface-raised)] text-[var(--text-primary)]')).toEqual([])
    expect(paletteHits('className="text-base font-semibold"')).toEqual([])
    expect(paletteHits('var(--status-danger) var(--text-on-brand) var(--scrim)')).toEqual([])
  })

  it('ignores the retired names when they appear in prose', () => {
    expect(paletteHits(stripComments('// was `bg-blue text-base`\nconst x = 1'))).toEqual([])
    expect(paletteHits(stripComments('/* bg-mantle everywhere */ const y = 2'))).toEqual([])
  })
})

describe('#360 — the dialog classifier is sharp', () => {
  it('classifies the shapes a dialog actually takes', () => {
    expect(dialogShape('', 'x/FooModal.tsx')).toBe('name')
    expect(dialogShape('', 'x/SessionContextMenu.tsx')).toBe('name')
    expect(dialogShape('<div role="dialog">', 'x/Thing.tsx')).toBe('jsx-role')
    expect(dialogShape('<div aria-modal="true">', 'x/Thing.tsx')).toBe('aria-modal')
    // The hand-rolled modal with no role at all — the CanvasLibrary shape.
    expect(dialogShape('<div className="absolute inset-0 z-20" /> onClose', 'x/Thing.tsx')).toBe('full-bleed+close')
  })

  it('does not classify a file that merely QUERIES for an open dialog', () => {
    expect(dialogShape('document.querySelector(\'[role="dialog"][aria-modal="true"]\')', 'x/View.tsx')).toBeNull()
  })

  it('does not classify ordinary components', () => {
    expect(dialogShape('<div className="flex gap-2" />', 'x/Row.tsx')).toBeNull()
    // "Gateway" is not "Gate" — the name rule anchors on the whole word.
    expect(dialogShape('const a = 1', 'x/HooksGatewaySection.tsx')).toBeNull()
  })
})

describe('#360 — dialog backdrops never close on click', () => {
  /**
   * Ctrl+C in a terminal fires click events, so a backdrop with an onClick
   * dismiss ate the user's dialog. The shipped rule is mousedown-dismiss with
   * a context-menu gesture dismissing inertly (`lib/pointer.ts`).
   */
  const ON_CLICK_BACKDROP = /className=(?:"[^"]*|\{`[^`]*)\binset-0\b[^>]*?onClick=\{/s
  const MOUSEDOWN_BACKDROP = /className=(?:"[^"]*|\{`[^`]*)\binset-0\b[^>]*?on(?:MouseDown|PointerDown)=\{/s

  /** Pre-existing, NOT introduced by #360: these dismiss on any mouse button
   *  with no `isContextMenuGesture` guard, so a right-click unmounts the
   *  backdrop and the contextmenu then lands on whatever is underneath. Worth
   *  a follow-up; out of scope for a colour migration. */
  const UNGUARDED_PREEXISTING = new Set([
    'components/TerminalContextMenu.tsx',
    'components/ToolbarPopup.tsx',
    'components/sidebar/ConfigLoadFailedRailIndicator.tsx',
  ])

  const policed = scanned.filter((s) => !(s.rel in NOT_A_DIALOG) && !(s.rel in TRACKED_ELSEWHERE))

  it('no dialog closes a full-bleed backdrop on click, whatever the handler is called', () => {
    // Handler names vary (onClose, onCancel, clearSelected…), so this matches
    // ANY onClick on a full-bleed element. The previous version listed handler
    // names and therefore missed `onClick={clearSelected}` in the tokenomics
    // drawer — a live reproduction of the original incident, in a file that
    // same test certified as compliant.
    const offenders = policed.filter((s) => ON_CLICK_BACKDROP.test(s.src)).map((s) => s.rel)
    expect(offenders).toEqual([])
  })

  it('a mousedown-dismissing backdrop guards the context-menu gesture', () => {
    const offenders = policed
      .filter((s) => !UNGUARDED_PREEXISTING.has(s.rel))
      .filter((s) => MOUSEDOWN_BACKDROP.test(s.src) && !/isContextMenuGesture/.test(s.src))
      .map((s) => s.rel)
    expect(offenders).toEqual([])
  })

  it('the backdrop detectors actually fire', () => {
    expect(ON_CLICK_BACKDROP.test('<div className="fixed inset-0 z-50" onClick={onClose}>')).toBe(true)
    // …the case the old handler-name alternation let through:
    expect(ON_CLICK_BACKDROP.test('<div className="fixed inset-0 z-40" onClick={clearSelected} />')).toBe(true)
    expect(MOUSEDOWN_BACKDROP.test('<div className="fixed inset-0" onMouseDown={bail} />')).toBe(true)
    expect(MOUSEDOWN_BACKDROP.test('<div className="fixed inset-0" onPointerDown={bail} />')).toBe(true)
    // …and do not fire on a non-full-bleed element.
    expect(ON_CLICK_BACKDROP.test('<button className="px-2" onClick={onClose} />')).toBe(false)
  })
})
