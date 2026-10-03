// The submit primitive (WP2 PR 4, P4.1; completion plan 9.4 P4.1 and the PR 4
// VM probes PB3 and PB9): the one way main types a text into a Codex session's
// composer and submits it. The canvas marker queue uses it for a Codex
// session, and Ask Conductor's carrier (P4.3) reuses it.
//
// PURE: the rule only. The session's screen, its writer, its liveness and the
// clock are injected (the driver is ./session-screen.ts, which keeps a
// bounded headless pane fed by the session's own output). Built from the two
// copies of this rule that already exist, which stay as they are: the
// renderer's typeIntoCodexComposer (src/renderer/lib/codexComposer.ts) and the
// Watchdog's submitCodex (src/main/watchdog/watchdog-manager.ts).
//
// The rule, from the probes of the real 0.153.4 and 0.155.1 TUIs:
//  - one write of a text and Enter never submits; the text in one write, then
//    Enter as its own write once the text is drawn, submits byte-exact (PB3);
//  - up to 1,000 code points the text is drawn in the composer (wrapped in a
//    narrow pane); from 1,001 it is folded into "[Pasted Content N chars]",
//    N in code points (PB9);
//  - the composer is at most the pane's rows minus 4 high; a taller text
//    scrolls inside it and cannot be confirmed on screen (PB9);
//  - a draw can take up to about 2.9 s at 8,000 code points, and the composer
//    looks empty meanwhile; an Enter sent before the draw is swallowed (PB9);
//  - Ctrl+U clears the composer in every state; Ctrl+C QUITS Codex when the
//    composer is empty as the key is handled, so it is never sent (PB9);
//  - characters outside the Basic Multilingual Plane are dropped by the
//    composer itself (PB3), so a text holding one cannot be confirmed.
import {
  readCodexScreen, codexTextTyped, codexPastedContentShown, codexComposerRows, codexComposerText,
  type ScreenLine,
} from '../../../shared/codex-screen'
import type { SubmitNotDeliveredReason, SubmitTextResult } from '../../../shared/types'

/** How often a wait for the ready composer reads the screen. */
export const SUBMIT_READY_POLL_MS = 250
/** Ready means ready on two reads this far apart (the composer is drawn
 *  before the folder-trust prompt: PB1). */
export const SUBMIT_READY_SECOND_READ_MS = 300
/** How often a write's confirmation reads the screen. */
export const SUBMIT_CONFIRM_POLL_MS = 100
/** The longest text the exact mode takes; from one more, Codex folds it. */
export const SUBMIT_EXACT_MAX_CODE_POINTS = 1000
/** How long the exact mode polls for the whole text to be drawn (PB9: a
 *  1,000-code-point text drew in 0.48 to 0.62 s; a 26-character one was once
 *  not drawn at 0.4 s). */
export const SUBMIT_EXACT_CONFIRM_MS = 5_000
/** How long the folded mode waits for the placeholder: at least 5 s (PB9
 *  drew it in under 2.9 s at 8,000 code points). */
export const SUBMIT_FOLDED_CONFIRM_MS = 6_000
/** How long a take-back's clear is waited for, once its key is sent. */
export const SUBMIT_CLEAR_VERIFY_MS = 2_000
/** The composer is at most the pane's rows minus this many rows high. */
export const COMPOSER_ROW_MARGIN = 4

const ENTER = String.fromCharCode(13)
/** Ctrl+U: the only take-back key (PB9). */
export const TAKE_BACK_KEY = String.fromCharCode(0x15)

/** How long Codex may still be taking a write in, by its length in code
 *  points (PB9: 0.25 s at 200, 0.62 s at 1,000, 0.88 s at 2,000, 1.48 s at
 *  4,000, 2.85 s at 8,000), with room to spare. A clear is verified, and a
 *  take-back key sent, only after it: until then the composer looks empty
 *  while a write is still arriving. */
export function submitIngestionWindowMs(codePoints: number): number {
  const n = Number.isFinite(codePoints) && codePoints > 0 ? codePoints : 0
  return 1_000 + Math.ceil(n * 0.45)
}

/** Why a text is refused before anything is typed: empty, a control
 *  character (C0, DEL or C1), a lone surrogate, or a character outside the
 *  Basic Multilingual Plane (Codex's composer drops those, so the text could
 *  never be confirmed). Defence in depth beside each caller's own check. */
export function submitTextRefusal(text: unknown): 'refused-text' | null {
  if (typeof text !== 'string' || text.length === 0 || text.trim() === '') return 'refused-text'
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return 'refused-text'
    if (c >= 0xd800 && c <= 0xdfff) return 'refused-text'
  }
  return null
}

/** The display width of one BMP code point: 2 for the wide East Asian ranges,
 *  else 1 (an upper bound is what the fit check needs). */
function cellWidth(code: number): number {
  if (
    (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
  ) return 2
  return 1
}

/** An upper bound on the composer rows a visible text takes in a pane `cols`
 *  wide. Codex word-wraps after its two-cell prompt; a wrap can waste up to a
 *  word's width per row, so this counts the text's cells against a narrower
 *  row and adds a row of slack: a text it says fits does fit. */
export function estimateComposerRows(text: string, cols: number): number {
  let cells = 0
  for (const ch of text) cells += cellWidth(ch.codePointAt(0) ?? 0)
  const usable = Math.max(1, Math.floor(cols) - 2 - 8)
  return Math.ceil(cells / usable) + 1
}

export interface ComposerSubmitDeps {
  /** The session's live screen now; null when it cannot be read. */
  readScreen: () => ScreenLine[] | null
  /** The pane's size now. */
  size: () => { cols: number; rows: number }
  /** A raw write into this run's terminal, as one write. */
  write: (data: string) => void
  /** Still the run the submission started in (the same process, not ended). */
  live: () => boolean
  /** The models the footer may name; none: any model with a Codex level. */
  models?: readonly string[] | null
  now: () => number
  sleep: (ms: number) => Promise<void>
  log?: (msg: string) => void
}

export interface ComposerSubmitOptions {
  /** How long to wait for Codex's ready, empty composer (a turn running, a
   *  prompt up): the caller's own bound. */
  readyWaitMs: number
}

type Ready = 'ready' | 'blocked' | 'waiting'

function readyState(lines: ScreenLine[] | null, models: readonly string[] | null): Ready {
  const read = readCodexScreen(lines, models)
  if (read.screen === 'blocked') return 'blocked'
  return read.screen === 'ready' && read.text === '' ? 'ready' : 'waiting'
}

const notDelivered = (reason: SubmitNotDeliveredReason): SubmitTextResult => ({ delivered: false, reason })

/**
 * Type `text` into the session's composer and submit it, confirmed on screen.
 *
 * 1. Refuses an empty text, a control character or a character outside the
 *    BMP, before anything is typed.
 * 2. Waits, within `readyWaitMs`, for Codex's ready, EMPTY composer, ready on
 *    two reads SUBMIT_READY_SECOND_READ_MS apart; never while the trust
 *    prompt, the sandbox menu or the MCP approval form is on screen, and
 *    never while a composer is drawn with a prompt (the shared reading calls
 *    every such screen blocked). On time out: not delivered, `prompt-on-screen`
 *    when a prompt was up, else `busy-timeout`.
 * 3. A text up to 1,000 code points is typed only when it fits the composer
 *    (the pane's rows minus 4, by an upper-bound estimate); one that does not
 *    is refused untyped as `too-tall`.
 * 4. Writes the text in ONE write, then re-reads the screen once before any
 *    further key: a prompt there (the race window between the second ready
 *    read and the write) stops it with no further key.
 * 5. Enter, as its own write, only once the screen confirms the text: the
 *    exact mode (up to 1,000 code points) when codexTextTyped reads the whole
 *    text at the composer, polled within SUBMIT_EXACT_CONFIRM_MS; the folded
 *    mode (from 1,001) when the placeholder names exactly the text's code
 *    points, within SUBMIT_FOLDED_CONFIRM_MS. A prompt appearing meanwhile
 *    stops it with no further key.
 * 6. Neither mode confirmed: it takes the text back with Ctrl+U, only after
 *    the ingestion window, only in the same run and never while a prompt is
 *    up, waits for the composer to read ready and empty, and reports not
 *    delivered (`too-tall` when the composer had grown to its full height,
 *    else `not-drawn`). Whether Ctrl+U clears Codex's rare held-text state
 *    (PB9, not reproduced) is unknown; the phase record carries it.
 * Never sends Ctrl+C. A run that ends meanwhile: `session-gone`, nothing more.
 */
export async function submitToCodexComposer(text: string, deps: ComposerSubmitDeps, opts: ComposerSubmitOptions): Promise<SubmitTextResult> {
  const models = deps.models ?? null
  const log = (msg: string): void => { try { deps.log?.(msg) } catch { /* a log line never breaks the rule */ } }
  if (submitTextRefusal(text)) return notDelivered('refused-text')
  const codePoints = [...text].length
  const folded = codePoints > SUBMIT_EXACT_MAX_CODE_POINTS
  const read = (): ScreenLine[] | null => { try { return deps.readScreen() } catch { return null } }

  // 2. The ready, empty composer, on two reads.
  const waitUntil = deps.now() + Math.max(0, opts.readyWaitMs)
  let last: Ready = 'waiting'
  for (;;) {
    if (!deps.live()) return notDelivered('session-gone')
    last = readyState(read(), models)
    if (last === 'ready') {
      await deps.sleep(SUBMIT_READY_SECOND_READ_MS)
      if (!deps.live()) return notDelivered('session-gone')
      last = readyState(read(), models)
      if (last === 'ready') break
    }
    if (deps.now() >= waitUntil) return notDelivered(last === 'blocked' ? 'prompt-on-screen' : 'busy-timeout')
    await deps.sleep(SUBMIT_READY_POLL_MS)
  }

  // 3. A visible text must fit the composer to be confirmed at all.
  if (!folded) {
    const { cols, rows } = deps.size()
    if (estimateComposerRows(text, cols) > rows - COMPOSER_ROW_MARGIN) return notDelivered('too-tall')
  }

  // 4. One write, then one read before any further key.
  deps.write(text)
  const wroteAt = deps.now()
  if (!deps.live()) return notDelivered('session-gone')
  if (readyState(read(), models) === 'blocked') {
    log('a prompt came up as the text was typed; no further key sent')
    return notDelivered('prompt-on-screen')
  }

  // 5. Confirm, then Enter.
  const confirmUntil = wroteAt + (folded ? SUBMIT_FOLDED_CONFIRM_MS : SUBMIT_EXACT_CONFIRM_MS)
  let tallest = 0
  for (;;) {
    await deps.sleep(SUBMIT_CONFIRM_POLL_MS)
    if (!deps.live()) return notDelivered('session-gone')
    const screen = read()
    if (readyState(screen, models) === 'blocked') {
      log('a prompt came up before the text was confirmed; no further key sent')
      return notDelivered('prompt-on-screen')
    }
    tallest = Math.max(tallest, codexComposerRows(screen, models) ?? 0)
    const confirmed = folded ? codexPastedContentShown(screen, codePoints, models) : codexTextTyped(screen, text, models)
    if (confirmed) {
      deps.write(ENTER)
      return { delivered: true }
    }
    if (deps.now() >= confirmUntil) break
  }

  // 6. Take it back: Ctrl+U, after the ingestion window, in the same run, with
  // no prompt up; then the clear is read on screen.
  const { rows } = deps.size()
  const reason: SubmitNotDeliveredReason = !folded && tallest >= rows - COMPOSER_ROW_MARGIN ? 'too-tall' : 'not-drawn'
  const ingested = wroteAt + submitIngestionWindowMs(codePoints)
  if (deps.now() < ingested) await deps.sleep(ingested - deps.now())
  if (!deps.live()) return notDelivered('session-gone')
  if (readyState(read(), models) === 'blocked') {
    log('the text was not confirmed and a prompt is up; nothing taken back')
    return notDelivered('prompt-on-screen')
  }
  deps.write(TAKE_BACK_KEY)
  const clearUntil = deps.now() + SUBMIT_CLEAR_VERIFY_MS
  for (;;) {
    await deps.sleep(SUBMIT_CONFIRM_POLL_MS)
    if (!deps.live()) return notDelivered('session-gone')
    const screen = read()
    if (readyState(screen, models) === 'ready' && codexComposerText(screen) === '') break
    if (deps.now() >= clearUntil) {
      log('the text was taken back (Ctrl+U) but the cleared composer was not seen in time')
      break
    }
  }
  return notDelivered(reason)
}
