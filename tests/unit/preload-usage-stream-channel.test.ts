// The preload half of the streaming usage IPC (plan P3), pinned on the real
// preload module with `electron` mocked (adversarial pass on #598: this was the
// one guarantee in the stream's design nothing asserted). Each call subscribes a
// PRIVATE per-call reply channel BEFORE it invokes main, names that channel to
// main, delivers only what arrives on it to its own callback, and removes the
// listener when the invoke settles -- resolved or rejected -- so overlapping
// calls never cross-talk and nothing leaks.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const el = vi.hoisted(() => {
  const exposed: Record<string, any> = {}
  const listeners = new Map<string, Array<(...a: any[]) => void>>()
  let invokeImpl: (channel: string, arg: any) => Promise<unknown> = async () => undefined
  const ipcRenderer = {
    on: vi.fn((ch: string, fn: (...a: any[]) => void) => { listeners.set(ch, [...(listeners.get(ch) ?? []), fn]) }),
    removeListener: vi.fn((ch: string, fn: (...a: any[]) => void) => { listeners.set(ch, (listeners.get(ch) ?? []).filter((f) => f !== fn)) }),
    invoke: vi.fn((ch: string, arg: any) => invokeImpl(ch, arg)),
    send: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    sendSync: vi.fn(),
  }
  return { exposed, listeners, ipcRenderer, setInvoke: (fn: typeof invokeImpl) => { invokeImpl = fn } }
})
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => { el.exposed[name] = api } },
  ipcRenderer: el.ipcRenderer,
}))

await import('../../src/preload/index')
const api = el.exposed.electronAPI as { accountUsage: { fetchAllStream: (cb: (u: { profileId: string }) => void) => Promise<void> } }

/** Fire `payload` at every listener of `channel`, as main's send would. */
const deliver = (channel: string, payload: unknown) => { for (const fn of el.listeners.get(channel) ?? []) fn({}, payload) }

beforeEach(() => {
  el.ipcRenderer.on.mockClear()
  el.ipcRenderer.removeListener.mockClear()
  el.ipcRenderer.invoke.mockClear()
  el.listeners.clear()
  el.setInvoke(async () => undefined)
})

describe('preload accountUsage.fetchAllStream', () => {
  it('subscribes a private per-call channel BEFORE the invoke, and names that channel to main', async () => {
    let named: any
    el.setInvoke(async (_ch, arg) => { named = arg })
    await api.accountUsage.fetchAllStream(() => {})
    expect(named.channel).toMatch(/^accountUsage:result:\S{8,}$/)
    expect(el.ipcRenderer.on).toHaveBeenCalledWith(named.channel, expect.any(Function))
    expect(el.ipcRenderer.on.mock.invocationCallOrder[0]).toBeLessThan(el.ipcRenderer.invoke.mock.invocationCallOrder[0])
  })

  it('REGRESSION: two overlapping calls use two different channels, each delivering only to its own callback', async () => {
    const named: string[] = []
    const releases: Array<() => void> = []
    el.setInvoke((_ch, arg) => { named.push(arg.channel); return new Promise<void>((r) => { releases.push(r) }) })
    const a: string[] = []
    const b: string[] = []
    const pa = api.accountUsage.fetchAllStream((u) => a.push(u.profileId))
    const pb = api.accountUsage.fetchAllStream((u) => b.push(u.profileId))
    expect(named).toHaveLength(2)
    expect(named[0]).not.toBe(named[1])
    deliver(named[0], { profileId: 'for-a' })
    deliver(named[1], { profileId: 'for-b' })
    expect(a).toEqual(['for-a'])
    expect(b).toEqual(['for-b'])
    for (const r of releases) r()
    await Promise.all([pa, pb])
  })

  it('removes exactly the listener it added once the invoke resolves', async () => {
    await api.accountUsage.fetchAllStream(() => {})
    expect(el.ipcRenderer.removeListener).toHaveBeenCalledTimes(1)
    const [channel, fn] = el.ipcRenderer.removeListener.mock.calls[0]
    expect(el.ipcRenderer.on).toHaveBeenCalledWith(channel, fn)
    expect(el.listeners.get(channel)).toEqual([])
  })

  it('removes the listener when the invoke REJECTS too, and a late delivery reaches no callback', async () => {
    const cb = vi.fn()
    let named = ''
    el.setInvoke(async (_ch, arg) => { named = arg.channel; throw new Error('main refused') })
    await expect(api.accountUsage.fetchAllStream(cb)).rejects.toThrow('main refused')
    expect(el.ipcRenderer.removeListener).toHaveBeenCalledTimes(1)
    deliver(named, { profileId: 'late' })
    expect(cb).not.toHaveBeenCalled()
  })
})
