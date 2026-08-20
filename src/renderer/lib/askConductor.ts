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

/**
 * One line, bounded. Newlines are collapsed rather than preserved because the
 * same question has to work down two very different paths: as a positional
 * argument on a fresh spawn, and as keystrokes typed into an ALREADY-RUNNING
 * Claude TUI, where a bare newline submits early and would split the question
 * into fragments. Collapsing in one place keeps both paths identical.
 */
export function normaliseQuestion(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const one = raw.replace(/\s+/g, ' ').trim()
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
export async function launchAskConductor(question?: string): Promise<string> {
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
