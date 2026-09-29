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
    write: (_id, d) => { writes.push(d); if (d !== '\r' && state.screen) state.screen = typedInto(state.screen, d) },
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ fn, at: now + ms, id }); return id },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id) },
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
})

describe('typeWhenCodexComposerReady (Plan mode at launch, L2)', () => {
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
    expect(String(onGiveUp.mock.calls[0][0])).toMatch(/\/plan/)
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

  it('cancel() after it typed drops the pending Enter too', () => {
    const h = harness(S.READY)
    const w = typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp: vi.fn() }, h.deps)
    h.advance(0)
    expect(h.writes).toEqual(['/plan'])
    w.cancel()
    h.advance(CODEX_SUBMIT_DELAY_MS * 2)
    expect(h.writes).toEqual(['/plan'])
  })

  it('waits while the user is typing, then types once the composer is empty again', () => {
    const h = harness(S.USER_TYPING)
    typeWhenCodexComposerReady('s1', '/plan', { timeoutMs: 60_000, onGiveUp: vi.fn() }, h.deps)
    h.advance(CODEX_READY_POLL_MS * 5)
    expect(h.writes).toEqual([])
    h.state.screen = S.READY
    h.advance(CODEX_READY_POLL_MS)
    expect(h.writes).toEqual(['/plan'])
  })
})
