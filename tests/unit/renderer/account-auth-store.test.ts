// @vitest-environment jsdom
// The shared per-account auth store behind the session-header pills + the sidebar
// context menu. Covers the status mapping, the per-profile dedupe (the CLI probe
// is heavy, so a second concurrent refresh must not fire a second fetch), and the
// error path.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAccountAuthStore, _resetAccountAuthForTest } from '../../../src/renderer/stores/accountAuthStore'

let statusMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  _resetAccountAuthForTest()
  statusMock = vi.fn()
  ;(globalThis as any).window.electronAPI = { accountWeb: { status: statusMock } }
})

describe('accountAuthStore.refresh', () => {
  it('maps cli.authenticated + web.status into the per-profile record', async () => {
    statusMock.mockResolvedValue({ ok: true, cli: { authenticated: true }, web: { status: 'active' } })
    await useAccountAuthStore.getState().refresh('profile-a')
    const rec = useAccountAuthStore.getState().byProfile['profile-a']
    expect(rec.cliAuthed).toBe(true)
    expect(rec.web).toBe('active')
    expect(rec.loading).toBe(false)
    expect(typeof rec.fetchedAt).toBe('number')
  })

  it('reports signed-out / not-connected without inventing a truthy status', async () => {
    statusMock.mockResolvedValue({ ok: true, cli: { authenticated: false }, web: { status: 'none' } })
    await useAccountAuthStore.getState().refresh('profile-b')
    const rec = useAccountAuthStore.getState().byProfile['profile-b']
    expect(rec.cliAuthed).toBe(false)
    expect(rec.web).toBe('none')
  })

  it('dedupes concurrent refreshes for the same profile — one fetch, not two', async () => {
    let resolve!: (v: unknown) => void
    statusMock.mockReturnValue(new Promise((r) => { resolve = r }))
    const p1 = useAccountAuthStore.getState().refresh('profile-c')
    const p2 = useAccountAuthStore.getState().refresh('profile-c') // should be a no-op
    resolve({ ok: true, cli: { authenticated: true }, web: { status: 'expired' } })
    await Promise.all([p1, p2])
    expect(statusMock).toHaveBeenCalledTimes(1)
    expect(useAccountAuthStore.getState().byProfile['profile-c'].web).toBe('expired')
  })

  it('a forced refresh runs again once the first settles (dedupe is per-flight, not permanent)', async () => {
    statusMock.mockResolvedValue({ ok: true, cli: { authenticated: true }, web: { status: 'active' } })
    await useAccountAuthStore.getState().refresh('profile-d')
    await useAccountAuthStore.getState().refresh('profile-d', { force: true })
    expect(statusMock).toHaveBeenCalledTimes(2)
  })

  it('an AUTO refresh within the freshness window reuses the last SUCCESSFUL read (heavy CLI probe is not re-run)', async () => {
    statusMock.mockResolvedValue({ ok: true, cli: { authenticated: true }, web: { status: 'active' } })
    await useAccountAuthStore.getState().refresh('profile-ttl')   // probes once
    await useAccountAuthStore.getState().refresh('profile-ttl')   // within TTL → skipped
    await useAccountAuthStore.getState().refresh('profile-ttl')   // still within TTL → skipped
    expect(statusMock).toHaveBeenCalledTimes(1)
  })

  it('force re-probes even inside the freshness window (the manual pill refresh)', async () => {
    statusMock.mockResolvedValue({ ok: true, cli: { authenticated: true }, web: { status: 'active' } })
    await useAccountAuthStore.getState().refresh('profile-force')
    await useAccountAuthStore.getState().refresh('profile-force', { force: true })
    expect(statusMock).toHaveBeenCalledTimes(2)
  })

  it('a FAILED read is not fresh — the next auto refresh retries it', async () => {
    statusMock.mockResolvedValueOnce({ ok: false, error: 'boom' })
    statusMock.mockResolvedValue({ ok: true, cli: { authenticated: true }, web: { status: 'active' } })
    await useAccountAuthStore.getState().refresh('profile-retry')  // error
    await useAccountAuthStore.getState().refresh('profile-retry')  // auto, but error ⇒ not fresh ⇒ retries
    expect(statusMock).toHaveBeenCalledTimes(2)
    expect(useAccountAuthStore.getState().byProfile['profile-retry'].web).toBe('active')
  })

  it('an empty error string still yields a definite failed status, never a stuck pending', async () => {
    statusMock.mockResolvedValue({ ok: false, error: '' })
    await useAccountAuthStore.getState().refresh('profile-empty')
    const rec = useAccountAuthStore.getState().byProfile['profile-empty']
    expect(rec.loading).toBe(false)
    expect(rec.error).toBe('status failed')  // not '' — otherwise the pill sticks on '…'
  })

  it('records the error and clears loading when the status call is not ok', async () => {
    statusMock.mockResolvedValue({ ok: false, error: 'boom' })
    await useAccountAuthStore.getState().refresh('profile-e')
    const rec = useAccountAuthStore.getState().byProfile['profile-e']
    expect(rec.loading).toBe(false)
    expect(rec.error).toBe('boom')
  })

  it('ignores an empty profile id (no fetch)', async () => {
    await useAccountAuthStore.getState().refresh('')
    expect(statusMock).not.toHaveBeenCalled()
  })

  it('clear() drops a profile record', async () => {
    statusMock.mockResolvedValue({ ok: true, cli: { authenticated: true }, web: { status: 'active' } })
    await useAccountAuthStore.getState().refresh('profile-f')
    useAccountAuthStore.getState().clear('profile-f')
    expect(useAccountAuthStore.getState().byProfile['profile-f']).toBeUndefined()
  })
})
