import { useSettingsStore, type AppSettings } from '../stores/settingsStore'
import { useWebviewStore } from '../stores/webviewStore'
import { useSessionStore } from '../stores/sessionStore'
import { trackUsage } from '../stores/tipsStore'

/**
 * The two "where does claude.ai open" knobs (owner call 2026-08-26): both
 * GLOBAL, both defaulting to today's behaviour (the dedicated window), both
 * surfaced in Settings — plus the Artifacts button's right-click chooser.
 *
 * Sign-in additionally honours the per-account mode #439 shipped in rc.3:
 * with no global choice recorded, an account that had picked the internal
 * pane keeps signing in there. The stored per-account field is never written
 * or migrated by this module — read-time fallback only, so nothing a beta
 * user chose can be lost by upgrading.
 */

export type ClaudeWebTarget = 'window' | 'pane'

export function resolveArtifactsOpenTarget(s: Pick<AppSettings, 'artifactsOpenTarget'>): ClaudeWebTarget {
  return s.artifactsOpenTarget === 'pane' ? 'pane' : 'window'
}

export function resolveSignInOpenTarget(
  s: Pick<AppSettings, 'signInOpenTarget'>,
  accountPrefersPane: boolean,
): ClaudeWebTarget {
  if (s.signInOpenTarget === 'pane' || s.signInOpenTarget === 'window') return s.signInOpenTarget
  return accountPrefersPane ? 'pane' : 'window'
}

/** The session that can host the in-app account surface, if any — the same
 *  gate as the pane's own claude.ai entry (#475): local and not shell-only.
 *  Prefers the active session, then the given one, then any eligible.
 *
 *  `requirePreferred` binds the host to the caller's own vetted session (adv
 *  LOW-1): the artifacts callers pass the session whose account IS the one
 *  being opened, so hosting must NOT fall through to some other session (which
 *  could be running a different account) when that session is not eligible —
 *  it returns null and the caller takes the window path. The sign-in flow,
 *  which legitimately has no specific session, leaves it off. */
export function paneHostSession(preferredSessionId?: string, requirePreferred = false): string | null {
  const st = useSessionStore.getState()
  const eligible = st.sessions.filter((s) => !s.shellOnly && s.sessionType === 'local')
  const preferred = eligible.find((s) => s.id === preferredSessionId)
  if (requirePreferred) return preferred?.id ?? null
  const active = eligible.find((s) => s.id === st.activeSessionId)
  return (preferred ?? active ?? eligible[0])?.id ?? null
}

/**
 * Open an account's artifacts per the global setting. 'window' (default) is
 * exactly today's IPC path; 'pane' hosts #475's claude.ai account surface in a
 * session's browser pane. With no session able to host the pane, the window
 * path runs instead — the action never dead-ends.
 */
export function openArtifactsPerSetting(profileId: string, preferredSessionId?: string): void {
  trackUsage('artifacts.opened')
  if (resolveArtifactsOpenTarget(useSettingsStore.getState().settings) === 'pane') {
    // requirePreferred (adv LOW-1): only host in the caller's own vetted
    // session — the one whose account is `profileId`. Never fall through to
    // another session that may run a different account.
    const host = paneHostSession(preferredSessionId, true)
    if (host) {
      useWebviewStore.getState().openAccountPane(host, profileId)
      return
    }
  }
  void window.electronAPI.accountWeb
    ?.openArtifacts?.(profileId)
    .then((r) => { if (r && !r.ok) alert(`Could not open artifacts for this account: ${r.error}`) })
    .catch(() => alert('Could not open artifacts — the app could not reach the account window.'))
}
