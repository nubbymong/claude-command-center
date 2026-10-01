// P3.15 (row 70): Alt+V pressed with focus outside the terminal, on a Codex
// session. The app saves the clipboard image and types a line naming it, as it
// does for Claude; the VM run showed that in Codex the line's em dash was
// dropped and its Enter, written with the line, did not submit it (Codex takes
// a fast burst of typed characters ending in Enter as a paste). So for Codex
// the line is ASCII and is typed the way the app types anything into Codex
// (P3.8): only into the ready, empty composer, with Enter on its own after the
// burst, and only when the screen then shows exactly that line. When it cannot
// be sent, the user is told why.
import { describe, it, expect } from 'vitest'
import {
  sendImagePathToCodex,
  CODEX_IMAGE_LINE,
  IMAGE_TYPED_NOT_SENT,
  IMAGE_TAKEN_BACK,
  IMAGE_BEHIND_QUESTION,
  CODEX_SUBMIT_DELAY_MS,
  CODEX_READY_POLL_MS,
  NOT_AT_PROMPT,
  BUSY_NOW,
  TEXT_IN_PROMPT,
  StartupDoneRuns,
  codexTextTyped,
  type ScreenLine,
  type CodexComposerDeps,
} from '../../../src/renderer/lib/codexComposer'
import * as S from './codex-composer-screens'

const GLYPH = String.fromCharCode(0x203a)
const PATH = 'C:\\Users\\alex\\Conductor\\screenshots\\clipboard-1727791234567.jpg'
const LINE = `${CODEX_IMAGE_LINE} ${PATH}`

/** READY with `row` in the composer's place (the footer still under it). */
const composerShows = (...rows: string[]): ScreenLine[] => {
  const i = S.READY.findIndex((l) => l.text.startsWith(GLYPH))
  return [...S.READY.slice(0, i), ...rows.map(S.plain), ...S.READY.slice(i + 1)]
}

/** A fake session: its screen, its run, and what Codex draws after a write. */
function harness(screen: ScreenLine[] | null, afterTyping?: (typed: string) => ScreenLine[]) {
  const writes: string[] = []
  const notes: string[] = []
  let timers: Array<{ fn: () => void; at: number; id: number }> = []
  let now = 0
  let nextId = 1
  const state = { screen, run: { createdAt: 1000, spawnToken: 7 } as { createdAt: number; spawnToken: number } | null }
  const deps: CodexComposerDeps = {
    readScreen: () => state.screen,
    currentRun: () => state.run,
    write: (_id, d) => {
      writes.push(d)
      if (d !== '\r' && !/^\x7f+$/.test(d)) state.screen = afterTyping ? afterTyping(d) : composerShows(`${GLYPH} ${d}`)
    },
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ fn, at: now + ms, id }); return id },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id) },
    pending: new Set<string>(),
    startupDone: new StartupDoneRuns(),
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
  const send = () => sendImagePathToCodex('s1', PATH, (n) => notes.push(n), deps)
  return { writes, notes, state, advance, send }
}

describe('sendImagePathToCodex (P3.15, row 70)', () => {
  it('types the line naming the image into the ready, empty composer, then Enter on its own once the burst is over', () => {
    const h = harness(S.READY)
    h.send()
    expect(h.writes).toEqual([LINE])
    h.advance(CODEX_SUBMIT_DELAY_MS - 1)
    expect(h.writes).toEqual([LINE])
    h.advance(1)
    expect(h.writes).toEqual([LINE, '\r'])
    expect(h.notes).toEqual([])
  })

  it('the line is plain ASCII (Codex dropped the em dash of the line Claude gets) and still asks the assistant to view the image', () => {
    expect(CODEX_IMAGE_LINE).toBe('I just pasted an image - please view it.')
    expect([...LINE.slice(0, CODEX_IMAGE_LINE.length)].every((c) => c.charCodeAt(0) < 0x80)).toBe(true)
    expect(LINE.endsWith(` ${PATH}`)).toBe(true)
  })

  it('types nothing, and says why, when Codex is not at its prompt, is busy, or something is typed there already', () => {
    for (const [screen, note] of [
      [S.TRUST, NOT_AT_PROMPT], [S.MODEL_PICKER, NOT_AT_PROMPT], [null, NOT_AT_PROMPT],
      [S.WORKING_NOW, BUSY_NOW], [S.USER_TYPING, TEXT_IN_PROMPT],
    ] as const) {
      const h = harness(screen as ScreenLine[] | null)
      h.send()
      h.advance(CODEX_SUBMIT_DELAY_MS * 4)
      expect(h.writes, note).toEqual([])
      expect(h.notes, note).toEqual([note])
    }
  })

  // Round 1 (F8): in a narrow (split) pane the line wraps onto more composer
  // rows. Codex draws the rows after the first indented under the text; the
  // line is sent when those rows, read together, hold exactly the line, and
  // the footer is still the last row (a wrap may fall at a space, which the
  // wrap then takes, or inside a word).
  it('round 1 (F8): a line that wraps onto the next composer rows is still sent, wherever the wrap falls', () => {
    const atSpace = (d: string): ScreenLine[] => composerShows(`${GLYPH} ${CODEX_IMAGE_LINE}`, `  ${d.slice(CODEX_IMAGE_LINE.length + 1)}`)
    const midWord = (d: string): ScreenLine[] => composerShows(`${GLYPH} ${d.slice(0, 30)}`, `  ${d.slice(30, 70)}`, `  ${d.slice(70)}`)
    for (const [name, after] of [['at a space', atSpace], ['inside words', midWord]] as const) {
      const h = harness(S.READY, after)
      h.send()
      h.advance(CODEX_SUBMIT_DELAY_MS)
      expect(h.writes, name).toEqual([LINE, '\r'])
      expect(h.notes, name).toEqual([])
    }
  })

  it('round 1 (F8): wrapped rows holding anything more than the line are left typed, not sent, and the user is told to check it and press Enter', () => {
    const more = (d: string): ScreenLine[] => composerShows(`${GLYPH} ${d.slice(0, 50)}`, `  ${d.slice(50)} and more`)
    const h = harness(S.READY, more)
    h.send()
    h.advance(CODEX_SUBMIT_DELAY_MS + CODEX_READY_POLL_MS * 2)
    expect(h.writes).toEqual([LINE])
    expect(h.notes).toEqual([IMAGE_TYPED_NOT_SENT])
  })

  it('round 1 (F8): a row under the line that is not one of its wrapped rows (not indented) stops the Enter', () => {
    const stray = (d: string): ScreenLine[] => composerShows(`${GLYPH} ${d.slice(0, 50)}`, `${d.slice(50)}`)
    const h = harness(S.READY, stray)
    h.send()
    h.advance(CODEX_SUBMIT_DELAY_MS + CODEX_READY_POLL_MS * 2)
    expect(h.writes).toEqual([LINE])
    expect(h.notes).toEqual([IMAGE_TYPED_NOT_SENT])
  })

  it('when Codex\'s start-up row comes up under the line, what the app typed is taken back and the user is told', () => {
    const booting = (d: string): ScreenLine[] => S.BOOTING_153.map((l) => (l.text.startsWith(GLYPH) ? S.plain(`${GLYPH} ${d}`) : l))
    const h = harness(S.READY, booting)
    h.send()
    h.advance(CODEX_SUBMIT_DELAY_MS + CODEX_READY_POLL_MS * 2)
    expect(h.writes).toEqual([LINE, String.fromCharCode(0x7f).repeat(LINE.length)])
    expect(h.notes).toEqual([IMAGE_TAKEN_BACK])
  })

  it('when Codex puts up a question before the Enter, no Enter goes into it, and the user is told to answer it first', () => {
    const asking = (d: string): ScreenLine[] => [S.plain('  Would you like to make the following edits?'), ...composerShows(`${GLYPH} ${d}`)]
    const h = harness(S.READY, asking)
    h.send()
    h.advance(CODEX_SUBMIT_DELAY_MS + CODEX_READY_POLL_MS * 2)
    expect(h.writes).toEqual([LINE])
    expect(h.notes).toEqual([IMAGE_BEHIND_QUESTION])
  })

  it('says nothing when the session restarted before the Enter (the line went with that run)', () => {
    const h = harness(S.READY)
    h.send()
    h.state.run = { createdAt: 2000, spawnToken: 8 }
    h.advance(CODEX_SUBMIT_DELAY_MS * 4)
    expect(h.writes).toEqual([LINE])
    expect(h.notes).toEqual([])
  })
})

// Round 1 (F8): the wrapped reading itself.
describe('codexTextTyped (round 1, F8)', () => {
  const wrapped = composerShows(`${GLYPH} ${LINE.slice(0, 40)}`, `  ${LINE.slice(40, 80)}`, `  ${LINE.slice(80)}`)
  it('holds on the wrapped rows, and on one row', () => {
    expect(codexTextTyped(wrapped, LINE)).toBe(true)
    expect(codexTextTyped(composerShows(`${GLYPH} ${LINE}`), LINE)).toBe(true)
  })
  it('never while a turn runs, a prompt is up, the footer is not the last row, or for nothing', () => {
    const busy = [...wrapped.slice(0, 10), S.plain(String.fromCharCode(0x25e6) + ' Working (2s ' + String.fromCharCode(0x2022) + ' esc to interrupt)'), ...wrapped.slice(10)]
    expect(codexTextTyped(busy, LINE)).toBe(false)
    expect(codexTextTyped([S.plain('  Press enter to continue'), ...wrapped], LINE)).toBe(false)
    const footerFirst = wrapped.filter((l) => l.text.trim() !== '')
    const noFooterLast = [...footerFirst.slice(0, -1), footerFirst[footerFirst.length - 1], S.plain('  more under the footer')]
    expect(codexTextTyped(noFooterLast, LINE)).toBe(false)
    expect(codexTextTyped(S.READY, '')).toBe(false)
    expect(codexTextTyped(null, LINE)).toBe(false)
  })
  it('a slash command still goes by its own rule (its popup is not a wrapped row)', () => {
    expect(codexTextTyped(S.TYPED_COMPACT, '/compact')).toBe(false)
  })
})
