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
  /** Fetch (or re-fetch) both statuses for one account. Deduped per profile. */
  refresh: (profileId: string) => Promise<void>
  /** Drop a profile's cached status (e.g. account deleted). */
  clear: (profileId: string) => void
}

const inFlight = new Set<string>()

export const useAccountAuthStore = create<AccountAuthState>((set, get) => ({
  byProfile: {},

  refresh: async (profileId: string) => {
    if (!profileId) return
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
        set((s) => ({ byProfile: { ...s.byProfile, [profileId]: { ...(s.byProfile[profileId] ?? {}), loading: false, error: r.error } } }))
      }
    } catch (err) {
      set((s) => ({ byProfile: { ...s.byProfile, [profileId]: { ...(s.byProfile[profileId] ?? {}), loading: false, error: (err as Error)?.message ?? 'status failed' } } }))
    } finally {
      inFlight.delete(profileId)
    }
    void get
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
