// accountAuthStore.ts — per-account Claude Code (CLI) + claude.ai (web) auth
// status, keyed by profileId, shared by the session-header pills and the sidebar
// context menu so both read one source and a sign-in refreshes both.
//
// NOT continuously polled: the Claude Code check shells out to `claude auth
// status` (up to ~10s), so status is fetched on demand — when a session becomes
// active, after a sign-in/out, and on a manual pill refresh — and cached with the
// time it was read. Callers dedupe concurrent refreshes per profile.
import { create } from 'zustand'

export type WebAuthStatus = 'none' | 'active' | 'expired'

export interface AccountAuthStatus {
  /** Claude Code CLI signed in for this account. undefined = not fetched yet. */
  cliAuthed?: boolean
  /** claude.ai web session. undefined = not fetched yet. */
  web?: WebAuthStatus
  /** A refresh is in flight. */
  loading: boolean
  /** Epoch ms of the last successful read; undefined until first success. */
  fetchedAt?: number
  /** Last error message, if the most recent fetch failed. */
  error?: string
}

interface AccountAuthState {
  byProfile: Record<string, AccountAuthStatus>
  /** Fetch (or re-fetch) both statuses for one account. Deduped per profile.
   *  An AUTO refresh (the default, e.g. on session activate) is skipped when a
   *  successful read is younger than AUTO_REFRESH_TTL_MS — the Claude Code probe
   *  shells out and rotates the single-use refresh token, so tabbing between
   *  sessions must not re-probe every time. `force` (a manual pill refresh, or a
   *  refresh right after a sign-in/out) always probes. */
  refresh: (profileId: string, opts?: { force?: boolean }) => Promise<void>
  /**
   * Fetch ONLY the claude.ai web-session status.
   *
   * `refresh` cannot answer "does this account have a web session" without first
   * awaiting the `claude auth status` subprocess, because the main-process
   * handler resolves both together. Anything that needs just the web answer --
   * the sidebar context menu deciding whether "Open artifacts" is live -- was
   * therefore waiting seconds on a question that is a local JSON read, and
   * rendering a disabled item in the meantime. Never gated by the TTL: it costs
   * a file read, and the whole point is that it lands before the user clicks.
   */
  refreshWeb: (profileId: string) => Promise<void>
  /** Drop a profile's cached status (e.g. account deleted). */
  clear: (profileId: string) => void
}

const inFlight = new Set<string>()

/** How long a successful status read is reused for an AUTO refresh before the
 *  next one re-probes. Long enough that tabbing between sessions of one account
 *  does not shell out repeatedly; short enough that status is not badly stale.
 *  A sign-in/out refreshes with force:true, so it is never gated by this. */
export const AUTO_REFRESH_TTL_MS = 30_000

export const useAccountAuthStore = create<AccountAuthState>((set, get) => ({
  byProfile: {},

  refresh: async (profileId: string, opts?: { force?: boolean }) => {
    if (!profileId) return
    // Freshness window: an auto refresh reuses a recent SUCCESSFUL read (fetchedAt
    // set, no error) rather than re-probing. A failed/never-read status is not
    // fresh, so it still retries; force bypasses the window entirely.
    if (!opts?.force) {
      const cur = get().byProfile[profileId]
      if (cur && cur.fetchedAt !== undefined && !cur.error && Date.now() - cur.fetchedAt < AUTO_REFRESH_TTL_MS) return
    }
    // Dedupe: a second request while one is running is a no-op — the running one
    // will publish the fresh status to every subscriber.
    if (inFlight.has(profileId)) return
    inFlight.add(profileId)
    set((s) => ({ byProfile: { ...s.byProfile, [profileId]: { ...(s.byProfile[profileId] ?? {}), loading: true, error: undefined } } }))
    try {
      const r = await window.electronAPI.accountWeb.status(profileId)
      if (r.ok) {
        set((s) => ({
          byProfile: {
            ...s.byProfile,
            [profileId]: { cliAuthed: !!r.cli?.authenticated, web: r.web?.status ?? 'none', loading: false, fetchedAt: Date.now() },
          },
        }))
      } else {
        set((s) => ({ byProfile: { ...s.byProfile, [profileId]: { ...(s.byProfile[profileId] ?? {}), loading: false, error: r.error || 'status failed' } } }))
      }
    } catch (err) {
      set((s) => ({ byProfile: { ...s.byProfile, [profileId]: { ...(s.byProfile[profileId] ?? {}), loading: false, error: (err as Error)?.message ?? 'status failed' } } }))
    } finally {
      inFlight.delete(profileId)
    }
    void get
  },

  refreshWeb: async (profileId: string) => {
    if (!profileId) return
    try {
      const r = await window.electronAPI.accountWeb.webStatus(profileId)
      if (!r.ok) return
      // Merge, never replace: `cliAuthed` and `fetchedAt` belong to the full
      // probe and must survive this. Deliberately does NOT set `fetchedAt` --
      // that stamp means "the CLI probe succeeded at this time" and drives the
      // TTL, so stamping it here would suppress the next real refresh.
      set((s) => ({
        byProfile: {
          ...s.byProfile,
          [profileId]: { ...(s.byProfile[profileId] ?? { loading: false }), web: r.web?.status ?? 'none' },
        },
      }))
    } catch {
      // Leave whatever is cached. A failed cheap read is not evidence the
      // session is gone, and downgrading it to 'none' here would disable the
      // menu item on a working account.
    }
  },

  clear: (profileId: string) => set((s) => {
    const next = { ...s.byProfile }
    delete next[profileId]
    return { byProfile: next }
  }),
}))

/** Test seam: reset the in-flight dedupe set + store between tests. */
export function _resetAccountAuthForTest(): void {
  inFlight.clear()
  useAccountAuthStore.setState({ byProfile: {} })
}
