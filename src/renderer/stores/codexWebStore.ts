import { create } from 'zustand'
import type { CodexWebSessionView } from '../../shared/account-web-session'

/**
 * A Codex account's chatgpt.com web session, as the renderer knows it (WP2 PR
 * 4, P4.6, row 58): one source for the session menu and the Settings row, as
 * accountAuthStore is for Claude's claude.ai session. Every call goes through
 * the codexWeb bridge, which main gates (the app window, the registry account
 * id, a known non-archived Codex account); an older preload without it leaves
 * everything as "none".
 */
interface CodexWebState {
  /** The last status main reported, by registry account id. */
  byAccount: Record<string, CodexWebSessionView>
  /** The account whose sign-in is running now (one at a time app-wide). */
  signingIn: string | null
  /** The last failure to show for an account, verbatim from main. */
  errors: Record<string, string | null>
  refresh: (accountId: string) => Promise<void>
  signIn: (accountId: string) => Promise<void>
  cancel: (accountId: string) => Promise<void>
  signOut: (accountId: string) => Promise<void>
  /** Pick up a sign-in main is running (after a renderer reload) and follow
   *  it to its end. */
  restore: () => Promise<void>
}

const RESTORE_POLL_MS = 1500

const setError = (accountId: string, error: string | null) =>
  useCodexWebStore.setState((s) => ({ errors: { ...s.errors, [accountId]: error } }))

let restoring = false

export const useCodexWebStore = create<CodexWebState>((set, get) => ({
  byAccount: {},
  signingIn: null,
  errors: {},
  refresh: async (accountId) => {
    try {
      const r = await window.electronAPI.codexWeb?.status?.(accountId)
      if (r?.ok) set((s) => ({ byAccount: { ...s.byAccount, [accountId]: r.web } }))
    } catch { /* the last known status stands */ }
  },
  signIn: async (accountId) => {
    const api = window.electronAPI.codexWeb
    if (typeof api?.signIn !== 'function') return
    // The slot belongs to the run that took it: a second sign-in main refuses
    // (one at a time) never takes over, or clears, the running one's slot.
    const claimed = get().signingIn === null
    if (claimed) set({ signingIn: accountId })
    setError(accountId, null)
    try {
      const r = await api.signIn(accountId)
      if (!r.ok) setError(accountId, r.error)
      else if (r.state.phase === 'failed') setError(accountId, r.state.error ?? 'The sign-in did not finish.')
    } catch {
      setError(accountId, 'The sign-in could not start. Try again.')
    } finally {
      if (claimed && get().signingIn === accountId) set({ signingIn: null })
      await get().refresh(accountId)
    }
  },
  cancel: async (accountId) => {
    try { await window.electronAPI.codexWeb?.cancel?.(accountId) } catch { /* the run ends on its own */ }
  },
  signOut: async (accountId) => {
    const api = window.electronAPI.codexWeb
    if (typeof api?.signOut !== 'function') return
    setError(accountId, null)
    try {
      const r = await api.signOut(accountId)
      if (!r.ok) setError(accountId, r.error)
    } catch {
      setError(accountId, 'The sign-out did not finish. Try again.')
    } finally {
      await get().refresh(accountId)
    }
  },
  restore: async () => {
    const api = window.electronAPI.codexWeb
    if (restoring || typeof api?.signInState !== 'function') return
    restoring = true
    let followed: string | null = null
    try {
      for (;;) {
        let r
        try { r = await api.signInState() } catch { break }
        if (!r?.ok) break
        const st = r.state
        if (st.phase !== 'awaiting-user' || !st.accountId) break
        // Another account's run is in flight now: the one followed has ended.
        if (followed !== null && st.accountId !== followed) break
        if (followed === null) {
          if (get().signingIn !== null) break // this renderer is already following a run
          followed = st.accountId
          set({ signingIn: followed })
        }
        await new Promise((res) => setTimeout(res, RESTORE_POLL_MS))
      }
    } finally {
      restoring = false
      if (followed !== null) {
        if (get().signingIn === followed) set({ signingIn: null })
        await get().refresh(followed)
      }
    }
  },
}))
