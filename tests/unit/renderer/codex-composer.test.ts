// P3.8 round 1 (C1, C2, C3, L1, L2): the app types a Codex command (/compact,
// /model, /plan) only into Codex's ready, empty composer, and presses Enter
// only when the composer then holds exactly that command, in the same run.
//
// Ready (the VM probe of 0.153.4 and 0.155.1): the screen's last line is the
// footer "<model> <effort> . <folder>" and the line above it (blank lines
// aside) is the composer. The placeholder is drawn before the folder-trust
// prompt, so it is not a marker; Codex's own pickers and the trust prompt
// have no footer. A turn running is "busy". The screens are the recorded ones
// (codex-composer-screens.ts).
import { describe, it, expect, vi } from 'vitest'
import {
  codexComposerState,
  codexComposerText,
  readCodexScreen,
  codexPlanModeOnScreen,
  planModeNote,
  typeIntoCodexComposer,
  typeWhenCodexComposerReady,
  CODEX_SUBMIT_DELAY_MS,
  CODEX_READY_POLL_MS,
  type ScreenLine,
  type CodexComposerDeps,
} from '../../../src/renderer/lib/codexComposer'
import * as S from './codex-composer-screens'

describe('codexComposerState', () => {
  it('is ready on the recorded ready screens, and the composer is empty', () => {
    for (const [name, screen] of Object.entries({ READY: S.READY, READY_ULTRA: S.READY_ULTRA, READY_PLAN: S.READY_PLAN, READY_RESUMED: S.READY_RESUMED })) {
      expect(codexComposerState(screen), name).toBe('ready')
      expect(codexComposerText(screen), name).toBe('')
    }
  })

  it('is not ready while the model loads, at the trust prompt, or in Codex\'s own pickers', () => {
    for (const [name, screen] of Object.entries({ LOADING: S.LOADING, TRUST: S.TRUST, MODEL_PICKER: S.MODEL_PICKER, REASONING_PICKER: S.REASONING_PICKER, TYPED_PLAN: S.TYPED_PLAN })) {
      expect(codexComposerState(screen), name).toBe('not-ready')
    }
    expect(codexComposerState([])).toBe('not-ready')
  })

  it('is busy while a turn runs', () => {
    expect(codexComposerState(S.WORKING_NOW)).toBe('busy')
  })

  it('a blocking prompt anywhere on the screen wins over a composer and footer still drawn below it', () => {
    for (const text of [
      '  Do you trust the contents of this directory? Working with untrusted contents comes with higher risk.',
      '  Press enter to continue',
      '  Press enter to confirm or esc to go back',
    ]) {
      expect(codexComposerState([S.plain(text), ...S.READY]), text).toBe('not-ready')
    }
  })

  it('a footer-like last line with no composer row above it is not ready (another view, or transcript text)', () => {
    const noComposer = S.READY.map((l) => (l.text.includes('Ask Codex to do anything') ? S.plain('  the transcript, not the prompt') : l))
    expect(noComposer).not.toEqual(S.READY)
    expect(codexComposerState(noComposer)).toBe('not-ready')
  })

  it('reads what the user typed, never the dim placeholder', () => {
    expect(codexComposerState(S.USER_TYPING)).toBe('ready')
    expect(codexComposerText(S.USER_TYPING)).toBe('half a question')
    expect(codexComposerText(S.TYPED_PLAN)).toBe('/plan')
    expect(codexComposerText(S.TRUST)).toBe('1. Yes, continue')
  })
})

// P3.8 round 2 (FT, WW): the footer is anchored (a level of Codex's, or
// "default", after the model; the model one of the session's when known), so
// Codex's own hint lines never read as a ready prompt; only Codex's two dim
// placeholders read as an empty composer; its approval requests block.
describe('the ready marker is anchored (round 2)', () => {
  const GLYPH = String.fromCharCode(0x203a)
  const DOT = String.fromCharCode(0xb7)
  const withRow = (row: ScreenLine, under: string): ScreenLine[] => [...S.READY.slice(0, 10), row, S.plain(''), S.plain(under)]
  const emptyRow = { text: `${GLYPH} Ask Codex to do anything`, typed: GLYPH }

  it("Codex's own hint lines under a prompt-glyph row are not a footer", () => {
    for (const hint of [`  enter select ${DOT} esc back`, `  enter insert ${DOT} esc close ${DOT} tab switch search modes`,
      `  left/right group ${DOT} e edit shortcut ${DOT} c custom`, `  MCP servers ${DOT} 2 enabled`, `  Git ${DOT} main`, `  dismiss ${DOT} type to continue`]) {
      expect(codexComposerState(withRow(S.plain(`${GLYPH} 4. Extra high        Extra high reasoning depth`), hint)), hint).toBe('not-ready')
      expect(codexComposerState(withRow(emptyRow, hint)), hint).toBe('not-ready')
    }
  })

  it('a footer naming "default" for the effort is one (a model whose own level applies)', () => {
    expect(codexComposerState(withRow(emptyRow, `  gpt-5.2 default ${DOT} C:\\p`))).toBe('ready')
  })

  it("with the session's models known, the footer must name one of them", () => {
    expect(codexComposerState(S.READY, ['gpt-6-astra', 'gpt-5.5'])).toBe('ready')
    expect(codexComposerState(S.READY, ['gpt-5.5'])).toBe('not-ready')
    // A model's dot is a dot, not any character.
    expect(codexComposerState(withRow(emptyRow, `  gpt-5x5 high ${DOT} C:/p`), ['gpt-5.5'])).toBe('not-ready')
    expect(codexComposerState(withRow(emptyRow, `  gpt-5.5 high ${DOT} C:/p`), ['gpt-5.5'])).toBe('ready')
  })

  it("only Codex's two dim placeholders read as empty: a dim paste marker is content", () => {
    expect(codexComposerText(withRow({ text: `${GLYPH} Ask a follow-up question`, typed: GLYPH }, `  gpt-5.5 high ${DOT} C:\\p`))).toBe('')
    const paste = withRow({ text: `${GLYPH} [Pasted Content 1843 chars]`, typed: GLYPH }, `  gpt-5.5 high ${DOT} C:\\p`)
    expect(codexComposerText(paste)).toBe('[Pasted Content 1843 chars]')
    const h = harness(paste)
    expect(typeIntoCodexComposer('s1', '/compact', h.deps).reason).toMatch(/already typed/)
    expect(h.writes).toEqual([])
  })

  it("Codex's approval requests block, wherever they are drawn", () => {
    for (const text of ['  Would you like to run the following command?', '  Would you like to make the following edits?',
      '  Would you like to grant these permissions?', '  Do you want to approve network access to "example.com"?',
      '  Would you like to send input to the existing terminal?', '  codex needs your approval.']) {
      expect(codexComposerState([...S.READY.slice(0, 10), S.plain(text), ...S.READY.slice(10)]), text).toBe('not-ready')
    }
  })

  it('a footer that is not the last row (wrapped by a narrow window, or a row under it) is said as such (WW)', () => {
    const wrapped = [...S.READY.slice(0, 10), emptyRow, S.plain(''), S.plain(`  gpt-6-astra low ${DOT} C:\\Users\\alex\\projects\\a-very-long`), S.plain('  -folder-name')]
    expect(readCodexScreen(wrapped).screen).toBe('unrecognised')
    const h = harness(wrapped)
    expect(typeIntoCodexComposer('s1', '/compact', h.deps).reason).toMatch(/could not be read/)
    expect(readCodexScreen(S.LOADING).screen).not.toBe('unrecognised')
    expect(typeIntoCodexComposer('s1', '/compact', harness(S.LOADING).deps).reason).toMatch(/not at its prompt/)
  })

  it("reads Codex's Plan mode from the footer, and nothing when no footer shows", () => {
    expect(codexPlanModeOnScreen(S.READY_PLAN)).toBe(true)
    expect(codexPlanModeOnScreen(S.READY)).toBe(false)
    expect(codexPlanModeOnScreen(S.TYPED_PLAN)).toBeNull()
    expect(codexPlanModeOnScreen(null)).toBeNull()
  })

  // Round 3 (T19): only the footer row under the composer counts, and only its
  // right-aligned segment after the folder.
  it('a folder named "Plan mode", or a footer-shaped line drawn under a prompt, never reads as Plan mode', () => {
    expect(codexPlanModeOnScreen(withRow(emptyRow, `  gpt-6-astra low ${DOT} C:/dev/Plan mode`))).toBe(false)
    expect(codexPlanModeOnScreen(withRow(emptyRow, `  gpt-6-astra low ${DOT} C:/dev/x Plan mode (shift+tab to cycle)`))).toBe(false)
    const underPrompt = [...S.READY.slice(0, 10), S.plain('  Would you like to run the following command?'), S.plain(`${GLYPH} 1. Yes`),
      S.plain(`  gpt-6-astra low ${DOT} C:/p                                        Plan mode (shift+tab to cycle)`)]
    expect(codexPlanModeOnScreen(underPrompt)).toBeNull()
    const historyLine = [...S.READY.slice(0, 10), S.plain(`  gpt-6-astra low ${DOT} C:/p                                        Plan mode`), ...S.READY.slice(10)]
    expect(codexPlanModeOnScreen(historyLine)).toBe(false)
    const turnRunning = [...S.READY.slice(0, 10), S.plain('  Working (2s, esc to interrupt)'), emptyRow, S.plain(''),
      S.plain(`  gpt-6-astra medium ${DOT} C:/p ${DOT} renaming...                               Plan mode`)]
    expect(codexPlanModeOnScreen(turnRunning)).toBe(true)
  })

  // Round 4 (E4): Codex's right segment ends two cells from the right edge
  // (the raw footer bytes: the segment, then two spaces), so a folder whose
  // name ends in spaces and "Plan mode" does not read as it.
  it('reads Plan mode only from a segment ending two cells from the right edge', () => {
    const W = 120
    const at = (text: string, end: number): ScreenLine => ({ text, typed: text, width: W, end })
    const label = 'Plan mode (shift+tab to cycle)'
    const real = `  gpt-6-astra low ${DOT} C:/p`.padEnd(W - 2 - label.length) + label
    expect(codexPlanModeOnScreen([...S.READY.slice(0, 10), emptyRow, S.plain(''), at(real, W - 2)])).toBe(true)
    const spoof = `  gpt-6-astra low ${DOT} C:/a   Plan mode`
    expect(codexPlanModeOnScreen([...S.READY.slice(0, 10), emptyRow, S.plain(''), at(spoof, spoof.length)])).toBe(false)
  })

  it("with the session's models known, a footer naming another model reads nothing", () => {
    expect(codexPlanModeOnScreen(S.READY_PLAN, ['gpt-6-astra'])).toBe(true)
    expect(codexPlanModeOnScreen(S.READY_PLAN, ['gpt-5.5'])).toBeNull()
  })
})

// P3.8 round 3 (V1): 0.153.4 boots its MCP servers after drawing its prompt,
// with a status row reading like a turn. That is "still starting": not busy,
// not the user's doing. Nothing is typed while it shows, and a command whose
// Enter is withheld is erased, only the app's own characters and only while
// the composer holds exactly them, so nothing is left behind.
describe('Codex still starting (round 3, V1)', () => {
  const DEL = String.fromCharCode(0x7f)
  const GLYPH = String.fromCharCode(0x203a)

  it('the MCP boot row reads as still starting', () => {
    expect(readCodexScreen(S.BOOTING_153).screen).toBe('starting')
    expect(codexComposerState(S.BOOTING_153)).toBe('not-ready')
    expect(codexComposerState(S.READY_153)).toBe('ready')
    const h = harness(S.BOOTING_153)
    const r = typeIntoCodexComposer('s1', '/compact', h.deps)
    expect(r.typed).toBe(false)
    expect(r.reason).toMatch(/still starting/)
    expect(h.writes).toEqual([])
  })

  it('Plan mode waits out the boot row, then types /plan once Codex is ready', () => {
    const h = harness(S.LOADING)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h.deps)
    h.advance(CODEX_READY_POLL_MS * 2)
    h.state.screen = S.BOOTING_153
    h.advance(CODEX_READY_POLL_MS * 8)
    expect(h.writes).toEqual([])
    h.state.screen = S.READY_153
    h.advance(CODEX_READY_POLL_MS)
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(h.writes).toEqual(['/plan', '\r'])
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  it('the boot row coming up after /plan was typed: its Enter is withheld, /plan erased, and typed again once ready (the VM case)', () => {
    const h = harness(S.READY_153)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h.deps)
    h.advance(0)
    expect(h.writes).toEqual(['/plan'])
    h.state.screen = S.TYPED_PLAN_BOOTING_153
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(h.writes).toEqual(['/plan']) // round 4 (E1): read again one poll later first
    h.advance(CODEX_READY_POLL_MS)
    expect(h.writes).toEqual(['/plan', DEL.repeat(5)])
    h.state.screen = S.BOOTING_153 // Codex took the erase
    h.advance(CODEX_READY_POLL_MS * 4)
    h.state.screen = S.READY_153
    h.advance(CODEX_READY_POLL_MS)
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(h.writes).toEqual(['/plan', DEL.repeat(5), '/plan', '\r'])
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  it('gives up, naming the reason, when the boot row keeps coming back', () => {
    const h = harness(S.READY_153)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h.deps)
    for (let i = 0; i < 6; i++) {
      h.state.screen = S.READY_153
      h.advance(CODEX_READY_POLL_MS)
      h.state.screen = S.TYPED_PLAN_BOOTING_153
      h.advance(CODEX_SUBMIT_DELAY_MS + CODEX_READY_POLL_MS) // the Enter withheld, then read again and erased
    }
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(onGiveUp).toHaveBeenCalledWith('starting')
    expect(h.writes.filter((w) => w === '/plan').length).toBe(h.writes.filter((w) => w === DEL.repeat(5)).length)
    expect(planModeNote('starting')).toMatch(/still starting/)
  })

  it('erases only when the composer holds exactly what the app typed, and never under a prompt', () => {
    for (const [later, erased] of [
      [[S.plain('  Working (2s, esc to interrupt)'), S.plain(`${GLYPH} /compact`), S.plain(''), S.plain('  /compact  summarize conversation')], true],
      [[S.plain(`${GLYPH} half a question/compact`), S.plain(''), S.plain('  /compact  summarize conversation')], false],
      [[S.plain(`${GLYPH} /compact`), S.plain(''), S.plain('  Update available! 0.156.0'), S.plain('  Press enter to continue')], false],
    ] as const) {
      const h = harness(S.READY)
      typeIntoCodexComposer('s1', '/compact', h.deps)
      h.state.screen = later as unknown as ScreenLine[]
      h.advance(CODEX_SUBMIT_DELAY_MS + CODEX_READY_POLL_MS)
      expect(h.writes, String(erased)).toEqual(erased ? ['/compact', DEL.repeat(8)] : ['/compact'])
    }
  })

  // Round 4 (E1): the erase waits one poll and reads again, so the user's
  // keys echoed late are never erased with it.
  it("with the user's keys echoed late, nothing is erased and Plan mode gives up with the note", () => {
    const h = harness(S.READY_153)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h.deps)
    h.advance(0)
    h.state.screen = S.TYPED_PLAN_BOOTING_153 // at the Enter: /plan alone, the user's keys not yet echoed
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(h.writes).toEqual(['/plan'])
    h.state.screen = S.TYPED_PLAN_BOOTING_153.map((l) => (l.text === `${GLYPH} /plan` ? S.plain(`${GLYPH} /planfix the `) : l))
    h.advance(CODEX_READY_POLL_MS)
    h.advance(60_000)
    expect(h.writes).toEqual(['/plan'])
    expect(onGiveUp).toHaveBeenCalledWith('interrupted')
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  // Round 4 (E3): the start-up row counts only in its place, the row
  // directly above the composer, and only during the run's start-up (until
  // its first turn is seen or a command is sent).
  it('a "Booting MCP server" line printed in the transcript never hides a running turn', () => {
    const BULLET = String.fromCharCode(0x2022)
    const DOT = String.fromCharCode(0xb7)
    const printed = [...S.READY.slice(0, 10), S.plain(`Booting MCP server: conductor (0s ${BULLET} esc to interrupt)`), S.plain(`${GLYPH} hello`),
      S.plain('  Working (2s, esc to interrupt)'), { text: `${GLYPH} Ask Codex to do anything`, typed: GLYPH }, S.plain(''), S.plain(`  gpt-6-astra low ${DOT} C:/p`)]
    expect(readCodexScreen(printed).screen).toBe('busy')
    const h = harness(printed)
    expect(typeIntoCodexComposer('s1', '/compact', h.deps).reason).toMatch(/busy/)
  })

  it("after the run's first turn, a start-up row reads as the turn it looks like", () => {
    expect(readCodexScreen(S.BOOTING_153, null, { startup: false }).screen).toBe('busy')
    const h = harness(S.WORKING_NOW)
    expect(typeIntoCodexComposer('s1', '/compact', h.deps).reason).toMatch(/busy/) // a turn seen in this run
    h.state.screen = S.BOOTING_153
    expect(typeIntoCodexComposer('s1', '/compact', h.deps).reason).toMatch(/busy/)
    h.state.run = { createdAt: 1000, spawnToken: 8 } // a new run starts up again
    expect(typeIntoCodexComposer('s1', '/compact', h.deps).reason).toMatch(/still starting/)
  })

  it('nothing is written into a run that changed before the Enter, not even the erase', () => {
    const h = harness(S.READY)
    typeIntoCodexComposer('s1', '/compact', h.deps)
    h.state.run = { createdAt: 2000, spawnToken: 8 }
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(h.writes).toEqual(['/compact'])
  })

  // Round 3 (Q1): a write that throws at the Enter still settles the typing.
  it('a failing write at the Enter still settles it, so the session is not left refusing commands', () => {
    const h = harness(S.READY)
    const settled = vi.fn()
    const throwing = { ...h.deps, write: (id: string, d: string) => { if (d === '\r') throw new Error('pty gone'); h.deps.write(id, d) } }
    typeIntoCodexComposer('s1', '/compact', throwing, { onSettled: settled })
    expect(() => h.advance(CODEX_SUBMIT_DELAY_MS)).toThrow('pty gone')
    expect(settled).toHaveBeenCalledTimes(1)
    h.state.screen = S.READY
    expect(typeIntoCodexComposer('s1', '/compact', h.deps).typed).toBe(true)
  })
})

/** A fake session run and screen for the typing helpers. */
function harness(screen: ScreenLine[] | null) {
  const writes: string[] = []
  let timers: Array<{ fn: () => void; at: number; id: number }> = []
  let now = 0
  let nextId = 1
  const state = { screen, run: { createdAt: 1000, spawnToken: 7 } as { createdAt: number; spawnToken: number } | null }
  const deps: CodexComposerDeps = {
    readScreen: () => state.screen,
    currentRun: () => state.run,
    // A run of DEL (the app erasing what it typed) changes nothing here: the tests set Codex's next screen.
    write: (_id, d) => { writes.push(d); if (d !== '\r' && !/^\x7f+$/.test(d) && state.screen) state.screen = typedInto(state.screen, d) },
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ fn, at: now + ms, id }); return id },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id) },
    pending: new Set<string>(),
    startupDone: new Set<string>(),
  }
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      timers = timers.filter((t) => t !== due)
      now = due.at
      due.fn()
    }
    now = until
  }
  return { writes, deps, state, advance }
}

/** The screen after `text` is typed into the composer (its popup, no footer). */
function typedInto(screen: ScreenLine[], text: string): ScreenLine[] {
  let i = -1
  screen.forEach((l, k) => { if (/^[\u203a\u00bb] /.test(l.text)) i = k })
  const before = codexComposerText(screen)
  const line = `\u203a ${before}${text}`
  return [...screen.slice(0, i), { text: line, typed: line }, { text: '', typed: '' }, { text: `  ${text}  a command`, typed: `  ${text}  a command` }]
}

describe('typeIntoCodexComposer', () => {
  it('types the command, then Enter on its own once the burst is over', () => {
    const h = harness(S.READY)
    const r = typeIntoCodexComposer('s1', '/compact', h.deps)
    expect(r.typed).toBe(true)
    expect(h.writes).toEqual(['/compact'])
    h.advance(CODEX_SUBMIT_DELAY_MS - 1)
    expect(h.writes).toEqual(['/compact'])
    h.advance(1)
    expect(h.writes).toEqual(['/compact', '\r'])
  })

  it('types nothing, and says why, when the composer is not ready, busy, or holds the user\'s text', () => {
    for (const [screen, reason] of [
      [S.TRUST, /not at its prompt/], [S.MODEL_PICKER, /not at its prompt/], [S.LOADING, /not at its prompt/],
      [S.WORKING_NOW, /busy/], [S.USER_TYPING, /typed/], [null, /not at its prompt/],
    ] as const) {
      const h = harness(screen as ScreenLine[] | null)
      const r = typeIntoCodexComposer('s1', '/compact', h.deps)
      expect(r.typed).toBe(false)
      expect(r.reason).toMatch(reason)
      h.advance(CODEX_SUBMIT_DELAY_MS * 3)
      expect(h.writes).toEqual([])
    }
  })

  it('types nothing into a session with no live run', () => {
    const h = harness(S.READY)
    h.state.run = null
    expect(typeIntoCodexComposer('s1', '/compact', h.deps).typed).toBe(false)
    expect(h.writes).toEqual([])
  })

  it('presses Enter only when the composer holds exactly the command (C3)', () => {
    const h = harness(S.READY)
    typeIntoCodexComposer('s1', '/compact', h.deps)
    h.state.screen = S.TYPED_AFTER_USER
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(h.writes).toEqual(['/compact'])
  })

  it('presses Enter only into the same run: a Restart (createdAt) or a new PTY (spawn token) in between cancels it (C2)', () => {
    for (const next of [{ createdAt: 2000, spawnToken: 7 }, { createdAt: 1000, spawnToken: 8 }, null]) {
      const h = harness(S.READY)
      typeIntoCodexComposer('s1', '/compact', h.deps)
      h.state.run = next
      h.advance(CODEX_SUBMIT_DELAY_MS)
      expect(h.writes, JSON.stringify(next)).toEqual(['/compact'])
    }
  })

  it('cancel() drops the pending Enter', () => {
    const h = harness(S.READY)
    const r = typeIntoCodexComposer('s1', '/compact', h.deps)
    r.cancel()
    h.advance(CODEX_SUBMIT_DELAY_MS * 2)
    expect(h.writes).toEqual(['/compact'])
  })

  // P3.8 round 2 (G5): the Enter goes only to a screen showing the command
  // typed at the composer with nothing in the way, not merely a composer row
  // holding it.
  it('no Enter when a prompt, a running turn or anything but its popup shows with the command typed', () => {
    const GLYPH = String.fromCharCode(0x203a)
    for (const later of [
      [S.plain(`${GLYPH} /compact`), S.plain(''), S.plain('  Update available! 0.156.0'), S.plain('  Press enter to continue')],
      [S.plain(`${GLYPH} /compact`), S.plain(''), S.plain('  Working (2s, esc to interrupt)')],
      [S.plain(`${GLYPH} /compact`), S.plain(''), S.plain('  Something else entirely')],
      // Above the command, with only its popup under it: a notice, or a turn running.
      [S.plain('  Press enter to continue'), S.plain(`${GLYPH} /compact`), S.plain(''), S.plain('  /compact  summarize conversation')],
      [S.plain('  Working (2s, esc to interrupt)'), S.plain(`${GLYPH} /compact`), S.plain(''), S.plain('  /compact  summarize conversation')],
    ]) {
      const h = harness(S.READY)
      typeIntoCodexComposer('s1', '/compact', h.deps)
      h.state.screen = later
      h.advance(CODEX_SUBMIT_DELAY_MS)
      // No Enter (round 3 erases the command where the composer takes keys; see below).
      expect(h.writes[0]).toBe('/compact')
      expect(h.writes, later.map((l) => l.text).join(' | ')).not.toContain('\r')
    }
  })

  // P3.8 round 2 (DP): while a command's Enter is pending for a session,
  // nothing more is typed into it (a second press before Codex redraws would
  // type the command twice).
  it('refuses a second command while one is pending for the session, and takes one again once it is sent or dropped', () => {
    const h = harness(S.READY)
    const lagging = { ...h.deps, write: (_id: string, d: string) => { h.writes.push(d) } } // Codex has not redrawn yet
    expect(typeIntoCodexComposer('s1', '/compact', lagging).typed).toBe(true)
    const second = typeIntoCodexComposer('s1', '/compact', lagging)
    expect(second.typed).toBe(false)
    expect(second.reason).toMatch(/already on its way/)
    expect(typeIntoCodexComposer('s1', '/model', lagging).typed).toBe(false)
    expect(typeIntoCodexComposer('s2', '/compact', lagging).typed).toBe(true)
    expect(h.writes).toEqual(['/compact', '/compact'])
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(typeIntoCodexComposer('s1', '/compact', lagging).typed).toBe(true)
    const r = typeIntoCodexComposer('s3', '/compact', lagging)
    r.cancel()
    expect(typeIntoCodexComposer('s3', '/compact', lagging).typed).toBe(true)
  })

  it('reports whether the Enter was sent', () => {
    const sent = vi.fn()
    const h = harness(S.READY)
    typeIntoCodexComposer('s1', '/compact', h.deps, { onSettled: sent })
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(sent.mock.calls[0][0]).toBe(true)
    const withheld = vi.fn()
    const h2 = harness(S.READY)
    typeIntoCodexComposer('s1', '/compact', h2.deps, { onSettled: withheld })
    h2.state.screen = S.TYPED_AFTER_USER
    h2.advance(CODEX_SUBMIT_DELAY_MS)
    expect(withheld.mock.calls[0][0]).toBe(false)
    expect(withheld.mock.calls[0][1]).toMatchObject({ reason: 'text', erased: false })
    expect(withheld).toHaveBeenCalledTimes(1)
  })
})

describe('typeWhenCodexComposerReady (Plan mode at launch, L2; round 2, PM1: the first ready screen only)', () => {
  it('waits through loading and the trust prompt, then types the command once the composer is ready', () => {
    const h = harness(S.LOADING)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h.deps)
    h.advance(CODEX_READY_POLL_MS * 3)
    h.state.screen = S.TRUST
    h.advance(CODEX_READY_POLL_MS * 10)
    expect(h.writes).toEqual([])
    h.state.screen = S.READY
    h.advance(CODEX_READY_POLL_MS)
    expect(h.writes).toEqual(['/plan'])
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(h.writes).toEqual(['/plan', '\r'])
    h.advance(60_000)
    expect(h.writes).toEqual(['/plan', '\r'])
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  it('gives up, with a note and nothing typed, when the composer is never ready in time', () => {
    const h = harness(S.TRUST)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 5_000, onGiveUp }, h.deps)
    h.advance(10_000)
    expect(h.writes).toEqual([])
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(onGiveUp).toHaveBeenCalledWith('timeout')
  })

  it('stops, silently, when the run it waited for ends or is replaced; cancel() stops it too', () => {
    const h = harness(S.TRUST)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h.deps)
    h.state.run = { createdAt: 2000, spawnToken: 8 }
    h.state.screen = S.READY
    h.advance(60_000)
    expect(h.writes).toEqual([])
    expect(onGiveUp).not.toHaveBeenCalled()
    const h2 = harness(S.TRUST)
    const w = typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h2.deps)
    w.cancel()
    h2.state.screen = S.READY
    h2.advance(60_000)
    expect(h2.writes).toEqual([])
  })

  it('cancel() after it typed drops the pending Enter too, and reports nothing (the view is gone)', () => {
    const h = harness(S.READY)
    const onGiveUp = vi.fn()
    const w = typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h.deps)
    h.advance(0)
    expect(h.writes).toEqual(['/plan'])
    w.cancel()
    h.advance(CODEX_SUBMIT_DELAY_MS * 2)
    expect(h.writes).toEqual(['/plan'])
    expect(onGiveUp).not.toHaveBeenCalled()
  })

  it("the first ready screen already holds the user's text: gives up at once, and types nothing even when the composer empties", () => {
    const h = harness(S.LOADING)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h.deps)
    h.advance(CODEX_READY_POLL_MS * 2)
    h.state.screen = S.USER_TYPING
    h.advance(CODEX_READY_POLL_MS)
    expect(onGiveUp).toHaveBeenCalledWith('interrupted')
    h.state.screen = S.READY
    h.advance(60_000)
    expect(h.writes).toEqual([])
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  it('a turn seen running (the user typed and submitted first) gives up: /plan never lands mid-conversation', () => {
    const h = harness(S.TRUST)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h.deps)
    h.advance(CODEX_READY_POLL_MS)
    h.state.screen = S.WORKING_NOW
    h.advance(CODEX_READY_POLL_MS)
    h.state.screen = S.READY
    h.advance(60_000)
    expect(h.writes).toEqual([])
    expect(onGiveUp).toHaveBeenCalledWith('interrupted')
    expect(onGiveUp).toHaveBeenCalledTimes(1)
  })

  it("typed but its Enter withheld (the user typed within the window): says so, as the user's typing", () => {
    const h = harness(S.READY)
    const onGiveUp = vi.fn()
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp }, h.deps)
    h.advance(0)
    expect(h.writes).toEqual(['/plan'])
    h.state.screen = S.TYPED_AFTER_USER
    h.advance(CODEX_SUBMIT_DELAY_MS)
    expect(h.writes).toEqual(['/plan'])
    expect(onGiveUp).toHaveBeenCalledWith('interrupted')
  })

  it('the note says Plan mode is not on, that the session is read-only, and how to go on', () => {
    for (const why of ['timeout', 'interrupted', 'blocked', 'unreadable', 'starting', 'not-sent'] as const) {
      const note = planModeNote(why)
      expect(note).toMatch(/Plan mode is not on/)
      expect(note).toMatch(/read-only/)
      expect(note).toMatch(/\/plan/)
      expect(note).toMatch(/\/permissions/)
    }
    expect(planModeNote('timeout')).not.toBe(planModeNote('interrupted'))
  })
})
