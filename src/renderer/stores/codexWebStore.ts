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
  /** The account whose sign-in this renderer started and is waiting on. */
  signingIn: string | null
  /** The last failure to show for an account, verbatim from main. */
  errors: Record<string, string | null>
  refresh: (accountId: string) => Promise<void>
  signIn: (accountId: string) => Promise<void>
  cancel: (accountId: string) => Promise<void>
  signOut: (accountId: string) => Promise<void>
}

const setError = (accountId: string, error: string | null) =>
  useCodexWebStore.setState((s) => ({ errors: { ...s.errors, [accountId]: error } }))

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
    set({ signingIn: accountId })
    setError(accountId, null)
    try {
      const r = await api.signIn(accountId)
      if (!r.ok) setError(accountId, r.error)
      else if (r.state.phase === 'failed') setError(accountId, r.state.error ?? 'The sign-in did not finish.')
    } catch {
      setError(accountId, 'The sign-in could not start. Try again.')
    } finally {
      if (get().signingIn === accountId) set({ signingIn: null })
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
}))
