import { create } from 'zustand'
import { generateId } from '../utils/id'
import { useSessionStore, type Session } from '../stores/sessionStore'
import { useAccountGateStore } from '../stores/accountGateStore'
import { clearSpawned } from '../ptyTracker'
import { writeSessionInput } from '../components/terminal/tmuxWheelScroll'
import { ASK_CLAUDE_OFF, askConductorProviderNow, askProviderIsOn, askTabProviderOff, isAskConductorBlocked } from './askConductorGate'
import { ASK_HELP_FOLDER_FAILED, type AskConductorProvider } from '../../shared/ask-conductor-provider'
import type { AskConductorNotice, CodexOptions, SubmitNotDeliveredReason } from '../../shared/types'

/**
 * Ask Conductor — the in-app help session.
 *
 * It is a REAL interactive session, not a modal: a modal has nowhere to
 * host the TUI, so it would have to shell out to `claude -p`, which is one-shot
 * with no resume, no history and no account identity. A bare positional prompt
 * (`claude "…"`) starts the ordinary interactive session with that prompt
 * already submitted, so resume/history/account switching all come for free.
 *
 * It runs on the assistant that is on; with Claude Code and Codex both on, on
 * the one Settings, General, "Ask Conductor runs on" names, Claude Code by
 * default (askConductorGate.ts; WP2 PR 4, P4.3). An open tab keeps the
 * assistant it started on; a revive of a closed one reads the choice again.
 *
 * What separates it from a project session is presentational and structural:
 *  - it carries `kind: 'ask'`, so the sidebar docks it at the bottom instead of
 *    filing it with project sessions, the tab wears the app monogram, and the
 *    pane gets a banded header;
 *  - it has NO saved config. The old path created and PERSISTED one called
 *    "Ask Conductor" into the user's Saved Configs, which is not something they
 *    filed and should never have been there.
 *
 * The opening question never becomes command text: it rides `pty.spawn`, and
 * main carries it. On Claude Code it goes into the spawn environment as
 * CCC_ASK_PROMPT and the launch line holds only the env reference
 * (spawn-claude-command.ts / terminal-launch-line.ts). On Codex it is a launch
 * argument after `--` on the direct route, the logged line naming only its
 * length, and elsewhere main types it at Codex's first ready, empty prompt
 * (WP2 PR 4, P4.3).
 */

/** Tab/pill label. Also the label an older persisted config may still carry. */
export const ASK_LABEL = 'Ask Conductor'
/** The pre-rename label; some installs still have a saved config under it. */
export const ASK_LEGACY_LABEL = 'Ask Command Center'

/** Matches the `askPrompt` bound in the pty:spawn zod schema (pty-handlers.ts).
 *  Capping here rather than letting main reject the spawn keeps an over-long
 *  paste working (truncated) instead of failing the launch outright. */
const MAX_QUESTION = 8000

/** Control, format and separator characters. `\s` is not this set: it covers
 *  CR/LF/TAB/VT/FF and Unicode spaces, and lets ESC, BEL, NUL, DEL and the bidi
 *  overrides through untouched. */
const CONTROLS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * One line, bounded, and free of control characters. Newlines are collapsed
 * rather than preserved because the same question has to work down two very
 * different paths: as a positional argument on a fresh spawn, and as keystrokes
 * typed into an ALREADY-RUNNING Claude TUI.
 *
 * On that second path the question is not text, it is KEY INPUT — the write
 * below appends `\r` and submits it. Collapsing whitespace alone left every
 * other control character intact, so a pasted question could carry ESC (which
 * the TUI reads as interrupt/clear), CSI sequences like back-tab that drive its
 * mode chords, `\x03`, or a bracketed-paste terminator. `<input>` strips CR and
 * LF from a paste and nothing else, so "paste a question you copied from a web
 * page" was the whole exploit. Stripping the class here fixes both paths, which
 * is what the old comment claimed and did not do.
 */
export function normaliseQuestion(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const one = raw.replace(CONTROLS_RE, ' ').replace(/\s+/g, ' ').trim()
  if (!one) return undefined
  if (one.length <= MAX_QUESTION) return one
  // Cut between two characters, never inside an emoji's surrogate pair: half
  // of one is not Unicode, and Codex refuses it on argv (review RASK-3).
  const last = one.charCodeAt(MAX_QUESTION - 1)
  return one.slice(0, last >= 0xd800 && last <= 0xdbff ? MAX_QUESTION - 1 : MAX_QUESTION)
}

/** The live Ask session, if one is open. */
export function findAskSession(sessions: Session[]): Session | undefined {
  return sessions.find((s) => s.kind === 'ask')
}

/**
 * Is this Ask session's process still there to talk to?
 *
 * A session object outlives its PTY: main deletes the PTY and sends
 * `pty:exit`, the renderer prints "[Process exited]" into the terminal, and
 * the session stays in the list looking exactly like a live one. Writing a
 * question to that id does not fail -- `pty.write` is `ipcRenderer.send`, so it
 * cannot report anything -- it lands in main's `pendingWrites` buffer, which
 * only a spawn drains and which a spawn CLEARS before it fills. The question is
 * not delayed, it is destroyed, and the box it was typed into is emptied as
 * though it had been sent.
 */
// Plain boolean, NOT a `session is Session` type predicate: with a non-optional
// argument the predicate narrows the false branch to `never`, which is exactly
// the branch the revive lives in.
export function askSessionIsLive(session: Session | undefined): boolean {
  return !!session && !session.ptyExited
}

/**
 * Transient launch failure, surfaced in the sidebar dock (the one place that is
 * always on screen for every entry point). `help:workspace` fails closed to
 * `null` when the help folder cannot be made exactly the app's own (main logs
 * a failed rebuild); the old code returned silently there, so the button
 * simply did nothing.
 */
interface AskErrorState {
  error: string | null
  setError: (message: string | null) => void
}
export const useAskErrorStore = create<AskErrorState>((set) => ({
  error: null,
  setError: (message) => set({ error: message }),
}))

/** With the folder rebuilt before every start (help-workspace.ts), the likely
 *  failure is an entry the app cannot remove, such as a file a program Codex
 *  started there still holds open, rather than an unwritable resources
 *  directory; the line names both, and the way out. The Ask tab says the same
 *  when main refuses a Restart for it (ASK_HELP_FOLDER_FAILED). */
const WORKSPACE_FAILED = ASK_HELP_FOLDER_FAILED

/** The permission preset a Codex Ask session starts on: the one matching
 *  Claude's Ask launch (parity, P4.3). Claude's Ask passes no permission mode
 *  (its session carries none, so no --permission-mode reaches the launch), so
 *  it runs in Claude's default mode, the session dialog's "Ask permissions"
 *  ("Claude asks before most actions"). P4.1 pairs the Codex presets with
 *  Claude's modes by their words (codexPresetApprovedTools,
 *  providers/codex/spawn.ts): Read Only with Ask permissions, Standard with
 *  Accept edits, Plan with Plan mode. So Read Only. Nothing relies on it to
 *  keep the help folder read-only: that folder is rebuilt before every Ask
 *  launch instead (help-workspace.ts). */
export const ASK_CODEX_PRESET: CodexOptions['permissionsPreset'] = 'read-only'

/**
 * What a restart clears from the previous run (useRestartSession's
 * forceRemount). A revive is a new start too, on the same assistant or the
 * other one, so none of the previous run's live state stays painted on it
 * (a Claude tab's usage limits on the Codex run that revives it, say). A test
 * reads the restart's list off the restart and holds this one to it.
 */
const PREVIOUS_RUN_CLEARED = {
  contextPercent: undefined,
  costUsd: undefined,
  needsAttention: false,
  modelName: undefined,
  launchedCodexPreset: undefined,
  effortLive: undefined,
  fastMode: undefined,
  ptyExited: undefined,
  sshTmuxPersistent: undefined,
  linesAdded: undefined,
  linesRemoved: undefined,
  inputTokens: undefined,
  outputTokens: undefined,
  totalDurationMs: undefined,
  rateLimitCurrent: undefined,
  rateLimitCurrentResets: undefined,
  rateLimitWeekly: undefined,
  rateLimitWeeklyResets: undefined,
  rateLimitExtra: undefined,
  usageBuckets: undefined,
  usageUnavailable: undefined,
  watchdog: undefined,
} satisfies Partial<Session>

/** The provider fields of an Ask session on `provider`. A Codex session needs
 *  its `codexOptions` (main refuses a Codex spawn without them). */
function askProviderFields(provider: AskConductorProvider): Pick<Session, 'provider' | 'codexOptions'> {
  return provider === 'codex'
    ? { provider: 'codex', codexOptions: { permissionsPreset: ASK_CODEX_PRESET } }
    : { provider: 'claude', codexOptions: undefined }
}

// -- The notice lines (P4.3) --------------------------------------------------

/** A notice as the dock shows it. `starting`: main had no running Ask session
 *  for the question while the tab was open and not ended, so the session was
 *  still starting, not closed (review RASK-5). */
export type ShownAskNotice = AskConductorNotice & { starting?: true }

/**
 * Ask Conductor's one-line notices, drawn in the dock (AskConductorDock), and
 * the question they are about.
 *
 * Main raises them (askConductor:notice) when it hands a question to Codex's
 * prompt: `removed`, the characters taken out first because the prompt would
 * have dropped them (question 6, default A); `not-delivered`, the question was
 * not sent, and why. The dock then KEEPS the question -- it is held here, the
 * last one handed to the Ask session, in memory only and never saved -- so the
 * user can send it again or copy it instead of losing it.
 */
interface AskNoticeState {
  /** The last question handed to an Ask session. */
  kept: { sessionId: string; question: string } | null
  /** The notice on show, or none. */
  notice: ShownAskNotice | null
  keep: (sessionId: string, question: string) => void
  show: (notice: ShownAskNotice) => void
  dismiss: () => void
}
export const useAskNoticeStore = create<AskNoticeState>((set) => ({
  kept: null,
  notice: null,
  // A new question replaces the last one, and what was said about the last
  // one no longer applies to it.
  keep: (sessionId, question) => set({ kept: { sessionId, question }, notice: null }),
  show: (notice) => set({ notice }),
  dismiss: () => set({ notice: null }),
}))

const NOT_DELIVERED: Record<SubmitNotDeliveredReason, string> = {
  'busy-timeout': 'Codex was still working, and its prompt did not come free in time.',
  'prompt-on-screen': 'Codex was showing a question of its own (folder trust, sandbox setup or an approval). Answer it in the Ask tab first.',
  'too-tall': 'it is too long to check in Codex\'s prompt at this pane size. Make the pane taller, or the question shorter.',
  'not-drawn': 'it never appeared in Codex\'s prompt.',
  'refused-text': 'it holds characters Codex\'s prompt cannot take.',
  'session-gone': 'the Ask session closed before it could be typed.',
}

function isNotDeliveredReason(v: unknown): v is SubmitNotDeliveredReason {
  return typeof v === 'string' && Object.hasOwn(NOT_DELIVERED, v)
}

/** A notice as main sends it, checked: anything else is not drawn. */
export function parseAskNotice(raw: unknown): AskConductorNotice | null {
  if (!raw || typeof raw !== 'object') return null
  const n = raw as Record<string, unknown>
  if (typeof n.sessionId !== 'string' || !n.sessionId) return null
  if (n.kind === 'removed' && typeof n.count === 'number' && Number.isInteger(n.count) && n.count > 0) {
    return { sessionId: n.sessionId, kind: 'removed', count: n.count }
  }
  if (n.kind === 'not-delivered' && isNotDeliveredReason(n.reason)) {
    return { sessionId: n.sessionId, kind: 'not-delivered', reason: n.reason }
  }
  return null
}

/** What a question handed to an Ask tab that is still starting is told
 *  (review RASK-5): it is kept, and Send again then reaches the session. */
const STILL_STARTING = 'the Ask session was still starting. Send it again in a moment.'

/** The line the dock shows for a notice. */
export function askNoticeText(notice: ShownAskNotice): string {
  if (notice.kind === 'removed') {
    return `Codex cannot take emoji or some rare characters typed into its prompt; ${notice.count} removed from your question.`
  }
  return `Your question was not sent: ${notice.starting === true && notice.reason === 'session-gone' ? STILL_STARTING : NOT_DELIVERED[notice.reason]}`
}

/** Raise a notice for the dock (main's, through the listener below, or a
 *  hand-off's own answer). */
export function showAskNotice(raw: unknown): void {
  const notice = parseAskNotice(raw)
  if (notice) useAskNoticeStore.getState().show(notice)
}

let stopNotices: (() => void) | null = null

/** Listen for main's notices, once for the renderer's life. Every Ask launch
 *  starts it (a notice only ever follows a question handed to Ask), and so
 *  does the dock. */
export function listenForAskNotices(): void {
  if (stopNotices) return
  const subscribe = window.electronAPI?.askConductor?.onNotice
  if (typeof subscribe !== 'function') return
  stopNotices = subscribe((notice) => showAskNotice(notice))
}

/** Stop listening and forget the notice state. Tests only. */
export function _resetAskNoticesForTest(): void {
  stopNotices?.()
  stopNotices = null
  useAskNoticeStore.setState({ kept: null, notice: null })
}

/**
 * Hand a question to the RUNNING Ask session `id`, kept for the dock first.
 *
 * An Ask session on Codex gets it through main's submit primitive (askConductor:handOff,
 * WP2 PR 4, P4.3), never as the raw question and Enter: Codex submits no
 * such write (PB3), and the primitive types only at its ready, empty prompt,
 * never into a trust, sandbox or approval screen. Main removes the characters
 * Codex's prompt would drop and says so, and says when the question was not
 * sent; the answer is shown here too, so a notice main could not push still
 * lands. The answer is about THIS question, so a not-delivered one keeps it
 * again: Send again and Copy then offer the question that was not sent, not
 * one handed over while it was being typed. A Claude tab keeps the PTY write
 * a command button uses (its TUI submits the line and its Enter).
 */
function handQuestionToRunning(id: string, provider: Session['provider'] | undefined, question: string): void {
  useAskNoticeStore.getState().keep(id, question)
  if (provider !== 'codex') {
    writeSessionInput(id, question + '\r')
    return
  }
  const notDelivered = (reason: SubmitNotDeliveredReason, mainAnswered = false): void => {
    useAskNoticeStore.getState().keep(id, question)
    // Main answered that it has no such running session while the tab is
    // open and has not ended: its process is still starting (a second click,
    // or a question handed over in its first moments), not closed (review
    // RASK-5).
    const tab = useSessionStore.getState().sessions.find((s) => s.id === id)
    if (mainAnswered && reason === 'session-gone' && askSessionIsLive(tab)) {
      useAskNoticeStore.getState().show({ sessionId: id, kind: 'not-delivered', reason, starting: true })
      return
    }
    showAskNotice({ sessionId: id, kind: 'not-delivered', reason })
  }
  const handOff = window.electronAPI?.askConductor?.handOff
  if (typeof handOff !== 'function') { notDelivered('session-gone'); return }
  void Promise.resolve()
    .then(() => handOff({ sessionId: id, question }))
    .then((answer) => {
      if (answer?.delivered === true) return
      const said = (answer as { reason?: unknown } | null | undefined)?.reason
      notDelivered(isNotDeliveredReason(said) ? said : 'session-gone', isNotDeliveredReason(said))
    })
    .catch(() => notDelivered('session-gone'))
}

/**
 * Open Ask Conductor, optionally with an opening question.
 *
 * If an Ask session is already open it is focused rather than duplicated — the
 * docked pill is a single affordance, not a session factory — and any question
 * is typed into that running session instead. Returns the session id, or '' if
 * the help workspace could not be staged or no assistant is on (the reason
 * lands in useAskErrorStore).
 */
/**
 * In-flight launch, so a second click while the first is still staging the help
 * workspace joins it instead of starting a second session.
 *
 * The guard below reads the session list BEFORE `await help.workspace()`, which
 * checks the help folder file by file in the main process and rebuilds it when
 * it is not exactly the app's own -- comfortably wider than a double-click. Two clicks therefore both saw "no ask session" and both
 * called addSession. That is not a cosmetic duplicate: `Sidebar` filters
 * `kind !== 'ask'` out of the session list and `AskConductorDock` binds to the
 * FIRST ask session, so the second is unreachable from either -- while still
 * being persisted by `buildSessionState` and restored on every launch. The only
 * way to reach it was the tab bar.
 */
let inFlightLaunch: Promise<string> | null = null

export function launchAskConductor(question?: string): Promise<string> {
  listenForAskNotices()
  // The backstop for every entry point (the dock, the command dialog, the
  // Feature Guide, the tip card, anything added later): with neither
  // assistant on, Ask starts nothing, revives nothing and types into nothing.
  // Each entry point shows itself disabled with the reason (askConductorGate);
  // the reason is also recorded here, for a caller that reads the error store.
  if (isAskConductorBlocked()) {
    useAskErrorStore.getState().setError(ASK_CLAUDE_OFF)
    return Promise.resolve('')
  }
  if (inFlightLaunch) {
    // Join the launch already running. A question typed on the second click
    // still has to land, and the session it belongs to is the one being staged,
    // so hand it over once that resolves -- the same hand-over the
    // already-running branch does (a PTY write on Claude Code, main's submit
    // primitive on Codex).
    const askPrompt = normaliseQuestion(question)
    return inFlightLaunch.then((id) => {
      if (id && askPrompt) {
        const session = useSessionStore.getState().sessions.find((s) => s.id === id)
        handQuestionToRunning(id, session?.provider, askPrompt)
      }
      return id
    })
  }
  inFlightLaunch = doLaunchAskConductor(question).finally(() => { inFlightLaunch = null })
  return inFlightLaunch
}

/** Reset the in-flight latch. Tests only. */
export function _resetAskLaunchForTest(): void {
  inFlightLaunch = null
}

/**
 * Hand a question to the Ask session that is running (handQuestionToRunning):
 * the spawn route is spawn-time only, so mid-session a Claude tab gets the
 * PTY write a command button uses, and one on Codex main's submit primitive.
 *
 * The tab keeps the assistant it started on. When that assistant has been
 * switched off since, nothing is typed into it (nothing is typed into an
 * assistant that is off) and the dock says why; going to the tab, with no
 * question, still works.
 */
function handOverToLive(existing: Session, askPrompt: string | undefined): string {
  const store = useSessionStore.getState()
  const provider: AskConductorProvider = existing.provider === 'codex' ? 'codex' : 'claude'
  if (askPrompt && !askProviderIsOn(provider)) {
    useAskErrorStore.getState().setError(askTabProviderOff(provider))
    return ''
  }
  useAskErrorStore.getState().setError(null)
  store.setActiveSession(existing.id)
  if (askPrompt) handQuestionToRunning(existing.id, existing.provider, askPrompt)
  return existing.id
}

/**
 * REVIVE an Ask session whose process has exited, rather than write into the
 * void. Bumping `createdAt` changes the TerminalView key, so the pane remounts
 * and respawns, and `askPrompt` then rides that spawn -- the same mechanism a
 * first launch uses, so the question is delivered by the path that is already
 * tested rather than by a second one. The id is deliberately KEPT: the tab,
 * its place in the strip and anything holding a reference to it all survive,
 * and the user gets their question answered in the tab they asked it from.
 *
 * A revive is a new start, so it reads the provider again (P4.3): when the
 * choice, or which assistants are on, changed since the tab last ran, it
 * starts on the assistant Ask starts on now. The previous assistant's account
 * and conversation fields do not come along, and the new one's account is
 * decided as on a first launch; on the same assistant the account was decided
 * when the session was first opened, and the revive must not re-pop the
 * picker over it, which is what restart does too. Either way the previous
 * run's live state is cleared as a restart clears it (PREVIOUS_RUN_CLEARED).
 * `dir` is the help folder just rebuilt for this start.
 */
function revive(existing: Session, askPrompt: string | undefined, dir: string, provider: AskConductorProvider): string {
  const store = useSessionStore.getState()
  const sameProvider = (existing.provider === 'codex' ? 'codex' : 'claude') === provider
  const providerFields = sameProvider
    ? (provider === 'codex' && !existing.codexOptions ? askProviderFields('codex') : {})
    : {
        ...askProviderFields(provider),
        model: '',
        profileId: undefined,
        providerAccountId: undefined,
        accountEmail: undefined,
        accountColour: undefined,
        resumeUuid: undefined,
        resumeCwd: undefined,
        reasoningEffort: undefined,
      }
  clearSpawned(existing.id)
  store.removeSession(existing.id)
  store.addSession({
    ...existing,
    ...providerFields,
    ...PREVIOUS_RUN_CLEARED,
    id: existing.id,
    askPrompt,
    workingDirectory: dir,
    status: 'idle',
    createdAt: Date.now(),
  })
  if (sameProvider) useAccountGateStore.getState().markPredetermined(existing.id)
  store.setActiveSession(existing.id)
  if (askPrompt) useAskNoticeStore.getState().keep(existing.id, askPrompt)
  return existing.id
}

async function doLaunchAskConductor(question?: string): Promise<string> {
  const askPrompt = normaliseQuestion(question)

  const existing = findAskSession(useSessionStore.getState().sessions)
  if (existing && askSessionIsLive(existing)) return handOverToLive(existing, askPrompt)

  // A first launch and a revive both start a process in the help folder, so
  // both have it rebuilt to exactly the app's own files first: nothing a
  // session wrote there may reach the next one (help-workspace.ts).
  let dir: string | null = null
  try {
    dir = await window.electronAPI.help.workspace()
  } catch {
    dir = null
  }
  if (!dir) {
    useAskErrorStore.getState().setError(WORKSPACE_FAILED)
    return ''
  }

  // Read AFTER the await: the switches may have flipped meanwhile.
  const provider = askConductorProviderNow()
  if (!provider) {
    useAskErrorStore.getState().setError(ASK_CLAUDE_OFF)
    return ''
  }
  useAskErrorStore.getState().setError(null)

  // Re-read AFTER the await. The latch above covers the ordinary double-click,
  // but the store is a live singleton and this function is not the only thing
  // that can add (or restart) a session while the folder is checked. Cheap, and
  // it makes the "one ask session" claim true by construction rather than by
  // timing.
  const now = findAskSession(useSessionStore.getState().sessions)
  if (now) return askSessionIsLive(now) ? handOverToLive(now, askPrompt) : revive(now, askPrompt, dir, provider)

  const store = useSessionStore.getState()
  const id = generateId()
  store.addSession({
    id,
    // Deliberately NO configId: this session is not a launched saved config,
    // and nothing must file it as one.
    kind: 'ask',
    askPrompt,
    label: ASK_LABEL,
    workingDirectory: dir,
    model: '',
    // The identity blue, so the tab tint reads as the brand mark it carries.
    color: '#5d8bf0',
    identityColorKey: 'lavender',
    status: 'idle',
    createdAt: Date.now(),
    // Pinned local: SSH never carries the opening question.
    sessionType: 'local',
    ...askProviderFields(provider),
  })
  if (askPrompt) useAskNoticeStore.getState().keep(id, askPrompt)
  // NOTE: markSessionForResumePicker is deliberately NOT called. Both resume-
  // picker branches of buildClaudeLaunchCommand return before the positional
  // prompt is appended, so routing a first launch through the picker would drop
  // the question with no error. "Past discussions" restarts the session and
  // asks for the picker instead, which takes the ordinary picker path.
  return id
}
