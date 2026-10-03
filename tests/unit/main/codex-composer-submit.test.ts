// [host] WP2 PR 4, P4.1 (row 51): the submit primitive's rule
// (src/main/providers/codex/composer-submit.ts), against a simulated Codex
// composer that behaves as the PR 4 VM probes measured the real 0.153.4 and
// 0.155.1 TUIs (PB3, PB9): a write is drawn only after a delay (the composer
// looks empty meanwhile); up to 1,000 code points the text is drawn (wrapped
// under the prompt, the composer at most the pane's rows minus 4 high, a
// taller text scrolled so its first rows are hidden); from 1,001 it is folded
// into "[Pasted Content N chars]"; an Enter before the draw is swallowed;
// Ctrl+U clears the composer; Ctrl+C would quit it. Time is a fake clock:
// every wait the rule makes advances it.
import { describe, it, expect } from 'vitest'
import {
  submitToCodexComposer, submitIngestionWindowMs, submitTextRefusal, estimateComposerRows, TAKE_BACK_KEY,
  SUBMIT_EXACT_CONFIRM_MS, SUBMIT_FOLDED_CONFIRM_MS, type ComposerSubmitDeps,
} from '../../../src/main/providers/codex/composer-submit'
import type { ScreenLine } from '../../../src/shared/codex-screen'

const P = String.fromCharCode(0x203a)
const DOT = String.fromCharCode(0xb7)
const EM = String.fromCharCode(0x2014)
const ENTER = '\r'
const CTRL_C = String.fromCharCode(3)
const plain = (text: string): ScreenLine => ({ text, typed: text })
const MARKER = `Review #3 ${EM} 5 notes ${DOT} canvas_review R3`
const WORDS = 'alpha beta gamma delta epsilon zeta theta kappa lambda canvas review notes 42 probe '
const ascii = (n: number): string => WORDS.repeat(Math.ceil(n / WORDS.length) + 1).slice(0, n).replace(/ $/, 'x')

type Prompt = 'approval' | 'sandbox' | 'trust' | null

interface SimOptions {
  cols?: number
  rows?: number
  /** How long a write takes to draw, by its code points. */
  drawMs?: (codePoints: number) => number
  /** The composer never draws the write (PB9's held-text event). */
  held?: boolean
  /** Codex runs a turn until this time. */
  busyUntil?: number
  /** A prompt is on screen between these times. */
  prompt?: { kind: Prompt; from: number; to: number }
  /** Codex wraps narrower than the pane says (to drive a taller composer). */
  wrapCols?: number
  /** The placeholder counts this many fewer code points than were written. */
  foldShortBy?: number
  /** A prompt comes up as the text is written (the race window between the
   *  second ready read and the write). */
  promptOnWrite?: Prompt
  /** How long that prompt stays up (default: for good). */
  promptOnWriteMs?: number
}

/** A simulated Codex composer, with the rule's deps over it. */
function sim(opts: SimOptions = {}) {
  const cols = opts.cols ?? 80
  const rows = opts.rows ?? 24
  let t = 0
  let pending: { text: string; drawAt: number } | null = null
  let composer = ''
  let quit = false
  let alive = true
  const writes: Array<{ at: number; data: string }> = []
  const submitted: string[] = []

  const settle = (): void => {
    if (pending && !opts.held && t >= pending.drawAt) {
      composer += pending.text
      pending = null
    }
  }
  const promptNow = (): Prompt => (opts.prompt && t >= opts.prompt.from && t < opts.prompt.to ? opts.prompt.kind : null)
  const busy = (): boolean => (opts.busyUntil ?? 0) > t

  const composerRows = (): ScreenLine[] => {
    const n = [...composer].length
    if (composer === '') return [{ text: `${P} Ask Codex to do anything`, typed: P }]
    if (n > 1000) return [plain(`${P} [Pasted Content ${n - (opts.foldShortBy ?? 0)} chars]`)]
    const width = Math.max(4, (opts.wrapCols ?? cols) - 2)
    const chunks: string[] = []
    for (let i = 0; i < composer.length; i += width) chunks.push(composer.slice(i, i + width))
    const lines = chunks.map((c, i) => plain(i === 0 ? `${P} ${c}` : `  ${c.replace(/^ +/, '')}`))
    const max = rows - 4
    if (lines.length <= max) return lines
    const shown = lines.slice(lines.length - max)
    shown[0] = plain(`${P} ${shown[0].text.trimStart()}`)
    return shown
  }

  const readScreen = (): ScreenLine[] => {
    settle()
    if (quit) return [plain('PS C:\\dev\\demo>')]
    const head = [plain('  Tip: New Build faster with Codex.')]
    const footer = plain(`  gpt-5.5 medium ${DOT} C:\\dev\\demo`)
    const kind = promptNow()
    if (kind === 'approval') return [...head, plain('  Allow the conductor MCP server to run tool "canvas_render"?'), plain(`  ${P} 1. Allow`), plain('  enter to submit | esc to cancel')]
    if (kind === 'sandbox') return [...head, plain('  Set up the Codex agent sandbox to protect your files and control network access.'), plain(`${P} 1. Set up default sandbox (requires Administrator permissions)`), plain('  Press enter to confirm or esc to go back')]
    if (kind === 'trust') return [...head, plain('  Do you trust the contents of this directory?'), plain(`${P} 1. Yes, continue`), plain('  Press enter to continue')]
    return [...head, ...(busy() ? [plain('\u2022 Working (2s \u2022 esc to interrupt)')] : []), ...composerRows(), footer]
  }

  const deps: ComposerSubmitDeps = {
    readScreen,
    size: () => ({ cols, rows }),
    write: (data) => {
      writes.push({ at: t, data })
      settle()
      if (data === ENTER) {
        if (pending || composer === '') return // swallowed: nothing drawn yet
        submitted.push(composer)
        composer = ''
        return
      }
      if (data === TAKE_BACK_KEY) { pending = null; composer = ''; return }
      if (data === CTRL_C) { if (composer === '') quit = true; return }
      pending = { text: data, drawAt: t + (opts.drawMs ?? ((n) => 250 + n * 0.3))([...data].length) }
      if (opts.promptOnWrite) opts.prompt = { kind: opts.promptOnWrite, from: t, to: t + (opts.promptOnWriteMs ?? Number.POSITIVE_INFINITY) }
    },
    live: () => alive && !quit,
    now: () => t,
    sleep: async (ms) => { t += Math.max(0, ms) },
  }
  return {
    deps, writes, submitted,
    end: () => { alive = false },
    get now() { return t },
    get composer() { settle(); return composer },
    advanceTo: (to: number) => { t = Math.max(t, to) },
  }
}

const noCtrlC = (writes: Array<{ data: string }>): void => {
  for (const w of writes) expect(w.data.includes(CTRL_C), 'no write ever holds Ctrl+C').toBe(false)
}

describe('the submit primitive: typed, confirmed, then Enter', () => {
  it('types the marker in one write and submits it once the screen shows it, byte for byte', async () => {
    const s = sim()
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: true })
    expect(s.writes.map((w) => w.data)).toEqual([MARKER, ENTER])
    expect(s.submitted).toEqual([MARKER])
    noCtrlC(s.writes)
  })

  it('a slow draw gets no early Enter: the poll waits for the whole text (PB9: 26 characters not drawn at 0.4 s)', async () => {
    const s = sim({ drawMs: () => 1_200 })
    const r = await submitToCodexComposer('P89-MARKER-0123456789abcde', s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: true })
    const typedAt = s.writes[0].at
    const enter = s.writes.find((w) => w.data === ENTER)!
    expect(enter.at - typedAt).toBeGreaterThanOrEqual(1_200)
    expect(s.submitted).toEqual(['P89-MARKER-0123456789abcde'])
  })

  it('a text wrapped over several rows is confirmed by codexTextTyped (exact mode, up to 1,000 code points)', async () => {
    const text = ascii(1_000)
    const s = sim({ cols: 200, rows: 38 })
    const r = await submitToCodexComposer(text, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: true })
    expect(s.submitted).toEqual([text])
  })

  it('folded mode from 1,001 code points: Enter only once the placeholder names exactly N', async () => {
    const text = ascii(8_000)
    const s = sim({ drawMs: () => 2_850 })
    const r = await submitToCodexComposer(text, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: true })
    expect(s.writes.map((w) => w.data)).toEqual([text, ENTER])
    expect(s.writes[1].at - s.writes[0].at).toBeGreaterThanOrEqual(2_850)
    expect(s.submitted).toEqual([text])
  })

  it('a placeholder naming another count is never this text: taken back, not delivered', async () => {
    const text = ascii(2_000)
    const s = sim({ foldShortBy: 1 })
    const r = await submitToCodexComposer(text, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: false, reason: 'not-drawn' })
    expect(s.writes.map((w) => w.data)).toEqual([text, TAKE_BACK_KEY])
    expect(s.submitted).toEqual([])
    expect(s.composer).toBe('')
  })
})

describe('the band neither mode confirms: a visible text taller than the composer', () => {
  it('refused untyped when it cannot fit the composer at this pane size (1,000 code points at 80 by 16)', async () => {
    const s = sim({ cols: 80, rows: 16 })
    const r = await submitToCodexComposer(ascii(1_000), s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: false, reason: 'too-tall' })
    expect(s.writes).toEqual([])
  })

  it('one that reached the composer\'s full height anyway is taken back and reported too tall', async () => {
    // Codex wraps narrower than the estimate assumed: the composer fills to
    // rows minus 4 and its first rows scroll out of sight.
    const s = sim({ cols: 80, rows: 24, wrapCols: 20 })
    const text = ascii(600)
    expect(estimateComposerRows(text, 80)).toBeLessThanOrEqual(20)
    const r = await submitToCodexComposer(text, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: false, reason: 'too-tall' })
    expect(s.writes.map((w) => w.data)).toEqual([text, TAKE_BACK_KEY])
    expect(s.composer).toBe('')
    noCtrlC(s.writes)
  })
})

describe('take-back: Ctrl+U only, after the ingestion window', () => {
  it('a write never drawn (PB9\'s held text) is taken back after its window and reported not delivered', async () => {
    const text = ascii(8_000)
    const s = sim({ held: true })
    const r = await submitToCodexComposer(text, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: false, reason: 'not-drawn' })
    const [typed, back] = s.writes
    expect(typed.data).toBe(text)
    expect(back.data).toBe(TAKE_BACK_KEY)
    expect(back.at - typed.at).toBeGreaterThanOrEqual(submitIngestionWindowMs(8_000))
    expect(back.at - typed.at).toBeGreaterThanOrEqual(SUBMIT_FOLDED_CONFIRM_MS)
    expect(s.writes).toHaveLength(2)
    noCtrlC(s.writes)
  })

  it('a short write never drawn: the exact mode\'s bound, then Ctrl+U', async () => {
    const s = sim({ held: true })
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: false, reason: 'not-drawn' })
    expect(s.writes.map((w) => w.data)).toEqual([MARKER, TAKE_BACK_KEY])
    expect(s.writes[1].at - s.writes[0].at).toBeGreaterThanOrEqual(SUBMIT_EXACT_CONFIRM_MS)
  })

  it('the ingestion window grows with the text (PB9: up to about 2.9 s at 8,000 code points)', () => {
    expect(submitIngestionWindowMs(200)).toBeGreaterThanOrEqual(250)
    expect(submitIngestionWindowMs(8_000)).toBeGreaterThanOrEqual(2_900)
    expect(submitIngestionWindowMs(8_000)).toBeGreaterThan(submitIngestionWindowMs(1_000))
  })
})

describe('never into a prompt', () => {
  it.each(['approval', 'sandbox', 'trust'] as const)('waits while the %s screen is up, and types only at the ready composer after it', async (kind) => {
    const s = sim({ prompt: { kind, from: 0, to: 3_000 } })
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: true })
    expect(s.writes[0].at).toBeGreaterThanOrEqual(3_000)
  })

  it('a prompt that stays up past the wait: not delivered, nothing typed', async () => {
    const s = sim({ prompt: { kind: 'approval', from: 0, to: 60_000 } })
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 5_000 })
    expect(r).toEqual({ delivered: false, reason: 'prompt-on-screen' })
    expect(s.writes).toEqual([])
  })

  it('ready on two reads 300 ms apart: a prompt that comes up between them stops the write', async () => {
    // Ready at the first read, the approval form at the second.
    const s = sim({ prompt: { kind: 'approval', from: 100, to: 2_000 } })
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: true })
    expect(s.writes[0].at).toBeGreaterThanOrEqual(2_000)
  })

  it('a prompt on the re-read right after the write: no further key, not delivered', async () => {
    // The approval form comes up as the text is written: the race window
    // between the second ready read and the write.
    // It is up only for a moment: the re-read catches it; a later poll would not.
    const s = sim({ promptOnWrite: 'approval', promptOnWriteMs: 50 })
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: false, reason: 'prompt-on-screen' })
    expect(s.writes.map((w) => w.data)).toEqual([MARKER])
  })

  it('a prompt that comes up before the text is confirmed: no further key', async () => {
    const s = sim({ drawMs: () => 2_000, prompt: { kind: 'approval', from: 1_000, to: 60_000 } })
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 10_000 })
    expect(r).toEqual({ delivered: false, reason: 'prompt-on-screen' })
    expect(s.writes.map((w) => w.data)).toEqual([MARKER])
  })
})

describe('busy, gone, refused', () => {
  it('waits while a turn runs, then delivers', async () => {
    const s = sim({ busyUntil: 20_000 })
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 120_000 })
    expect(r).toEqual({ delivered: true })
    expect(s.writes[0].at).toBeGreaterThanOrEqual(20_000)
  })

  it('a turn longer than the wait: busy-timeout, nothing typed', async () => {
    const s = sim({ busyUntil: 200_000 })
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 120_000 })
    expect(r).toEqual({ delivered: false, reason: 'busy-timeout' })
    expect(s.writes).toEqual([])
  })

  it('the session ends while it waits: session-gone, nothing more', async () => {
    const s = sim({ busyUntil: 200_000 })
    const run = submitToCodexComposer(MARKER, { ...s.deps, sleep: async (ms) => { await s.deps.sleep(ms); if (s.now > 5_000) s.end() } }, { readyWaitMs: 120_000 })
    expect(await run).toEqual({ delivered: false, reason: 'session-gone' })
    expect(s.writes).toEqual([])
  })

  it('something already typed at the composer is never added to', async () => {
    const s = sim()
    s.deps.write('half a thought')
    s.advanceTo(2_000)
    const writesBefore = s.writes.length
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 1_000 })
    expect(r).toEqual({ delivered: false, reason: 'busy-timeout' })
    expect(s.writes).toHaveLength(writesBefore)
  })

  it.each([
    ['a newline', `Review #3${String.fromCharCode(10)}rm -rf .`],
    ['a carriage return', `Review #3${String.fromCharCode(13)}`],
    ['an escape', `Review${String.fromCharCode(27)}[2J`],
    ['a DEL', `Review${String.fromCharCode(127)}`],
    ['a C1 control', `Review${String.fromCharCode(0x9b)}`],
    ['a character outside the BMP', `Review ${String.fromCodePoint(0x1f680)}`],
    ['a lone surrogate', `Review ${String.fromCharCode(0xd83d)}`],
    ['nothing', ''],
  ])('refuses a text holding %s, typing nothing', async (_name, text) => {
    expect(submitTextRefusal(text)).toBe('refused-text')
    const s = sim()
    expect(await submitToCodexComposer(text, s.deps, { readyWaitMs: 1_000 })).toEqual({ delivered: false, reason: 'refused-text' })
    expect(s.writes).toEqual([])
  })

  it('takes the canvas marker lines as written, U+2014 and U+00B7 included (PB3)', () => {
    expect(submitTextRefusal(MARKER)).toBeNull()
    expect(submitTextRefusal(`Approved v7 on the canvas ${DOT} canvas_version_verdict recorded`)).toBeNull()
  })
})

describe('every read waits for the screen to draw what the session has sent (ADR-009 round 1)', () => {
  // A pane parses the session's output a moment after main receives it: the
  // screen a read sees ("drawn") can be behind what has arrived ("received").
  // `settle` draws everything received; a read before it would be stale.
  const head = [plain('  Tip: New Build faster with Codex.')]
  const footer = plain(`  gpt-5.5 medium ${DOT} C:\\dev\\demo`)
  const READY_SCREEN: ScreenLine[] = [...head, { text: `${P} Ask Codex to do anything`, typed: P }, footer]
  const TRUST_SCREEN: ScreenLine[] = [...head, plain('  Do you trust the contents of this directory?'), plain(`${P} 1. Yes, continue`), plain('  Press enter to continue')]

  function lagging(opts: { onSleep?: (ms: number) => void; onWrite?: (data: string) => void; drawn?: boolean } = {}) {
    let t = 0
    let received = READY_SCREEN
    let drawn = READY_SCREEN
    let staleReads = 0
    const writes: string[] = []
    const logs: string[] = []
    const deps: ComposerSubmitDeps = {
      readScreen: () => { if (drawn !== received) staleReads++; return drawn },
      settle: async () => {
        if (opts.drawn === false) return false
        drawn = received
        return true
      },
      size: () => ({ cols: 80, rows: 24 }),
      write: (data) => { writes.push(data); opts.onWrite?.(data) },
      live: () => true,
      now: () => t,
      sleep: async (ms) => { t += Math.max(0, ms); opts.onSleep?.(ms) },
      log: (msg) => { logs.push(msg) },
    }
    return { deps, writes, logs, receive: (lines: ScreenLine[]) => { received = lines }, get staleReads() { return staleReads } }
  }

  it('[host] a trust prompt that arrived before the second ready read stops it: nothing is typed', async () => {
    let arrived = false
    const s = lagging({ onSleep: () => { if (!arrived) { arrived = true; s.receive(TRUST_SCREEN) } } })
    const r = await submitToCodexComposer('1 how do I add an account?', s.deps, { readyWaitMs: 2_000 })
    expect(r).toEqual({ delivered: false, reason: 'prompt-on-screen' })
    expect(s.writes).toEqual([])
    expect(s.staleReads).toBe(0)
  })

  it('[host] a prompt that arrived as the text was typed is read by the read after the write: no further key', async () => {
    const s = lagging({ onWrite: (data) => { if (data !== '\r') s.receive(TRUST_SCREEN) } })
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 2_000 })
    expect(r).toEqual({ delivered: false, reason: 'prompt-on-screen' })
    expect(s.writes).toEqual([MARKER])
    expect(s.logs).toContain('a prompt came up as the text was typed; no further key sent')
    expect(s.staleReads).toBe(0)
  })

  it('[host] a screen not drawn in time gives no reading: nothing is typed', async () => {
    const s = lagging({ drawn: false })
    const r = await submitToCodexComposer(MARKER, s.deps, { readyWaitMs: 1_000 })
    expect(r).toEqual({ delivered: false, reason: 'busy-timeout' })
    expect(s.writes).toEqual([])
  })
})
