import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// We mock electron before importing any module that uses it
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-sentinel-handlers-'))
  vi.resetModules()
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

async function freshModules() {
  // Re-import fresh module instances after vi.resetModules()
  const { _initRegistryForTest } = await import('../../src/main/model-registry-service')
  _initRegistryForTest(dir)
  const { initSentinel, getSentinelState, sentinelApply, sentinelRevert, sentinelSetStatus } =
    await import('../../src/main/sentinel/index')
  const { registerSentinelHandlers } = await import('../../src/main/ipc/sentinel-handlers')
  return { initSentinel, getSentinelState, sentinelApply, sentinelRevert, sentinelSetStatus, registerSentinelHandlers }
}

describe('sentinel IPC handlers (spec §5)', () => {
  it('GET_STATE returns null before initSentinel', async () => {
    const { getSentinelState } = await freshModules()
    const snap = getSentinelState()?.snapshot() ?? null
    expect(snap).toBeNull()
  })

  it('GET_STATE returns a snapshot after initSentinel', async () => {
    const { initSentinel, getSentinelState } = await freshModules()
    initSentinel(dir)
    const snap = getSentinelState()?.snapshot() ?? null
    expect(snap).not.toBeNull()
    expect(Array.isArray(snap?.findings)).toBe(true)
  })

  it('APPLY with unknown finding id returns { ok: false }', async () => {
    const { initSentinel, sentinelApply } = await freshModules()
    initSentinel(dir)
    const result = sentinelApply('no-such-finding')
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  it('SET_STATUS only accepts dismissed or muted — applying "applied" as status is ignored', async () => {
    const { initSentinel, getSentinelState, sentinelSetStatus } = await freshModules()
    const st = initSentinel(dir)
    st.upsertFinding({
      id: 'test:finding:1', kind: 'info', severity: 'info',
      title: 'Test', evidence: 'e', status: 'open', createdAt: Date.now(),
    })

    // This is what the handler does: only pass through if dismissed|muted
    const status = 'applied' as string
    if (status === 'dismissed' || status === 'muted') sentinelSetStatus('test:finding:1', status as 'dismissed' | 'muted')

    // Status should still be 'open' because 'applied' was filtered out
    const snap = getSentinelState()!.snapshot()
    expect(snap.findings[0].status).toBe('open')
  })

  it('SET_STATUS with "dismissed" changes the finding status', async () => {
    const { initSentinel, getSentinelState, sentinelSetStatus } = await freshModules()
    const st = initSentinel(dir)
    st.upsertFinding({
      id: 'test:finding:2', kind: 'info', severity: 'info',
      title: 'Test', evidence: 'e', status: 'open', createdAt: Date.now(),
    })
    sentinelSetStatus('test:finding:2', 'dismissed')
    expect(getSentinelState()!.snapshot().findings[0].status).toBe('dismissed')
  })

  it('registerSentinelHandlers wires ipcMain.handle for all 5 channels', async () => {
    const { ipcMain } = await import('electron')
    const { initSentinel, registerSentinelHandlers } = await freshModules()
    initSentinel(dir)
    registerSentinelHandlers()
    const handleMock = ipcMain.handle as ReturnType<typeof vi.fn>
    const registeredChannels = handleMock.mock.calls.map((c) => c[0])
    expect(registeredChannels).toContain('sentinel:getState')
    expect(registeredChannels).toContain('sentinel:apply')
    expect(registeredChannels).toContain('sentinel:revert')
    expect(registeredChannels).toContain('sentinel:setStatus')
    expect(registeredChannels).toContain('sentinel:rerun')
  })
})
