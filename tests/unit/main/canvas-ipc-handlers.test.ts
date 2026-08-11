// canvas IPC — registration, Zod rejection before the store is touched,
// happy-path delegation, and the change-push forwarder (logs2 suite pattern).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const listeners = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => listeners.set(ch, fn),
  },
  BrowserWindow: vi.fn(),
}))

const storeMock = vi.hoisted(() => ({
  getCanvasStateForSession: vi.fn(),
  renderVersion: vi.fn(),
  setActiveVersion: vi.fn(),
  changeListeners: [] as Array<(e: unknown) => void>,
}))

vi.mock('../../../src/main/canvas/canvas-store', () => ({
  getCanvasStateForSession: storeMock.getCanvasStateForSession,
  renderVersion: storeMock.renderVersion,
  setActiveVersion: storeMock.setActiveVersion,
  onCanvasChanged: (cb: (e: unknown) => void) => {
    storeMock.changeListeners.push(cb)
    return () => {}
  },
}))

const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')
const { requestCanvasSnapshot, _resetSnapshotBrokerForTest } = await import('../../../src/main/canvas/canvas-snapshot-broker')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const invoke = (ch: string, args: unknown) => handlers.get(ch)!({} as never, args)

let sent: Array<{ channel: string; payload: unknown }>
let destroyed: boolean

beforeEach(() => {
  handlers.clear()
  listeners.clear()
  _resetSnapshotBrokerForTest()
  storeMock.changeListeners.length = 0
  vi.clearAllMocks()
  sent = []
  destroyed = false
  const fakeWindow = {
    isDestroyed: () => destroyed,
    webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
  }
  registerCanvasHandlers(() => fakeWindow as never)
})

describe('registration', () => {
  it('registers all three request channels', () => {
    expect(handlers.has(IPC.CANVAS_GET_STATE)).toBe(true)
    expect(handlers.has(IPC.CANVAS_RENDER)).toBe(true)
    expect(handlers.has(IPC.CANVAS_SET_ACTIVE_VERSION)).toBe(true)
  })

  it('listens for snapshot replies from the renderer', () => {
    expect(listeners.has(IPC.CANVAS_SNAPSHOT_RESULT)).toBe(true)
  })
})

describe('snapshot capture (main -> renderer request)', () => {
  it('pushes the request to the window and resolves on the matching reply', async () => {
    const pending = requestCanvasSnapshot({ sessionId: SID, canvasId: 'c1', versionId: 'v1', options: {} })
    const pushed = sent.find((s) => s.channel === IPC.CANVAS_SNAPSHOT_REQUEST)
    expect(pushed).toBeDefined()
    const { requestId } = pushed!.payload as { requestId: string }
    expect(requestId).toMatch(/^[0-9a-f]{24}$/)

    listeners.get(IPC.CANVAS_SNAPSHOT_RESULT)!({} as never, {
      requestId,
      ok: true,
      result: { viewport: { width: 800, height: 600, dpr: 1 }, root: { ref: 'e0', role: 'document', name: 'ok', box: {}, children: [] } },
    })
    await expect(pending).resolves.toMatchObject({ root: { name: 'ok' } })
  })

  it('reports no window rather than hanging when it is gone', async () => {
    destroyed = true
    await expect(
      requestCanvasSnapshot({ sessionId: SID, canvasId: 'c1', versionId: 'v1', options: {} }),
    ).rejects.toThrow(/window is not available/)
  })
})

describe('validation — bad args REJECT before the store is ever called', () => {
  it.each([
    [IPC.CANVAS_GET_STATE, {}],
    [IPC.CANVAS_GET_STATE, { sessionId: '../evil' }],
    [IPC.CANVAS_GET_STATE, { sessionId: SID, extra: 1 }],
    [IPC.CANVAS_RENDER, { sessionId: SID }],
    [IPC.CANVAS_RENDER, { sessionId: SID, source: { mode: 'plan' } }],
    [IPC.CANVAS_RENDER, { sessionId: SID, source: { mode: 'design', html: '' } }],
    [IPC.CANVAS_RENDER, { sessionId: SID, source: { mode: 'design', html: 'x', sneak: true } }],
    [IPC.CANVAS_RENDER, { sessionId: SID, source: { mode: 'uat' } }],
    [IPC.CANVAS_SET_ACTIVE_VERSION, { sessionId: SID, versionId: 'nope' }],
    [IPC.CANVAS_SET_ACTIVE_VERSION, { sessionId: SID, versionId: 'v1x' }],
  ])('%s rejects %j', async (channel, args) => {
    await expect(invoke(channel as string, args)).rejects.toThrow()
    expect(storeMock.getCanvasStateForSession).not.toHaveBeenCalled()
    expect(storeMock.renderVersion).not.toHaveBeenCalled()
    expect(storeMock.setActiveVersion).not.toHaveBeenCalled()
  })
})

describe('happy paths delegate to the store', () => {
  it('getState', async () => {
    storeMock.getCanvasStateForSession.mockReturnValue(null)
    expect(await invoke(IPC.CANVAS_GET_STATE, { sessionId: SID })).toBeNull()
    expect(storeMock.getCanvasStateForSession).toHaveBeenCalledWith(SID)
  })

  it('render (design + uat shapes)', async () => {
    storeMock.renderVersion.mockReturnValue({ canvasId: 'c', versionId: 'v1' })
    await invoke(IPC.CANVAS_RENDER, { sessionId: SID, source: { mode: 'design', html: '<p>x</p>' } })
    expect(storeMock.renderVersion).toHaveBeenCalledWith(SID, { mode: 'design', html: '<p>x</p>' })
    await invoke(IPC.CANVAS_RENDER, { sessionId: SID, source: { mode: 'uat', distRoot: 'F:/x/dist', entry: 'index.html' } })
    expect(storeMock.renderVersion).toHaveBeenCalledWith(SID, { mode: 'uat', distRoot: 'F:/x/dist', entry: 'index.html' })
  })

  it('setActiveVersion', async () => {
    storeMock.setActiveVersion.mockReturnValue({ activeVersionId: 'v1' })
    await invoke(IPC.CANVAS_SET_ACTIVE_VERSION, { sessionId: SID, versionId: 'v1' })
    expect(storeMock.setActiveVersion).toHaveBeenCalledWith(SID, 'v1')
  })
})

describe('change push', () => {
  it('forwards store change events to the window', () => {
    const event = { sessionId: SID, canvasId: 'c', activeVersionId: 'v2' }
    storeMock.changeListeners.forEach((cb) => cb(event))
    expect(sent).toEqual([{ channel: IPC.CANVAS_CHANGED, payload: event }])
  })

  it('does not throw when the window is gone', () => {
    destroyed = true
    expect(() => storeMock.changeListeners.forEach((cb) => cb({ sessionId: SID }))).not.toThrow()
    expect(sent).toEqual([])
  })
})
