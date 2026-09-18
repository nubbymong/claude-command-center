// The onChannel helper (2.1.1 refactor) replaced 48 hand-written
// ipcRenderer.on subscriptions in the preload. Nothing exercised a converted
// site (re-attack finding), so this pins the helper's contract through a real
// exposed method: it forwards ONLY the payload (never the IpcRendererEvent),
// and the disposer removes exactly the listener it added, nothing else.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC, ptyDataChannel, ptyExitChannel } from '../../src/shared/ipc-channels'

const el = vi.hoisted(() => {
  const exposed: Record<string, any> = {}
  const listeners = new Map<string, Array<(...a: any[]) => void>>()
  const ipcRenderer = {
    on: vi.fn((ch: string, fn: (...a: any[]) => void) => { listeners.set(ch, [...(listeners.get(ch) ?? []), fn]) }),
    removeListener: vi.fn((ch: string, fn: (...a: any[]) => void) => { listeners.set(ch, (listeners.get(ch) ?? []).filter((f) => f !== fn)) }),
    invoke: vi.fn(async () => undefined),
    send: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    sendSync: vi.fn(),
  }
  return { exposed, listeners, ipcRenderer }
})
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { el.exposed[name] = api } },
  ipcRenderer: el.ipcRenderer,
}))

await import('../../src/preload/index')
const api = el.exposed.electronAPI as {
  window: { onMaximizedChanged: (cb: (maximized: boolean) => void) => () => void }
  pty: {
    onData: (sessionId: string, cb: (data: string) => void) => () => void
    onExit: (sessionId: string, cb: (exitCode: number) => void) => () => void
  }
}
const CH = IPC.WINDOW_MAXIMIZED_CHANGED

/** Fire `payload` at every listener of `channel`, as main's send would (event first). */
const deliver = (channel: string, payload: unknown) => { for (const fn of el.listeners.get(channel) ?? []) fn({ sender: 'main' }, payload) }

beforeEach(() => {
  el.ipcRenderer.on.mockClear()
  el.ipcRenderer.removeListener.mockClear()
  el.listeners.clear()
})

describe('preload onChannel (pinned through window.onMaximizedChanged)', () => {
  it('subscribes the named channel and forwards ONLY the payload to the callback', () => {
    const cb = vi.fn()
    api.window.onMaximizedChanged(cb)
    expect(el.ipcRenderer.on).toHaveBeenCalledTimes(1)
    expect(el.ipcRenderer.on).toHaveBeenCalledWith(CH, expect.any(Function))
    deliver(CH, true)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(true)
    // one argument -- the payload, never the IpcRendererEvent
    expect(cb.mock.calls[0]).toHaveLength(1)
    // ...and the very object main sent, not a copy of it.
    const obj = { marker: 1 }
    deliver(CH, obj)
    expect(cb.mock.calls[1][0]).toBe(obj)
  })

  it('the disposer removes exactly the listener it added, and a later delivery reaches nothing', () => {
    const cb = vi.fn()
    const off = api.window.onMaximizedChanged(cb)
    const [, registered] = el.ipcRenderer.on.mock.calls[0]
    off()
    expect(el.ipcRenderer.removeListener).toHaveBeenCalledTimes(1)
    expect(el.ipcRenderer.removeListener).toHaveBeenCalledWith(CH, registered)
    expect(el.listeners.get(CH)).toEqual([])
    deliver(CH, false)
    expect(cb).not.toHaveBeenCalled()
  })

  it('two subscribers on one channel are independent: disposing one leaves the other live', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = api.window.onMaximizedChanged(a)
    api.window.onMaximizedChanged(b)
    // both live: one delivery reaches each of them exactly once (a helper that
    // routed everything to the most recent subscriber would pass without this)
    deliver(CH, false)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    offA()
    deliver(CH, true)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenLastCalledWith(true)
  })
})

// Final adversarial pass on 2.1.1: the static-channel case above let three
// mutants through -- a per-session (dynamic) channel subscribed on the wrong
// channel, a disposer that unsubscribed a different channel than it subscribed,
// and a third top-level bridge key. One case each.
describe('preload bridge -- dynamic channels and the exposed surface', () => {
  it('exposes exactly two top-level keys: electronAPI and electronPlatform', () => {
    // A third key (say, the preload `process` object) would be a new renderer
    // capability with no type, no test and no review.
    expect(Object.keys(el.exposed).sort()).toEqual(['electronAPI', 'electronPlatform'])
    expect(typeof el.exposed.electronPlatform).toBe('string')
  })

  it('pty.onData subscribes the per-session DATA channel and its disposer unsubscribes that same channel', () => {
    const cb = vi.fn()
    const off = api.pty.onData('sess-7', cb)
    const data = ptyDataChannel('sess-7')
    expect(el.ipcRenderer.on).toHaveBeenCalledTimes(1)
    expect(el.ipcRenderer.on).toHaveBeenCalledWith(data, expect.any(Function))
    deliver(data, 'chunk')
    expect(cb).toHaveBeenCalledWith('chunk')
    // another session's data, and this session's exit, reach nothing here
    deliver(ptyDataChannel('sess-8'), 'other')
    deliver(ptyExitChannel('sess-7'), 0)
    expect(cb).toHaveBeenCalledTimes(1)
    const [, registered] = el.ipcRenderer.on.mock.calls[0]
    off()
    expect(el.ipcRenderer.removeListener).toHaveBeenCalledTimes(1)
    expect(el.ipcRenderer.removeListener).toHaveBeenCalledWith(data, registered)
    expect(el.listeners.get(data)).toEqual([])
    deliver(data, 'late')
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('pty.onExit subscribes the per-session EXIT channel, not the data channel', () => {
    const cb = vi.fn()
    api.pty.onExit('sess-9', cb)
    expect(el.ipcRenderer.on).toHaveBeenCalledWith(ptyExitChannel('sess-9'), expect.any(Function))
    deliver(ptyDataChannel('sess-9'), 'chunk')
    expect(cb).not.toHaveBeenCalled()
    deliver(ptyExitChannel('sess-9'), 3)
    expect(cb).toHaveBeenCalledWith(3)
  })
})
