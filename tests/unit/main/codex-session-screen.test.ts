// [host] WP2 PR 4, P4.1 (row 51): the submit primitive's driver
// (src/main/providers/codex/session-screen.ts): main's own headless pane of a
// Codex session, fed the session's raw output, kept at the real pane's size,
// one submission at a time per run, and nothing typed into a run that ended.
// A real @xterm/headless pane; a fake Codex that echoes what it is sent.
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../../src/main/config-manager', () => ({ readConfig: vi.fn(() => ({})) }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/hooks/index', () => ({ getGateway: () => null }))

const screen = await import('../../../src/main/providers/codex/session-screen')
const { TAKE_BACK_KEY } = await import('../../../src/main/providers/codex/composer-submit')
// The PTY manager hands the pane the Watchdog's CSI clamp (the package imports
// no watchdog module), so the tests do too.
const { clampAnsiChunk } = await import('../../../src/main/watchdog/watchdog-manager')

const P = '\u203a'
const DOT = '\u00b7'
const EM = '\u2014'
const CLEAR = '\x1b[2J\x1b[H'
const DIM = (s: string): string => `\x1b[2m${s}\x1b[22m`
const FOOTER = `  gpt-5.5 medium ${DOT} C:\\dev\\demo`
const draw = (composer: string): string => CLEAR + ['  Tip: New Build faster with Codex.', '', composer, '', FOOTER].join('\r\n')
const READY = draw(`${P} ${DIM('Ask Codex to do anything')}`)
const MARKER = `Review #3 ${EM} 5 notes ${DOT} canvas_review R3`
const SID = 'scrn1111scrn1111scrn1111'

/** A fake Codex run: it echoes typed text into its composer, submits on
 *  Enter (an empty composer then), clears on Ctrl+U. */
function fakeCodex(sessionId: string, opts: { cols?: number; rows?: number } = {}) {
  const sent: string[] = []
  const submitted: string[] = []
  let current = true
  let composer = ''
  const redraw = (): void => screen.feedCodexScreen(sessionId, composer ? draw(`${P} ${composer}`) : READY)
  screen.openCodexScreen(sessionId, {
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
    current: () => current,
    clamp: clampAnsiChunk,
    write: (data) => {
      sent.push(data)
      if (data === '\r') { if (composer) submitted.push(composer); composer = '' }
      else if (data === TAKE_BACK_KEY) composer = ''
      else composer += data
      setTimeout(redraw, 20)
    },
  })
  redraw()
  return { sent, submitted, end: () => { current = false } }
}

afterEach(() => {
  screen._resetCodexScreensForTest()
})

describe('the pane', () => {
  it('reads the session\'s output as its screen, through the shared reader', async () => {
    fakeCodex(SID)
    await new Promise((r) => setTimeout(r, 30))
    const lines = screen.readCodexSessionScreen(SID)!
    expect(lines.some((l) => l.text.startsWith(`${P} Ask Codex to do anything`))).toBe(true)
    expect(lines.find((l) => l.text.startsWith(P))!.typed.trim()).toBe(P)
  })

  it('a session with no pane: nothing to read, and a submission is the session gone', async () => {
    expect(screen.hasCodexScreen('none00000000none0000')).toBe(false)
    expect(screen.readCodexSessionScreen('none00000000none0000')).toBeNull()
    expect(await screen.submitCodexText('none00000000none0000', MARKER, { readyWaitMs: 1_000 })).toEqual({ delivered: false, reason: 'session-gone' })
  })

  it('keeps the real pane\'s size, and refuses a size no terminal has', () => {
    fakeCodex(SID, { cols: 100, rows: 30 })
    screen.resizeCodexScreen(SID, 60, 20)
    expect(screen.readCodexSessionScreen(SID)).toHaveLength(20)
    screen.resizeCodexScreen(SID, 60_000, 60_000)
    expect(screen.readCodexSessionScreen(SID)).toHaveLength(20)
  })

  it('a CSI with an enormous parameter is clamped before it is parsed (the Watchdog\'s F5 rule)', () => {
    fakeCodex(SID)
    const t0 = Date.now()
    screen.feedCodexScreen(SID, 'x\x1b[2147483647b')
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('[host] every chunk goes through the clamp the caller gave, with the pane\'s own state across chunks', () => {
    const seen: Array<{ data: string; state: { residual: string } }> = []
    screen.openCodexScreen(SID, {
      cols: 80, rows: 24, write: () => {}, current: () => true,
      clamp: (data, state) => { seen.push({ data, state }); return clampAnsiChunk(data, state) },
    })
    screen.feedCodexScreen(SID, 'one\x1b[')
    screen.feedCodexScreen(SID, '2Jtwo')
    expect(seen.map((c) => c.data)).toEqual(['one\x1b[', '2Jtwo'])
    expect(seen[0].state).toBe(seen[1].state)
  })

  it('[host] a pane is never opened without its clamp (never fed unclamped output)', () => {
    expect(() => screen.openCodexScreen(SID, { cols: 80, rows: 24, write: () => {}, current: () => true } as unknown as Parameters<typeof screen.openCodexScreen>[1])).toThrow(/clamp/)
    expect(screen.hasCodexScreen(SID)).toBe(false)
  })

  it('[host] a clamp that throws drops that chunk; it is never written unclamped', async () => {
    let calls = 0
    screen.openCodexScreen(SID, { cols: 80, rows: 24, write: () => {}, current: () => true, clamp: () => { calls++; throw new Error('boom') } })
    screen.feedCodexScreen(SID, 'VISIBLETEXT')
    await new Promise((r) => setTimeout(r, 30))
    expect(calls).toBe(1)
    expect(screen.readCodexSessionScreen(SID)!.some((l) => l.text.includes('VISIBLETEXT'))).toBe(false)
  })
})

describe('submitting through the pane', () => {
  it('delivers a marker: typed, confirmed on screen, then Enter', async () => {
    const codex = fakeCodex(SID)
    await new Promise((r) => setTimeout(r, 30))
    const r = await screen.submitCodexText(SID, MARKER, { readyWaitMs: 5_000 })
    expect(r).toEqual({ delivered: true })
    expect(codex.sent).toEqual([MARKER, '\r'])
    expect(codex.submitted).toEqual([MARKER])
  })

  it('one submission at a time per run, in order', async () => {
    const codex = fakeCodex(SID)
    await new Promise((r) => setTimeout(r, 30))
    const a = screen.submitCodexText(SID, 'first marker', { readyWaitMs: 5_000 })
    const b = screen.submitCodexText(SID, 'second marker', { readyWaitMs: 5_000 })
    expect(await a).toEqual({ delivered: true })
    expect(await b).toEqual({ delivered: true })
    expect(codex.submitted).toEqual(['first marker', 'second marker'])
    expect(codex.sent).toEqual(['first marker', '\r', 'second marker', '\r'])
  })

  it('a run that ends meanwhile gets nothing more, and reports the session gone', async () => {
    const codex = fakeCodex(SID)
    codex.end()
    const r = await screen.submitCodexText(SID, MARKER, { readyWaitMs: 5_000 })
    expect(r).toEqual({ delivered: false, reason: 'session-gone' })
    expect(codex.sent).toEqual([])
  })

  it('a respawn opens a new pane: the old run\'s waiting submission types nothing into the new one', async () => {
    const old = fakeCodex(SID)
    // The old run is busy: the submission waits for its composer.
    screen.feedCodexScreen(SID, CLEAR + ['\u2022 Working (1s \u2022 esc to interrupt)', `${P} ${DIM('Ask Codex to do anything')}`, '', FOOTER].join('\r\n'))
    const waiting = screen.submitCodexText(SID, MARKER, { readyWaitMs: 5_000 })
    await new Promise((r) => setTimeout(r, 100))
    const fresh = fakeCodex(SID)
    expect(await waiting).toEqual({ delivered: false, reason: 'session-gone' })
    expect(old.sent).toEqual([])
    expect(fresh.sent).toEqual([])
  })
})

describe('the pane is drawn before it is read (ADR-009 round 1)', () => {
  const TRUST = CLEAR + ['  Tip: New Build faster with Codex.', '', '  Do you trust the contents of this directory?', `${P} 1. Yes, continue`, '  Press enter to continue'].join('\r\n')
  const shows = (needle: string): boolean => (screen.readCodexSessionScreen(SID) ?? []).some((l) => l.text.includes(needle))

  it('[host] a chunk just fed is not on the screen the same moment, and is once the pane is settled', async () => {
    fakeCodex(SID)
    await new Promise((r) => setTimeout(r, 30))
    screen.feedCodexScreen(SID, TRUST)
    expect(shows('Do you trust')).toBe(false)
    expect(await screen.settleCodexScreen(SID)).toBe(true)
    expect(shows('Do you trust')).toBe(true)
  })

  it('[host] a session with no pane is never settled', async () => {
    expect(await screen.settleCodexScreen('none00000000none0000')).toBe(false)
  })

  it('[host] a prompt that arrived as the text was typed is read right after the write: no further key', async () => {
    const { logInfo } = await import('../../../src/main/debug-logger')
    vi.mocked(logInfo).mockClear()
    const sent: string[] = []
    screen.openCodexScreen(SID, {
      cols: 100, rows: 30, current: () => true, clamp: clampAnsiChunk,
      // The prompt's bytes reach main in the same moment the text is written.
      write: (data) => { sent.push(data); screen.feedCodexScreen(SID, TRUST) },
    })
    screen.feedCodexScreen(SID, READY)
    await new Promise((r) => setTimeout(r, 30))
    const r = await screen.submitCodexText(SID, MARKER, { readyWaitMs: 5_000 })
    expect(r).toEqual({ delivered: false, reason: 'prompt-on-screen' })
    expect(sent).toEqual([MARKER])
    expect(vi.mocked(logInfo).mock.calls.map((c) => String(c[0]))).toContain(`[codex-submit] ${SID}: a prompt came up as the text was typed; no further key sent`)
  })
})
