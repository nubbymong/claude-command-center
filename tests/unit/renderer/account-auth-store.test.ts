// @vitest-environment jsdom
// The shared per-account auth store behind the session-header pills + the sidebar
// context menu. Covers the status mapping, the per-profile dedupe (the CLI probe
// is heavy, so a second concurrent refresh must not fire a second fetch), and the
// error path.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAccountAuthStore, _resetAccountAuthForTest } from '../../../src/renderer/stores/accountAuthStore'

let statusMock: ReturnType<typeof vi.fn>
let webStatusMock: ReturnType<typeof vi.fn>
beforeEach(() => {
  _resetAccountAuthForTest()
  statusMock = vi.fn()
  webStatusMock = vi.fn()
  ;(globalThis as any).window.electronAPI = { accountWeb: { status: statusMock, webStatus: webStatusMock } }
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

describe('accountAuthStore.refreshWeb', () => {
  // The renderer half of the "Open artifacts was dead on a cold account" fix.
  // `accountWeb:status` cannot answer "does this account have a claude.ai
  // session" without first awaiting the `claude auth status` subprocess, so the
  // context menu rendered its item disabled for seconds and a click in that
  // window did nothing at all. `refreshWeb` asks the cheap question on its own.
  //
  // Added after mutation testing showed three separate ways to revert the whole
  // fix with the full suite still green.

  it('asks webStatus and NEVER the slow combined status', async () => {
    webStatusMock.mockResolvedValue({ ok: true, web: { status: 'active' } })
    await useAccountAuthStore.getState().refreshWeb('profile-a')
    expect(webStatusMock).toHaveBeenCalledWith('profile-a')
    // The point of the split. Calling `status` here reintroduces the subprocess
    // wait that made the menu item dead.
    expect(statusMock).not.toHaveBeenCalled()
    expect(useAccountAuthStore.getState().byProfile['profile-a'].web).toBe('active')
  })

  it('merges into the existing record instead of replacing it', async () => {
    statusMock.mockResolvedValue({ ok: true, cli: { authenticated: true }, web: { status: 'none' } })
    await useAccountAuthStore.getState().refresh('profile-b')
    const before = useAccountAuthStore.getState().byProfile['profile-b']

    webStatusMock.mockResolvedValue({ ok: true, web: { status: 'active' } })
    await useAccountAuthStore.getState().refreshWeb('profile-b')
    const after = useAccountAuthStore.getState().byProfile['profile-b']

    expect(after.web).toBe('active')
    // cliAuthed belongs to the full probe and must survive the cheap one, or the
    // session-header pill goes blank every time a context menu opens.
    expect(after.cliAuthed).toBe(true)
    expect(after.fetchedAt).toBe(before.fetchedAt)
  })

  it('does NOT stamp fetchedAt', async () => {
    // fetchedAt means "the CLI probe succeeded at this time" and drives the 30s
    // AUTO_REFRESH_TTL_MS. Stamping it here would make a right-click suppress
    // the next real probe, so cliAuthed would go stale invisibly.
    webStatusMock.mockResolvedValue({ ok: true, web: { status: 'active' } })
    await useAccountAuthStore.getState().refreshWeb('profile-c')
    expect(useAccountAuthStore.getState().byProfile['profile-c'].fetchedAt).toBeUndefined()
  })

  it('leaves a cached status alone when the read fails', async () => {
    statusMock.mockResolvedValue({ ok: true, cli: { authenticated: true }, web: { status: 'active' } })
    await useAccountAuthStore.getState().refresh('profile-d')

    webStatusMock.mockRejectedValue(new Error('IPC gone'))
    await useAccountAuthStore.getState().refreshWeb('profile-d')
    // A failed cheap read is not evidence the session is gone. Downgrading to
    // 'none' here would disable the menu item on a working account -- the exact
    // bug this fix exists to remove.
    expect(useAccountAuthStore.getState().byProfile['profile-d'].web).toBe('active')
  })

  it('leaves a cached status alone when the handler returns ok:false', async () => {
    statusMock.mockResolvedValue({ ok: true, cli: { authenticated: true }, web: { status: 'active' } })
    await useAccountAuthStore.getState().refresh('profile-e')

    webStatusMock.mockResolvedValue({ ok: false, error: 'bad profile id' })
    await useAccountAuthStore.getState().refreshWeb('profile-e')
    expect(useAccountAuthStore.getState().byProfile['profile-e'].web).toBe('active')
  })


  it('is kicked off by refresh() too, so the fast answer does not depend on one call site', async () => {
    // The context-menu wiring calls refreshWeb directly, but that is one line in
    // a component and deleting it silently reintroduces the dead menu item. The
    // store starts the cheap read itself, so the web answer lands even if the
    // caller only asked for the full refresh.
    let releaseSlow!: (v: unknown) => void
    statusMock.mockReturnValue(new Promise((r) => { releaseSlow = r }))
    webStatusMock.mockResolvedValue({ ok: true, web: { status: 'active' } })

    const p = useAccountAuthStore.getState().refresh('profile-f')
    // Let the cheap read settle while the CLI probe is still outstanding.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    expect(webStatusMock).toHaveBeenCalledWith('profile-f')
    expect(useAccountAuthStore.getState().byProfile['profile-f'].web).toBe('active')

    releaseSlow({ ok: true, cli: { authenticated: true }, web: { status: 'active' } })
    await p
    expect(useAccountAuthStore.getState().byProfile['profile-f'].cliAuthed).toBe(true)
  })

  it('ignores an empty profile id rather than fetching', async () => {
    await useAccountAuthStore.getState().refreshWeb('')
    expect(webStatusMock).not.toHaveBeenCalled()
  })
})
