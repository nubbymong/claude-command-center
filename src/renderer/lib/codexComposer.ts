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

export type CodexComposerState = 'ready' | 'busy' | 'not-ready'
/** What the live screen shows, in more detail than the state (round 2, WW):
 *  'unrecognised' is a composer with a footer under it that is not the last
 *  row (a narrow window wraps it, or a row is drawn under it). */
export type CodexScreenKind = 'ready' | 'busy' | 'blocked' | 'no-prompt' | 'unrecognised' | 'starting'

/** Codex's prompt glyphs: the composer's, and the one it draws at ultra. */
const GLYPHS = String.fromCharCode(0x203a) + String.fromCharCode(0xbb)
const MIDDLE_DOT = String.fromCharCode(0xb7)
/** The composer row: a prompt glyph, then a space or nothing. */
const COMPOSER_RE = new RegExp(`^[${GLYPHS}](?: |$)`)
const GLYPH_PREFIX_RE = new RegExp(`^[${GLYPHS}] ?`)
/** The efforts the footer names: Codex's levels, and "default" when the
 *  model's own applies (VM: gpt-5.2 and gpt-5.3-codex launched with none). */
const FOOTER_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'default']
/** A model id as the footer can show it, when the session's are not known. */
const ANY_MODEL = '[A-Za-z0-9][A-Za-z0-9._:/-]*'
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
/** The footer (round 2, FT): "<model> <effort> . <folder>", the model one of
 *  `models` when they are given. Codex's own hint lines ("enter select . esc
 *  back", "MCP servers . 2 enabled", "Git . main") name no level after a
 *  model, so they never match. */
function footerRe(models?: readonly string[] | null): RegExp {
  const model = models && models.length > 0 ? `(?:${models.map(escapeRe).join('|')})` : ANY_MODEL
  return new RegExp(`^ {0,8}${model} (?:${FOOTER_EFFORTS.join('|')}) ${MIDDLE_DOT} \\S`)
}
/** On screen means the composer is not the one taking keys: the trust
 *  prompt, Codex's pickers and notices, and (round 2, defence in depth; not
 *  reachable on the VM without a working model) its approval requests, as the
 *  binaries of 0.153.4 and 0.155.1 word them. */
const BLOCKING_RE = [
  /Do you trust the contents of this directory/i,
  /Press enter to continue/i,
  /Press enter to confirm or esc to go back/i,
  /Would you like to run the following command/i,
  /Would you like to send input to (?:the existing )?terminal/i,
  /Do you want to approve network access/i,
  /Would you like to grant these permissions/i,
  /Would you like to make the following edits/i,
  /needs your approval/i,
]
/** A turn running (its status row). */
const BUSY_RE = /esc to interrupt/i
/** Codex still starting (round 3, V1): 0.153.4 boots its MCP servers after
 *  drawing its prompt, under a status row that reads like a turn ("Booting
 *  MCP server: conductor (0s . esc to interrupt)"); the binaries also say
 *  "Starting MCP servers". Not busy, and not the user's doing. */
const STARTING_RE = /\b(?:Booting MCP server|Starting MCP servers?)\b/i
/** The composer's placeholders (the binaries' strings), drawn dim. */
const PLACEHOLDERS = ['Ask Codex to do anything', 'Ask a follow-up question']
/** A row of the slash-command popup under a typed command. */
const POPUP_ROW_RE = /^ {1,8}\/[a-z][\w-]*(?: |$)/

const nonBlank = (l: ScreenLine): boolean => l.text.trim() !== ''
const blocked = (lines: ScreenLine[]): boolean => lines.some((l) => BLOCKING_RE.some((re) => re.test(l.text)))

/** The index of the composer row: the last row with the prompt glyph. */
function composerIndex(lines: ScreenLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (COMPOSER_RE.test(lines[i].text)) return i
  return -1
}

/** A composer row's content: '' only for nothing or one of Codex's dim
 *  placeholders; anything else there, dim or not, is content (round 2, FT). */
function composerContent(row: ScreenLine): string {
  const all = row.text.replace(GLYPH_PREFIX_RE, '').trim()
  if (all === '') return ''
  const typed = row.typed.replace(GLYPH_PREFIX_RE, '').trim()
  if (typed === '' && PLACEHOLDERS.includes(all)) return ''
  return all
}

/** The screen's structure: what it shows, the composer's content, and the
 *  footer row under the composer when that is the last row. `startup`
 *  (round 4, E3): whether the run is still starting, so that Codex's
 *  start-up row counts; it counts only in its own place, the status row
 *  directly above the composer. */
function layout(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null, startup = true): { screen: CodexScreenKind; text: string; footer: ScreenLine | null } {
  if (!lines || lines.length === 0) return { screen: 'no-prompt', text: '', footer: null }
  if (blocked(lines)) return { screen: 'blocked', text: '', footer: null }
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  const text = i < 0 ? '' : composerContent(shown[i])
  if (startup && i > 0 && STARTING_RE.test(shown[i - 1].text)) return { screen: 'starting', text, footer: null }
  if (i < 0) return { screen: 'no-prompt', text: '', footer: null }
  const footer = footerRe(models)
  const below = shown.slice(i + 1)
  if (below.length === 1 && footer.test(below[0].text)) {
    return { screen: shown.some((l) => BUSY_RE.test(l.text)) ? 'busy' : 'ready', text, footer: below[0] }
  }
  if (below.some((l) => footer.test(l.text))) return { screen: 'unrecognised', text, footer: null }
  return { screen: 'no-prompt', text, footer: null }
}

/** What the live screen shows, and the composer's content when there is one.
 *  `startup` false: the run has had its first turn (or a command sent), so a
 *  row that looks like Codex's start-up row reads as what it says. */
export function readCodexScreen(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null, opts: { startup?: boolean } = {}): { screen: CodexScreenKind; text: string } {
  const { screen, text } = layout(lines, models, opts.startup ?? true)
  return { screen, text }
}

/** Whether Codex's composer is the one taking keys, from the live screen. */
export function codexComposerState(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null): CodexComposerState {
  const { screen } = readCodexScreen(lines, models)
  return screen === 'ready' ? 'ready' : screen === 'busy' ? 'busy' : 'not-ready'
}

/** What is in the composer ('' for nothing or Codex's placeholder). */
export function codexComposerText(lines: ScreenLine[] | null | undefined): string {
  if (!lines) return ''
  const i = composerIndex(lines)
  return i < 0 ? '' : composerContent(lines[i])
}

/** Whether the screen shows `command` typed at the composer with nothing in
 *  the way (round 2, G5): no blocking prompt, no turn running, the composer
 *  holding exactly the command, and under it only its popup or the footer. */
export function codexCommandTyped(lines: ScreenLine[] | null | undefined, command: string, models?: readonly string[] | null): boolean {
  if (!lines || lines.length === 0 || blocked(lines) || lines.some((l) => BUSY_RE.test(l.text))) return false
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0 || composerContent(shown[i]) !== command) return false
  const footer = footerRe(models)
  return shown.slice(i + 1).every((l) => POPUP_ROW_RE.test(l.text) || footer.test(l.text))
}

/** Codex's Plan mode label, right-aligned in its footer after the folder. */
const PLAN_MODE_SEGMENT_RE = /^Plan mode(?: \(shift\+tab to cycle\))?$/
/** The cells Codex leaves after its footer's right segment (the raw bytes). */
const PLAN_MODE_RIGHT_MARGIN = 2
/** Whether Codex's footer shows its Plan mode (rounds 2 and 3; PM1, T19):
 *  read only from the footer row under the composer (the screen's own
 *  structure, the session's models when given), and only from its
 *  right-aligned segment after the folder, so neither a folder named "Plan
 *  mode" nor a footer-shaped line elsewhere reads as it. null when no footer
 *  shows there (a popup, a prompt or start-up: nothing to go by). */
export function codexPlanModeOnScreen(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null): boolean | null {
  const { screen, footer } = layout(lines, models)
  if ((screen !== 'ready' && screen !== 'busy') || footer === null) return null
  const right = / {3,}(\S(?:.*\S)?)\s*$/.exec(footer.text)
  if (!right || !PLAN_MODE_SEGMENT_RE.test(right[1])) return false
  // Round 4 (E4): Codex draws the segment right-aligned, ending two cells
  // from the right edge (the raw footer bytes: the segment, then two
  // spaces); a screen reader that knows the row's width holds it to that.
  if (footer.width !== undefined && footer.end !== undefined && footer.end !== footer.width - PLAN_MODE_RIGHT_MARGIN) return false
  return true
}

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
