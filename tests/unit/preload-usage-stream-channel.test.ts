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

// Usage track MP8 round 2 (VM, V1): main sends a stream's items with
// webContents.send and its result as the invoke reply, and Electron does not
// order the two routes against each other. On the VM 3 of 20 Codex usage
// streams (8 of 10 offline) replied `accounts: 1` and delivered no view: the
// listener had been removed when the reply arrived, before the view did. The
// preload now keeps listening until main's end marker, which main sends last
// on the same channel, arrives.
describe('a stream is over only when its end marker arrives (MP8 round 2)', () => {
  const END = { __ipcStreamEnd: true }
  type Api = {
    accountUsage: { fetchAllStream: (cb: (u: { profileId: string }) => void) => Promise<void> }
    providerAccounts: { usageStream: (p: string, cb: (v: { accountId: string }) => void, o?: { read?: boolean }) => Promise<unknown>; usageOne: (id: string, o?: { read?: boolean }) => Promise<unknown> }
  }
  const full = el.exposed.electronAPI as Api
  const streams: Array<[string, (cb: (x: any) => void) => Promise<unknown>, (arg: any) => unknown, object]> = [
    ['Claude Code', (cb) => full.accountUsage.fetchAllStream(cb), () => ({ ok: true }), { profileId: 'p1' }],
    ['Codex', (cb) => full.providerAccounts.usageStream('codex', cb), () => ({ ok: true, provider: 'on', accounts: 1 }), { accountId: 'a1' }],
  ]

  for (const [name, start, reply, item] of streams) {
    it(`${name}: REGRESSION (VM): an item that arrives after the reply is still delivered, and the promise waits for it`, async () => {
      let named = ''
      // Main's reply first, its sends a moment later (the order the VM saw).
      el.setInvoke(async (_ch, arg) => {
        named = arg.channel
        setTimeout(() => { deliver(named, item); deliver(named, END) }, 5)
        return reply(arg)
      })
      const got: unknown[] = []
      let settled = false
      const p = start((x) => got.push(x)).then((r) => { settled = true; return r })
      await new Promise((r) => setTimeout(r, 1))
      expect(settled).toBe(false)
      await p
      expect(got).toEqual([item])
      expect(el.listeners.get(named)).toEqual([])
    })

    it(`${name}: an end marker before the reply ends it at the reply; nothing after the marker reaches the callback`, async () => {
      let named = ''
      el.setInvoke(async (_ch, arg) => { named = arg.channel; deliver(named, item); deliver(named, END); deliver(named, item); return reply(arg) })
      const got: unknown[] = []
      await start((x) => got.push(x))
      expect(got).toEqual([item])
      expect(el.listeners.get(named)).toEqual([])
    })

    it(`${name}: a reply that says the stream did not run ends it at once`, async () => {
      let named = ''
      el.setInvoke(async (_ch, arg) => { named = arg.channel; return name === 'Codex' ? { ok: false, code: 'unsupported' } : undefined })
      let settled = false
      void start(() => {}).then(() => { settled = true })
      // At once: no wait for a marker that will not come.
      await new Promise((r) => setTimeout(r, 50))
      expect(settled).toBe(true)
      expect(el.listeners.get(named)).toEqual([])
    })

    it(`${name}: a lost end marker stops listening after the wait, not never`, async () => {
      vi.useFakeTimers()
      try {
        let named = ''
        el.setInvoke(async (_ch, arg) => { named = arg.channel; return reply(arg) })
        let settled = false
        const p = start(() => {}).then(() => { settled = true })
        await vi.advanceTimersByTimeAsync(4_999)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(2)
        await p
        expect(el.listeners.get(named)).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })
  }

  it('the Codex stream and a card\'s Retry ask to read only when told to', async () => {
    const args: any[] = []
    el.setInvoke(async (ch, arg) => { args.push([ch, arg]); if (arg?.channel) deliver(arg.channel, END); return { ok: true, provider: 'on', accounts: 0 } })
    await full.providerAccounts.usageStream('codex', () => {}, { read: true })
    await full.providerAccounts.usageStream('codex', () => {})
    await full.providerAccounts.usageOne('acct-1', { read: true })
    await full.providerAccounts.usageOne('acct-1')
    expect(args.map(([, a]) => a.read)).toEqual([true, undefined, true, undefined])
    expect(args[3][1]).toEqual({ accountId: 'acct-1' })
  })
})
