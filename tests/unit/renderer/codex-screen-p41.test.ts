// [host] WP2 PR 4, P4.1 (row 51): the screens the submit primitive must never
// type into, and the two readings it adds (a long paste's placeholder, the
// composer's height). The rows are the real screens of the PR 4 VM probes
// (PB2: the MCP approval form; PB4: the sandbox set-up menu; PB9: the paste
// fold and a composer taller than the pane allows), on 0.155.1 and 0.153.4,
// with the probe server's name and the paths anonymised. The reading is the
// one module the renderer, the Watchdog and main's primitive all use
// (src/shared/codex-screen.ts).
import { describe, it, expect } from 'vitest'
import {
  readCodexScreen, codexComposerState, codexPastedContentShown, codexComposerRows, codexTextTyped, codexCommandTyped,
  type ScreenLine,
} from '../../../src/shared/codex-screen'
import { readCodexScreen as rendererRead, codexComposerState as rendererState } from '../../../src/renderer/lib/codexComposer'

const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const H = String.fromCharCode(0x2500)
const plain = (text: string): ScreenLine => ({ text, typed: text })
const dimFrom = (text: string, from: number): ScreenLine => ({ text, typed: text.slice(0, from) + ' '.repeat(Math.max(0, text.length - from)) })
const banner = (version: string): ScreenLine[] => [
  plain('\u256d' + H.repeat(46) + '\u256e'),
  plain(`\u2502 >_ OpenAI Codex (v${version})                   \u2502`),
  plain('\u2502                                              \u2502'),
  plain('\u2502 model:     gpt-5.5 medium   /model to change \u2502'),
  plain('\u2502 directory: C:\\dev\\demo                       \u2502'),
  plain('\u2570' + H.repeat(46) + '\u256f'),
  plain('  Tip: New Build faster with Codex.'),
]
const FOOTER = plain(`  gpt-5.5 medium ${DOT} C:\\dev\\demo`)
const READY: ScreenLine[] = [...banner('0.155.1'), dimFrom(`${P} Ask Codex to do anything`, 2), FOOTER]

/** PB4 / PB2: the sandbox set-up menu a first launch shows, as both versions draw it. */
const sandboxMenu = (version: string, withFooter = true): ScreenLine[] => [
  ...banner(version),
  plain('  Set up the Codex agent sandbox to protect your files and control network access. Learn more <https://developers.openai.com/codex/windows>'),
  plain(`${P} 1. Set up default sandbox (requires Administrator permissions)`),
  plain('  2. Use non-admin sandbox (higher risk if prompt injected)'),
  plain('  3. Quit'),
  ...(withFooter ? [plain('  Press enter to confirm or esc to go back')] : []),
]

/** PB2: the MCP approval form, which takes a digit as its answer at once. */
const approvalForm = (tool: string, glued: ScreenLine[] = []): ScreenLine[] => [
  plain('  Tip: New Build faster with Codex.'),
  plain(`${P} P410-MCP-1-${tool}`),
  plain(`\u2022 Calling conductor.${tool}({"note":"p410"})`),
  plain('  Field 1/1'),
  plain(`  Allow the conductor MCP server to run tool "${tool}"?`),
  plain('  note: p410'),
  plain(`  ${P} 1. Allow                   Run the tool and continue.`),
  plain('    2. Allow for this session  Run the tool and remember this choice for this session.'),
  plain('    3. Always allow            Run the tool and remember this choice for future tool calls.'),
  plain('    4. Cancel                  Cancel this tool call'),
  plain('  enter to submit | esc to cancel'),
  ...glued,
]

describe('blocking screens added in P4.1: nothing is typed into them', () => {
  it.each(['0.155.1', '0.153.4'])('the sandbox set-up menu reads as blocked (%s)', (v) => {
    expect(readCodexScreen(sandboxMenu(v)).screen).toBe('blocked')
    expect(codexComposerState(sandboxMenu(v))).toBe('not-ready')
  })

  it('the sandbox menu reads as blocked by its title alone (a pane that lost the footer row)', () => {
    expect(readCodexScreen(sandboxMenu('0.155.1', false)).screen).toBe('blocked')
  })

  it.each(['canvas_snapshot', 'canvas_review', 'canvas_render'])('the MCP approval form for %s reads as blocked', (tool) => {
    expect(readCodexScreen(approvalForm(tool)).screen).toBe('blocked')
  })

  it('a composer and a footer drawn under the approval form still read as blocked, never ready', () => {
    const screen = approvalForm('canvas_render', [dimFrom(`${P} Ask Codex to do anything`, 2), FOOTER])
    expect(readCodexScreen(screen).screen).toBe('blocked')
    expect(codexComposerState(screen)).toBe('not-ready')
    expect(codexTextTyped(screen, 'anything')).toBe(false)
    expect(codexCommandTyped(screen, '/plan')).toBe(false)
  })

  it('the renderer reads them through the same module (Compact, Plan mode, image paste, the command bar)', () => {
    for (const screen of [sandboxMenu('0.153.4'), approvalForm('canvas_snapshot')]) {
      expect(rendererRead(screen).screen).toBe('blocked')
      expect(rendererState(screen)).toBe('not-ready')
    }
  })

  it('an ordinary ready composer is still ready (the new patterns are not too wide)', () => {
    expect(readCodexScreen(READY).screen).toBe('ready')
    const typed = [...banner('0.155.1'), plain(`${P} Allow the user to set up the sandbox later`), FOOTER]
    // A user's own words that only resemble the screens: not the form's
    // wording ("MCP server to run tool"), nor the menu's title.
    expect(readCodexScreen(typed).screen).toBe('ready')
  })
})

describe('the paste placeholder (PB9: from 1,001 code points)', () => {
  const folded = (n: number): ScreenLine[] => [...banner('0.155.1'), plain(`${P} [Pasted Content ${n} chars]`), FOOTER]

  it('reads the placeholder for exactly its count, with the footer under it', () => {
    expect(codexPastedContentShown(folded(2000), 2000)).toBe(true)
    expect(codexPastedContentShown(folded(8000), 8000)).toBe(true)
  })

  it('a different count is not this text (one character lost, or another paste)', () => {
    expect(codexPastedContentShown(folded(1999), 2000)).toBe(false)
    expect(codexPastedContentShown(folded(20000), 2000)).toBe(false)
  })

  it('never while a prompt is up, a turn runs, or something stands under it', () => {
    expect(codexPastedContentShown([...approvalForm('canvas_review'), ...folded(2000).slice(-2)], 2000)).toBe(false)
    expect(codexPastedContentShown([...banner('0.155.1'), plain('\u2022 Working (3s \u2022 esc to interrupt)'), ...folded(2000).slice(-2)], 2000)).toBe(false)
    expect(codexPastedContentShown([...folded(2000).slice(0, -1), plain('  /plan  switch to plan mode'), FOOTER], 2000)).toBe(false)
    expect(codexPastedContentShown(READY, 2000)).toBe(false)
  })
})

describe('the composer height (PB9: at most the pane rows minus 4)', () => {
  // PB9, 1,000 code points at 80 by 16: the composer is 12 rows, its first
  // rows scrolled out, the prompt glyph on the first visible row.
  const TALL: ScreenLine[] = [
    plain(`${P} notes 42 probe alpha beta gamma delta epsilon zeta theta kappa lambda canvas`),
    ...Array.from({ length: 10 }, () => plain('  review notes 42 probe alpha beta gamma delta epsilon zeta theta kappa lambda')),
    plain('  notes 4'),
    FOOTER,
  ]
  // PB9, 200 code points at 80 columns: three rows, confirmed by codexTextTyped.
  const TEXT = 'alpha beta gamma delta epsilon zeta theta kappa lambda canvas review notes 42 probe alpha beta gamma delta epsilon zeta theta kappa lambda canvas review notes 42 probe alpha beta gamma delta epsilon z'
  const WRAPPED: ScreenLine[] = [
    ...banner('0.153.4'),
    plain(`${P} alpha beta gamma delta epsilon zeta theta kappa lambda canvas review notes 42`),
    plain('  probe alpha beta gamma delta epsilon zeta theta kappa lambda canvas review'),
    plain('  notes 42 probe alpha beta gamma delta epsilon z'),
    FOOTER,
  ]

  it('counts the composer row and the rows wrapped under it', () => {
    expect(codexComposerRows(READY)).toBe(1)
    expect(codexComposerRows(WRAPPED)).toBe(3)
    expect(codexComposerRows(TALL)).toBe(12)
  })

  it('a wrapped text is confirmed only by codexTextTyped (the shared reading calls it unrecognised)', () => {
    expect(readCodexScreen(WRAPPED).screen).toBe('unrecognised')
    expect(codexTextTyped(WRAPPED, TEXT)).toBe(true)
  })

  it('a text taller than the composer cannot be confirmed', () => {
    expect(codexTextTyped(TALL, 'notes 42 probe')).toBe(false)
  })

  it('no composer standing on a footer: no height', () => {
    expect(codexComposerRows(sandboxMenu('0.155.1'))).toBeNull()
    expect(codexComposerRows([])).toBeNull()
  })
})
