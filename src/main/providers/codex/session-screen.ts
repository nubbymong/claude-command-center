// The submit primitive's driver (WP2 PR 4, P4.1): main's own reading of each
// local Codex session's screen, and the one door through which main submits a
// text into it (./composer-submit.ts holds the rule).
//
// WHY A PANE OF ITS OWN. Main holds a Codex session's screen only while the
// Watchdog is on (default off), and the renderer's screen is the renderer's:
// a marker the queue flushes at a turn boundary, or Ask's question held for
// the first ready composer, is main's to deliver whether or not a renderer is
// looking. So each local Codex session gets a headless xterm pane fed the
// session's own output from its first byte, bounded the way the Watchdog's is
// (no scrollback, a clamped size, the CSI parameter clamp against hostile
// output), and kept at the real pane's size by resizePty. The completion plan
// leaves the choice open (9.4 P4.1); the phase record names this one.
//
// ONE RUN. A pane belongs to the process it was opened for: a respawn opens a
// new one, and every key the primitive sends checks first that its run is
// still the session's, so nothing is typed into a later process.
import { Terminal } from '@xterm/headless'
import { readXtermScreen, type ScreenLine } from '../../../shared/codex-screen'
import type { SubmitTextResult } from '../../../shared/types'
import { clampAnsiChunk, type AnsiClampState } from '../../watchdog/watchdog-manager'
import { submitToCodexComposer, type ComposerSubmitOptions } from './composer-submit'
import { logInfo, logWarn } from '../../debug-logger'

/** No terminal is anywhere near this; a resize past it is ignored. */
const MAX_PANE_COLS = 1000
const MAX_PANE_ROWS = 1000

interface Pane {
  term: Terminal
  clamp: AnsiClampState
  /** A raw write into this pane's own process. */
  write: (data: string) => void
  /** Whether this pane's process is still the session's. */
  current: () => boolean
  /** The submissions in flight for this run, one at a time, in order. */
  chain: Promise<unknown>
}

const panes = new Map<string, Pane>()

const sane = (cols: number, rows: number): boolean =>
  Number.isInteger(cols) && Number.isInteger(rows) && cols >= 2 && rows >= 2 && cols <= MAX_PANE_COLS && rows <= MAX_PANE_ROWS

/** Open the pane for a Codex session's new run (replacing any earlier one).
 *  `write` writes into that run's process as one write; `current` says
 *  whether that process is still the session's. */
export function openCodexScreen(sessionId: string, opts: { cols: number; rows: number; write: (data: string) => void; current: () => boolean }): void {
  closeCodexScreen(sessionId)
  const cols = sane(opts.cols, opts.rows) ? opts.cols : 120
  const rows = sane(opts.cols, opts.rows) ? opts.rows : 40
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true })
  panes.set(sessionId, { term, clamp: { residual: '' }, write: opts.write, current: opts.current, chain: Promise.resolve() })
}

/** The session's output, as its terminal receives it. */
export function feedCodexScreen(sessionId: string, data: string): void {
  const pane = panes.get(sessionId)
  if (!pane) return
  try { pane.term.write(clampAnsiChunk(data, pane.clamp)) } catch { /* a pane never breaks the data path */ }
}

/** Keep the pane at the real pane's size, so wrapping and the composer's
 *  height read as the user sees them. */
export function resizeCodexScreen(sessionId: string, cols: number, rows: number): void {
  const pane = panes.get(sessionId)
  if (!pane || !sane(cols, rows)) return
  try { pane.term.resize(cols, rows) } catch { /* a mid-write resize throw is not fatal */ }
}

/** The session's process is gone: its pane goes with it, and every
 *  submission still waiting on it reports the session gone. */
export function closeCodexScreen(sessionId: string): void {
  const pane = panes.get(sessionId)
  if (!pane) return
  panes.delete(sessionId)
  try { pane.term.dispose() } catch { /* already gone */ }
}

/** Whether main reads this session's screen (a local Codex session's run). */
export function hasCodexScreen(sessionId: string): boolean {
  return panes.has(sessionId)
}

/** The session's live screen, as the renderer's reader reads a terminal. */
export function readCodexSessionScreen(sessionId: string): ScreenLine[] | null {
  const pane = panes.get(sessionId)
  if (!pane) return null
  try { return readXtermScreen(pane.term) } catch { return null }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  const t = setTimeout(resolve, Math.max(0, ms))
  ;(t as { unref?: () => void }).unref?.()
})

/**
 * Submit `text` into the session's Codex composer by the primitive's rule,
 * after anything already in flight for this run (one at a time, in order).
 * Not delivered, `session-gone`, when the session has no pane or its run ends
 * meanwhile. Never rejects.
 */
export function submitCodexText(sessionId: string, text: string, opts: ComposerSubmitOptions): Promise<SubmitTextResult> {
  const pane = panes.get(sessionId)
  if (!pane) return Promise.resolve({ delivered: false, reason: 'session-gone' })
  const live = (): boolean => panes.get(sessionId) === pane && pane.current()
  const run = async (): Promise<SubmitTextResult> => {
    try {
      const result = await submitToCodexComposer(text, {
        readScreen: () => (live() ? readXtermScreen(pane.term) : null),
        size: () => ({ cols: pane.term.cols, rows: pane.term.rows }),
        write: (data) => { if (live()) pane.write(data) },
        live,
        now: () => Date.now(),
        sleep,
        log: (msg) => logInfo(`[codex-submit] ${sessionId}: ${msg}`),
      }, opts)
      if (!result.delivered) logInfo(`[codex-submit] ${sessionId}: not delivered (${result.reason}), ${[...text].length} code points`)
      return result
    } catch (err) {
      logWarn(`[codex-submit] ${sessionId}: the submission failed: ${(err as Error)?.message ?? err}`)
      return { delivered: false, reason: 'session-gone' }
    }
  }
  const next = pane.chain.then(run, run)
  pane.chain = next.catch(() => undefined)
  return next
}

/** Test seam. */
export function _resetCodexScreensForTest(): void {
  for (const id of [...panes.keys()]) closeCodexScreen(id)
}
