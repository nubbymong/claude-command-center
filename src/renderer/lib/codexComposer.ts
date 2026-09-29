/**
 * Typing a Codex command into Codex's composer (P3.8 rounds 1 and 2): the
 * strip's Compact (/compact), the command bar's model pill (/model: Codex's
 * own model-and-effort picker), and Plan mode at launch (/plan).
 *
 * A command is typed only into Codex's READY, EMPTY composer, and its Enter is
 * pressed only when the screen then shows exactly that command typed, in the
 * same run, with nothing in the way. Evidence (the P3.8 VM probe of the real
 * 0.153.4 and 0.155.1 TUIs, and the strings of their binaries):
 *  - ready: the screen's last line is the footer "<model> <effort> . <folder>"
 *    (the effort one of Codex's levels, or "default" when the model's own
 *    applies), and the line above it (blank lines aside) is the composer. The
 *    placeholder is drawn before the folder-trust prompt, so it is not a
 *    marker; the trust prompt, Codex's own pickers and its hint lines draw no
 *    such footer;
 *  - the composer's placeholder is one of two dim texts; anything else in it,
 *    dim or not (a paste marker), is content;
 *  - the composer takes a fast burst of typed characters ending in Enter as a
 *    paste (its `disable_paste_burst` handling): the Enter would be a newline.
 *    Typed, then Enter 300 ms later, submits; one write of the command and
 *    Enter together does not;
 *  - once a command is typed its popup replaces the footer, so the Enter's
 *    check reads the composer row and the rows under it instead;
 *  - `/model <slug>` and `/model <slug> <effort>` are sent as a message, and
 *    there is no `/effort`: only a bare `/model` opens the picker.
 */
import { useSessionStore } from '../stores/sessionStore'
import { useRegistryStore } from '../stores/registryStore'
import { buildModelPickerRows } from '../../shared/model-registry'
import { currentSpawnToken } from '../ptyTracker'
import { readSessionScreen, type ScreenLine } from '../components/terminal/screenRegistry'
import { writeSessionInput } from '../components/terminal/tmuxWheelScroll'

export type { ScreenLine }

/** How long after typing a command its Enter follows (the burst is over). */
export const CODEX_SUBMIT_DELAY_MS = 300
/** How often a wait for the ready composer looks at the screen. */
export const CODEX_READY_POLL_MS = 250
/** How long a Plan mode launch waits for the ready composer (the user may be
 *  answering the folder-trust prompt, or choosing in the resume picker). */
export const CODEX_PLAN_MODE_WAIT_MS = 120_000

// P3.10: the pure screen reading lives in src/shared/codex-screen.ts, shared
// with the Watchdog's Codex send gate in main; re-exported here unchanged.
import {
  readCodexScreen, codexComposerState, codexComposerText, codexCommandTyped, codexPlanModeOnScreen,
} from '../../shared/codex-screen'
export { readCodexScreen, codexComposerState, codexComposerText, codexCommandTyped, codexPlanModeOnScreen }
export type { CodexComposerState, CodexScreenKind } from '../../shared/codex-screen'

/** The session's Plan mode reading, from its live screen and its models. */
export function codexPlanModeShown(sessionId: string, deps: CodexComposerDeps = defaultCodexComposerDeps): boolean | null {
  return codexPlanModeOnScreen(deps.readScreen(sessionId), deps.footerModels?.(sessionId) ?? null)
}

export const NOT_AT_PROMPT = 'Codex is not at its prompt, so nothing was sent.'
export const BUSY_NOW = 'Codex is busy with a turn, so nothing was sent.'
export const TEXT_IN_PROMPT = 'Something is already typed at the Codex prompt, so nothing was added.'
export const UNREADABLE_PROMPT = "Codex's prompt could not be read (a narrow window can wrap its status line), so nothing was sent."
export const SENDING_ALREADY = 'A command is already on its way to Codex, so nothing more was sent.'
export const STARTING_NOW = 'Codex is still starting (its MCP servers), so nothing was sent.'

/** The run a command is typed into: its session record's start and its PTY's
 *  spawn token (a Restart bumps the first, a new PTY the second). */
export interface CodexRun { createdAt: number; spawnToken: number }

export interface CodexComposerDeps {
  readScreen: (sessionId: string) => ScreenLine[] | null
  currentRun: (sessionId: string) => CodexRun | null
  write: (sessionId: string, data: string) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
  /** The models the session's footer may name (round 2, FT); none given: any
   *  model id, still followed by one of Codex's levels. */
  footerModels?: (sessionId: string) => readonly string[] | null
  /** Sessions with a command typed and its Enter pending (round 2, DP); the
   *  app's one set when not given. */
  pending?: Set<string>
  /** Runs past their start-up (round 4, E3): a turn was seen, or a command
   *  sent; the app's one record when not given. */
  startupDone?: StartupDoneRuns
}

/** At most this many sessions' runs are kept past their start-up. */
export const STARTUP_DONE_MAX = 256

/**
 * The runs past their start-up (round 4, E3; bounded in round 5): one per
 * session, its latest run (an earlier run of the session has ended once a
 * later one is recorded); a session seen with no live run is let go; at most
 * STARTUP_DONE_MAX sessions are held, the oldest let go first.
 */
export class StartupDoneRuns {
  private bySession = new Map<string, string>()
  get size(): number { return this.bySession.size }
  has(sessionId: string, key: string): boolean { return this.bySession.get(sessionId) === key }
  add(sessionId: string, key: string): void {
    this.bySession.delete(sessionId)
    this.bySession.set(sessionId, key)
    while (this.bySession.size > STARTUP_DONE_MAX) {
      const oldest = this.bySession.keys().next().value
      if (oldest === undefined) break
      this.bySession.delete(oldest)
    }
  }
  forget(sessionId: string): void { this.bySession.delete(sessionId) }
}

/** A run's key: its session, its start and its PTY. */
const runKey = (sessionId: string, run: CodexRun): string => `${sessionId}|${run.createdAt}|${run.spawnToken}`

/** The session's current run, read from the store (not a component's copy):
 *  null when it has no live PTY. */
function liveRun(sessionId: string): CodexRun | null {
  const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
  if (!s || s.ptyExited || s.neverStarted) return null
  const spawnToken = currentSpawnToken(sessionId)
  if (spawnToken === undefined) return null
  return { createdAt: s.createdAt, spawnToken }
}

/** The models the session's footer may name: the one Codex reported, the
 *  one it was started on, and the registry's Codex list (a Default launch
 *  shows Codex's own choice, a /model pick a listed one). */
function sessionFooterModels(sessionId: string): readonly string[] | null {
  const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
  const own = [s?.modelName, s?.codexOptions?.model].filter((m): m is string => typeof m === 'string' && m.length > 0)
  let listed: string[] = []
  try { listed = buildModelPickerRows(useRegistryStore.getState().registry, 'codex').map((r) => r.value) } catch { /* no registry: the session's own */ }
  const all = [...new Set([...own, ...listed])]
  return all.length > 0 ? all : null
}

/** The sessions with a command's Enter pending, app-wide (the strip, the pill
 *  and the Plan mode launch share it). */
const pendingSessions = new Set<string>()
/** The runs past their start-up, app-wide. */
const startupDoneRuns = new StartupDoneRuns()

export const defaultCodexComposerDeps: CodexComposerDeps = {
  readScreen: readSessionScreen,
  currentRun: liveRun,
  write: writeSessionInput,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  footerModels: sessionFooterModels,
  pending: pendingSessions,
  startupDone: startupDoneRuns,
}

const sameRun = (a: CodexRun | null, b: CodexRun | null): boolean =>
  !!a && !!b && a.createdAt === b.createdAt && a.spawnToken === b.spawnToken

export interface CodexTyping {
  /** Whether the command was typed. */
  typed: boolean
  /** Why it was not, in words for the user. */
  reason?: string
  /** Drop a pending Enter (or a pending wait). Safe to call twice. */
  cancel: () => void
}

/** Why a typed command's Enter was not pressed (round 3, V1): the typing was
 *  cancelled; the run changed; the composer holds something other than the
 *  command ('text'); a prompt is up ('blocked'); a turn is running; Codex is
 *  still starting; or the screen could not be read. */
export type CodexWithheld = 'cancelled' | 'run-changed' | 'text' | 'blocked' | 'busy' | 'starting' | 'unreadable'
export interface CodexSettled {
  /** Why the Enter was withheld; absent when it was sent. */
  reason?: CodexWithheld
  /** Whether what the app typed was erased again (only its own characters). */
  erased: boolean
}

/** One Backspace (DEL), as a terminal sends the key. */
const BACKSPACE = String.fromCharCode(0x7f)

/**
 * Type `command` into the session's composer, then press Enter on its own
 * CODEX_SUBMIT_DELAY_MS later. Types nothing (and says why) unless the
 * composer is ready and empty, the session has a live run, and no other
 * command's Enter is pending for it. The Enter is pressed only if, by then,
 * the run is the same one (same session start, same PTY) and the screen shows
 * exactly `command` typed with nothing in the way. When it is withheld, what
 * the app typed is erased (round 3, V1) so nothing is left behind, but only
 * in the same run, only while the composer holds exactly the command (text
 * the user typed is never touched) and never while a prompt is up (its keys
 * are the prompt's). The erase waits one poll and reads again (round 4,
 * E1): the user's keys echoed late are never erased with it; when the
 * composer then holds anything but exactly the command, nothing is erased.
 * `onSettled` hears whether the Enter was sent, and why not. A write that
 * throws still settles the typing (round 3, Q1).
 */
export function typeIntoCodexComposer(
  sessionId: string,
  command: string,
  deps: CodexComposerDeps = defaultCodexComposerDeps,
  opts: { onSettled?: (sent: boolean, how: CodexSettled) => void } = {},
): CodexTyping {
  const none = (reason: string): CodexTyping => ({ typed: false, reason, cancel: () => {} })
  const pending = deps.pending ?? pendingSessions
  const startupDone = deps.startupDone ?? startupDoneRuns
  if (pending.has(sessionId)) return none(SENDING_ALREADY)
  const run = deps.currentRun(sessionId)
  if (!run) {
    // The session's run has ended: its start-up record goes with it.
    startupDone.forget(sessionId)
    return none(NOT_AT_PROMPT)
  }
  const key = runKey(sessionId, run)
  const read = readCodexScreen(deps.readScreen(sessionId), deps.footerModels?.(sessionId) ?? null, { startup: !startupDone.has(sessionId, key) })
  if (read.screen === 'busy') startupDone.add(sessionId, key)
  if (read.screen === 'starting') return none(STARTING_NOW)
  if (read.screen === 'busy') return none(BUSY_NOW)
  if (read.screen === 'unrecognised') return none(UNREADABLE_PROMPT)
  if (read.screen !== 'ready') return none(NOT_AT_PROMPT)
  if (read.text !== '') return none(TEXT_IN_PROMPT)
  pending.add(sessionId)
  deps.write(sessionId, command)
  let settled = false
  const settle = (sent: boolean, how: CodexSettled): void => {
    if (settled) return
    settled = true
    pending.delete(sessionId)
    opts.onSettled?.(sent, how)
  }
  /** Round 4 (E1): the erase, after reading the screen again one poll later:
   *  only when the composer still holds exactly the command, in the same
   *  run, with no prompt up. */
  const eraseAfterSecondRead = (reason: CodexWithheld, models: readonly string[] | null): void => {
    handle = deps.setTimeout(() => {
      handle = null
      let how: CodexSettled = { reason: 'run-changed', erased: false }
      try {
        if (!sameRun(run, deps.currentRun(sessionId))) return
        const again = deps.readScreen(sessionId)
        const now = readCodexScreen(again, models, { startup: !startupDone.has(sessionId, key) }).screen
        if (now !== 'blocked' && codexComposerText(again) === command) {
          deps.write(sessionId, BACKSPACE.repeat(command.length))
          how = { reason, erased: true }
        } else {
          how = { reason: now === 'blocked' ? 'blocked' : 'text', erased: false }
        }
      } finally {
        settle(false, how)
      }
    }, CODEX_READY_POLL_MS)
  }
  let handle: unknown = deps.setTimeout(() => {
    handle = null
    let sent = false
    let how: CodexSettled = { reason: 'run-changed', erased: false }
    let erasing = false
    try {
      if (!sameRun(run, deps.currentRun(sessionId))) return
      const models = deps.footerModels?.(sessionId) ?? null
      const screen = deps.readScreen(sessionId)
      if (codexCommandTyped(screen, command, models)) {
        deps.write(sessionId, '\r')
        startupDone.add(sessionId, key)
        sent = true
        how = { erased: false }
        return
      }
      const now = readCodexScreen(screen, models, { startup: !startupDone.has(sessionId, key) }).screen
      if (now === 'busy') startupDone.add(sessionId, key)
      const own = codexComposerText(screen) === command
      const reason: CodexWithheld = now === 'blocked' ? 'blocked'
        : !own ? 'text'
          : now === 'starting' ? 'starting'
            : now === 'busy' ? 'busy'
              : 'unreadable'
      how = { reason, erased: false }
      if (own && now !== 'blocked') {
        erasing = true
        eraseAfterSecondRead(reason, models)
      }
    } finally {
      if (!erasing) settle(sent, how)
    }
  }, CODEX_SUBMIT_DELAY_MS)
  return {
    typed: true,
    cancel: () => {
      if (handle !== null) deps.clearTimeout(handle)
      handle = null
      settle(false, { reason: 'cancelled', erased: false })
    },
  }
}

/** Why a Plan mode launch's /plan was not sent (rounds 2 and 3): the prompt
 *  never came in time; something was typed, or a turn ran, first; Codex put
 *  up a prompt; its prompt could not be read; it kept starting (its MCP
 *  servers) through every try; or it could not be sent at all. */
export type CodexWaitEnd = 'timeout' | 'interrupted' | 'blocked' | 'unreadable' | 'starting' | 'not-sent'

/** How often a Plan mode launch types /plan again after Codex's start-up row
 *  came up under it (round 3, V1); each try is erased when it is withheld. */
export const CODEX_PLAN_MODE_TRIES = 4

/** The note a Plan mode launch shows when /plan was not sent (rounds 2 and
 *  3): the real reason, that the session started read-only, and how to go
 *  on. */
export function planModeNote(why: CodexWaitEnd): string {
  const cause = why === 'timeout' ? 'Codex did not reach its prompt in time'
    : why === 'interrupted' ? 'something was typed at the prompt, or a turn started, before /plan could be sent'
      : why === 'blocked' ? 'Codex asked a question before /plan could be sent'
        : why === 'unreadable' ? "Codex's prompt could not be read (a narrow window can wrap its status line)"
          : why === 'starting' ? 'Codex was still starting (its MCP servers) each time /plan was tried'
            : '/plan could not be sent'
  return `Plan mode is not on: ${cause}. The session started read-only: type /plan to plan first, or /permissions to change what Codex may do.`
}

/**
 * Plan mode at launch (rounds 2 and 3; PM1, V1): type `command` into the
 * run's FIRST ready screen only. Waits while Codex loads, asks to trust the
 * folder, offers a picker or is still starting (its MCP servers); types when
 * the composer is first ready and empty. When Codex's start-up row comes up
 * after the command was typed, its Enter is withheld and what was typed is
 * erased, and the wait goes on (at most CODEX_PLAN_MODE_TRIES tries). Gives
 * up (`onGiveUp` told the real reason; nothing left typed) when that first
 * ready screen already holds text, a turn is seen running, a prompt or the
 * user's text stops the Enter, or `timeoutMs` passes. Stops silently when the
 * run it started with ends or is replaced, and on cancel(). Never types into
 * the trust prompt or a picker: they are not the ready composer.
 */
export function typeWhenCodexComposerReady(
  sessionId: string,
  command: string,
  opts: { timeoutMs: number; onGiveUp: (why: CodexWaitEnd) => void },
  deps: CodexComposerDeps = defaultCodexComposerDeps,
): { cancel: () => void } {
  const run = deps.currentRun(sessionId)
  let waited = 0
  let tries = 0
  let handle: unknown = null
  let typing: CodexTyping | null = null
  let cancelled = false
  let done = !run
  const giveUp = (why: CodexWaitEnd): void => { if (!cancelled) opts.onGiveUp(why) }
  const withheld = (sent: boolean, how: CodexSettled): void => {
    if (sent || cancelled || how.reason === 'cancelled' || how.reason === 'run-changed') return
    if (how.reason === 'starting' && how.erased && tries < CODEX_PLAN_MODE_TRIES) {
      // Codex's start-up row came up under what was typed; it is erased:
      // wait for the prompt again, within the same time.
      done = false
      typing = null
      handle = deps.setTimeout(poll, CODEX_READY_POLL_MS)
      return
    }
    giveUp(how.reason === 'text' || how.reason === 'busy' ? 'interrupted'
      : how.reason === 'blocked' ? 'blocked'
        : how.reason === 'starting' ? 'starting'
          : 'unreadable')
  }
  const poll = (): void => {
    handle = null
    if (done) return
    const startupDone = deps.startupDone ?? startupDoneRuns
    const now = deps.currentRun(sessionId)
    if (!sameRun(run, now)) {
      if (!now) startupDone.forget(sessionId) // the run ended: its record goes with it
      done = true
      return
    }
    const key = runKey(sessionId, run!)
    const read = readCodexScreen(deps.readScreen(sessionId), deps.footerModels?.(sessionId) ?? null, { startup: !startupDone.has(sessionId, key) })
    if (read.screen === 'busy') startupDone.add(sessionId, key)
    if (read.screen === 'busy' || (read.screen === 'ready' && read.text !== '')) {
      done = true
      giveUp('interrupted')
      return
    }
    if (read.screen === 'ready') {
      done = true
      tries++
      typing = typeIntoCodexComposer(sessionId, command, deps, { onSettled: withheld })
      if (!typing.typed) giveUp('not-sent')
      return
    }
    waited += CODEX_READY_POLL_MS
    if (waited >= opts.timeoutMs) {
      done = true
      giveUp('timeout')
      return
    }
    handle = deps.setTimeout(poll, CODEX_READY_POLL_MS)
  }
  if (!done) handle = deps.setTimeout(poll, 0)
  return {
    cancel: () => {
      cancelled = true
      done = true
      if (handle !== null) deps.clearTimeout(handle)
      handle = null
      typing?.cancel()
    },
  }
}
