import { create } from 'zustand'
import { generateId } from '../utils/id'
import { useSessionStore, type Session } from '../stores/sessionStore'

/**
 * Ask Conductor — the in-app help session.
 *
 * It is a REAL interactive Claude session, not a modal: a modal has nowhere to
 * host the TUI, so it would have to shell out to `claude -p`, which is one-shot
 * with no resume, no history and no account identity. A bare positional prompt
 * (`claude "…"`) starts the ordinary interactive session with that prompt
 * already submitted, so resume/history/account switching all come for free.
 *
 * What separates it from a project session is presentational and structural:
 *  - it carries `kind: 'ask'`, so the sidebar docks it at the bottom instead of
 *    filing it with project sessions, the tab wears the app monogram, and the
 *    pane gets a banded header;
 *  - it has NO saved config. The old path created and PERSISTED one called
 *    "Ask Conductor" into the user's Saved Configs, which is not something they
 *    filed and should never have been there.
 *
 * The opening question never becomes command text: it rides `pty.spawn` into
 * the spawn environment as CCC_ASK_PROMPT and the launch line carries only the
 * env reference. See spawn-claude-command.ts / terminal-launch-line.ts.
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
  return one.length > MAX_QUESTION ? one.slice(0, MAX_QUESTION) : one
}

/** The live Ask session, if one is open. */
export function findAskSession(sessions: Session[]): Session | undefined {
  return sessions.find((s) => s.kind === 'ask')
}

/**
 * Transient launch failure, surfaced in the sidebar dock (the one place that is
 * always on screen for every entry point). `help:workspace` fails closed to
 * `null` when the resources directory cannot be written; the old code returned
 * silently there, so the button simply did nothing.
 */
interface AskErrorState {
  error: string | null
  setError: (message: string | null) => void
}
export const useAskErrorStore = create<AskErrorState>((set) => ({
  error: null,
  setError: (message) => set({ error: message }),
}))

const WORKSPACE_FAILED =
  'Could not stage the help workspace. Check that the resources directory is writable.'

/**
 * Open Ask Conductor, optionally with an opening question.
 *
 * If an Ask session is already open it is focused rather than duplicated — the
 * docked pill is a single affordance, not a session factory — and any question
 * is typed into that running session instead. Returns the session id, or '' if
 * the help workspace could not be staged (the reason lands in useAskErrorStore).
 */
/**
 * In-flight launch, so a second click while the first is still staging the help
 * workspace joins it instead of starting a second session.
 *
 * The guard below reads the session list BEFORE `await help.workspace()`, which
 * does an mkdir and two file writes in the main process -- comfortably wider
 * than a double-click. Two clicks therefore both saw "no ask session" and both
 * called addSession. That is not a cosmetic duplicate: `Sidebar` filters
 * `kind !== 'ask'` out of the session list and `AskConductorDock` binds to the
 * FIRST ask session, so the second is unreachable from either -- while still
 * being persisted by `buildSessionState` and restored on every launch. The only
 * way to reach it was the tab bar.
 */
let inFlightLaunch: Promise<string> | null = null

export function launchAskConductor(question?: string): Promise<string> {
  if (inFlightLaunch) {
    // Join the launch already running. A question typed on the second click
    // still has to land, and the session it belongs to is the one being staged,
    // so hand it over once that resolves -- the same PTY write the
    // already-running branch does.
    const askPrompt = normaliseQuestion(question)
    return inFlightLaunch.then((id) => {
      if (id && askPrompt) window.electronAPI.pty.write(id, askPrompt + '\r')
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

async function doLaunchAskConductor(question?: string): Promise<string> {
  const askPrompt = normaliseQuestion(question)
  const store = useSessionStore.getState()

  const existing = findAskSession(store.sessions)
  if (existing) {
    store.setActiveSession(existing.id)
    // Already running: the env route is spawn-time only, so hand the question
    // over the same way a command button does — write it to the PTY.
    if (askPrompt) window.electronAPI.pty.write(existing.id, askPrompt + '\r')
    return existing.id
  }

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
  useAskErrorStore.getState().setError(null)

  // Re-read AFTER the await. The latch above covers the ordinary double-click,
  // but the store is a live singleton and this function is not the only thing
  // that can add a session while an mkdir is in flight. Cheap, and it makes the
  // "one ask session" claim true by construction rather than by timing.
  const raced = findAskSession(useSessionStore.getState().sessions)
  if (raced) {
    store.setActiveSession(raced.id)
    if (askPrompt) window.electronAPI.pty.write(raced.id, askPrompt + '\r')
    return raced.id
  }

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
    // Pinned: CCC_ASK_PROMPT is set only on the local Claude spawn path. SSH
    // never sets it and the Codex provider ignores it, so an Ask session that
    // was any other shape would silently drop the question.
    sessionType: 'local',
    provider: 'claude',
  })
  // NOTE: markSessionForResumePicker is deliberately NOT called. Both resume-
  // picker branches of buildClaudeLaunchCommand return before the positional
  // prompt is appended, so routing a first launch through the picker would drop
  // the question with no error. "Past discussions" restarts the session
  // instead, which takes the ordinary picker path.
  return id
}
