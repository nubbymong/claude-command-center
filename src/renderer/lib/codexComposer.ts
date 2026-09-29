/**
 * Typing a Codex command into Codex's composer (P3.8 round 1: C1, C2, C3, L1,
 * L2): the strip's Compact (/compact), the command bar's model pill (/model:
 * Codex's own model-and-effort picker), and Plan mode at launch (/plan).
 *
 * A command is typed only into Codex's READY, EMPTY composer, and its Enter is
 * pressed only when the composer then holds exactly that command, in the same
 * run. Evidence (the P3.8 VM probe of the real 0.153.4 and 0.155.1 TUIs):
 *  - ready: the screen's last line is the footer "<model> <effort> . <folder>"
 *    and the line above it (blank lines aside) is the composer. The
 *    placeholder is drawn before the folder-trust prompt, so it is not a
 *    marker; the trust prompt and Codex's own pickers draw no footer;
 *  - the composer takes a fast burst of typed characters ending in Enter as a
 *    paste (its `disable_paste_burst` handling): the Enter would be a newline.
 *    Typed, then Enter 300 ms later, submits; one write of `/compact\r` does
 *    not;
 *  - `/model <slug>` and `/model <slug> <effort>` are sent as a message, and
 *    there is no `/effort`: only a bare `/model` opens the picker.
 */
import { useSessionStore } from '../stores/sessionStore'
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

export type CodexComposerState = 'ready' | 'busy' | 'not-ready'

/** The composer row: Codex's prompt glyph (`>`-like, or `>>`-like at ultra). */
const COMPOSER_RE = /^[\u203a\u00bb](?: |$)/
/** The footer under the composer: "<model> <effort> . <folder>". */
const FOOTER_RE = /^ {0,8}[A-Za-z0-9][A-Za-z0-9._:\/-]*(?: [A-Za-z]+)? \u00b7 \S/
/** On screen means the composer is not the one taking keys. */
const BLOCKING_RE = [
  /Do you trust the contents of this directory/i,
  /Press enter to continue/i,
  /Press enter to confirm or esc to go back/i,
]
/** A turn running (its status row). */
const BUSY_RE = /esc to interrupt/i

const nonBlank = (l: ScreenLine): boolean => l.text.trim() !== ''

/** The index of the composer row: the last row with the prompt glyph. */
function composerIndex(lines: ScreenLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (COMPOSER_RE.test(lines[i].text)) return i
  return -1
}

/** Whether Codex's composer is the one taking keys, from the live screen. */
export function codexComposerState(lines: ScreenLine[] | null | undefined): CodexComposerState {
  if (!lines || lines.length === 0) return 'not-ready'
  if (lines.some((l) => BLOCKING_RE.some((re) => re.test(l.text)))) return 'not-ready'
  const shown = lines.filter(nonBlank)
  const footer = shown[shown.length - 1]
  const composer = shown[shown.length - 2]
  if (!footer || !composer || !FOOTER_RE.test(footer.text) || !COMPOSER_RE.test(composer.text)) return 'not-ready'
  if (shown.some((l) => BUSY_RE.test(l.text))) return 'busy'
  return 'ready'
}

/** What is typed in the composer (the dim placeholder counts as nothing). */
export function codexComposerText(lines: ScreenLine[] | null | undefined): string {
  if (!lines) return ''
  const i = composerIndex(lines)
  if (i < 0) return ''
  return lines[i].typed.replace(/^[\u203a\u00bb] ?/, '').trim()
}

export const NOT_AT_PROMPT = 'Codex is not at its prompt, so nothing was sent.'
export const BUSY_NOW = 'Codex is busy with a turn, so nothing was sent.'
export const TEXT_IN_PROMPT = 'Something is already typed at the Codex prompt, so nothing was added.'

/** The run a command is typed into: its session record's start and its PTY's
 *  spawn token (a Restart bumps the first, a new PTY the second). */
export interface CodexRun { createdAt: number; spawnToken: number }

export interface CodexComposerDeps {
  readScreen: (sessionId: string) => ScreenLine[] | null
  currentRun: (sessionId: string) => CodexRun | null
  write: (sessionId: string, data: string) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

/** The session's current run, read from the store (not a component's copy):
 *  null when it has no live PTY. */
function liveRun(sessionId: string): CodexRun | null {
  const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
  if (!s || s.ptyExited || s.neverStarted) return null
  const spawnToken = currentSpawnToken(sessionId)
  if (spawnToken === undefined) return null
  return { createdAt: s.createdAt, spawnToken }
}

export const defaultCodexComposerDeps: CodexComposerDeps = {
  readScreen: readSessionScreen,
  currentRun: liveRun,
  write: writeSessionInput,
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
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

/**
 * Type `command` into the session's composer, then press Enter on its own
 * CODEX_SUBMIT_DELAY_MS later. Types nothing (and says why) unless the
 * composer is ready and empty and the session has a live run. The Enter is
 * pressed only if, by then, the run is the same one (same session start, same
 * PTY) and the composer holds exactly `command`: text the user typed in the
 * meantime, a screen that moved on, a Restart or an exit each leave the
 * command typed and unsent.
 */
export function typeIntoCodexComposer(sessionId: string, command: string, deps: CodexComposerDeps = defaultCodexComposerDeps): CodexTyping {
  const none = (reason: string): CodexTyping => ({ typed: false, reason, cancel: () => {} })
  const run = deps.currentRun(sessionId)
  if (!run) return none(NOT_AT_PROMPT)
  const screen = deps.readScreen(sessionId)
  const state = codexComposerState(screen)
  if (state === 'busy') return none(BUSY_NOW)
  if (state !== 'ready') return none(NOT_AT_PROMPT)
  if (codexComposerText(screen) !== '') return none(TEXT_IN_PROMPT)
  deps.write(sessionId, command)
  let handle: unknown = deps.setTimeout(() => {
    handle = null
    if (!sameRun(run, deps.currentRun(sessionId))) return
    if (codexComposerText(deps.readScreen(sessionId)) !== command) return
    deps.write(sessionId, '\r')
  }, CODEX_SUBMIT_DELAY_MS)
  return {
    typed: true,
    cancel: () => {
      if (handle !== null) deps.clearTimeout(handle)
      handle = null
    },
  }
}

/**
 * Wait for the session's composer to be ready and empty, then type `command`
 * as typeIntoCodexComposer does (Plan mode at launch). Polls every
 * CODEX_READY_POLL_MS; stops silently when the run it started with ends or is
 * replaced; after `timeoutMs` without a ready composer types nothing and
 * calls `onGiveUp` with a note. Never types into the trust prompt or a
 * picker: they are not the ready composer.
 */
export function typeWhenCodexComposerReady(
  sessionId: string,
  command: string,
  opts: { timeoutMs: number; onGiveUp: (note: string) => void },
  deps: CodexComposerDeps = defaultCodexComposerDeps,
): { cancel: () => void } {
  const run = deps.currentRun(sessionId)
  let waited = 0
  let handle: unknown = null
  let typing: CodexTyping | null = null
  let done = !run
  const poll = (): void => {
    handle = null
    if (done) return
    if (!sameRun(run, deps.currentRun(sessionId))) { done = true; return }
    const screen = deps.readScreen(sessionId)
    if (codexComposerState(screen) === 'ready' && codexComposerText(screen) === '') {
      done = true
      typing = typeIntoCodexComposer(sessionId, command, deps)
      return
    }
    waited += CODEX_READY_POLL_MS
    if (waited >= opts.timeoutMs) {
      done = true
      opts.onGiveUp(`${command} was not sent: Codex did not reach its prompt in time. Type ${command} in the terminal to use it.`)
      return
    }
    handle = deps.setTimeout(poll, CODEX_READY_POLL_MS)
  }
  if (!done) handle = deps.setTimeout(poll, 0)
  return {
    cancel: () => {
      done = true
      if (handle !== null) deps.clearTimeout(handle)
      handle = null
      typing?.cancel()
    },
  }
}
