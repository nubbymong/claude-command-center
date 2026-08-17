// @vitest-environment jsdom
// Regression: the per-session account choice (profileId) must hit disk EAGERLY,
// not only on graceful close -- a crash previously dropped it, so the next launch
// re-defaulted the account gate to primary instead of the last-used account.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { persistLastUsedAccount } from '../../../src/renderer/session-persistence'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import { useSettingsStore } from '../../../src/renderer/stores/settingsStore'

let saved: any[] = []
beforeEach(() => {
  saved = []
  ;(globalThis as any).window.electronAPI = {
    session: { save: vi.fn(async (state: any) => { saved.push(state); return true }) },
  }
  useSessionStore.setState({
    sessions: [{ id: 's1', label: 'a', workingDirectory: '/', model: 'opus', color: '#fff', status: 'idle', createdAt: 0, sessionType: 'local', provider: 'claude' } as any],
    activeSessionId: 's1',
  })
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, lastUsedAccountId: undefined } }))
})

describe('persistLastUsedAccount', () => {
  it('pins profileId in the store synchronously and flushes it to disk', async () => {
    await persistLastUsedAccount('s1', 'profile-x')
    // In-memory store updated
    expect(useSessionStore.getState().sessions[0].profileId).toBe('profile-x')
    // Flushed to disk exactly once, carrying the chosen profileId
    expect(window.electronAPI.session.save).toHaveBeenCalledTimes(1)
    expect(saved[0].sessions[0].profileId).toBe('profile-x')
  })

  it('persists a switch back to the default account (undefined profileId)', async () => {
    useSessionStore.getState().updateSession('s1', { profileId: 'profile-old' })
    await persistLastUsedAccount('s1', undefined)
    expect(useSessionStore.getState().sessions[0].profileId).toBeUndefined()
    expect(saved[0].sessions[0].profileId).toBeUndefined()
  })

  it('updates the store even if the disk flush throws (best-effort)', async () => {
    ;(window.electronAPI.session.save as any).mockRejectedValueOnce(new Error('disk full'))
    await expect(persistLastUsedAccount('s1', 'profile-y')).resolves.toBeUndefined()
    expect(useSessionStore.getState().sessions[0].profileId).toBe('profile-y')
  })

  it('records the global "last used" account so the launch gate can offer it', async () => {
    await persistLastUsedAccount('s1', 'profile-z')
    expect(useSettingsStore.getState().settings.lastUsedAccountId).toBe('profile-z')
  })

  it('does NOT clear the global last-used when a session switches to the default (undefined) account', async () => {
    await persistLastUsedAccount('s1', 'profile-keep')
    await persistLastUsedAccount('s1', undefined)
    // The per-session pin cleared, but the global "last used" survives as a
    // useful default for the next new session.
    expect(useSessionStore.getState().sessions[0].profileId).toBeUndefined()
    expect(useSettingsStore.getState().settings.lastUsedAccountId).toBe('profile-keep')
  })
})
