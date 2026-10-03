// [host] WP2 PR 4, the shared scaffold (S0; completion plan 9.3 item 1).
//
// S0 lands the channel names, the preload bridges and their types, and the
// defaults every PR 4 lane builds on, before any lane starts; the handlers
// come with the phases. This pins what S0 promises the lanes:
//  - each new channel's exact string, and that every channel stays unique;
//  - each new preload bridge invokes or subscribes exactly its own channel
//    constant, passes the caller's argument through unchanged, and a push
//    forwards only the payload;
//  - the existing bridges a phase widens pass the new `provider` field
//    through untouched (P4.5's dispatch, P4.7's run);
//  - Ask Conductor's provider setting defaults to Claude Code (OD27 M4);
//  - the web-session id classes: an account profile id or a provider
//    account id, never both and nothing else (P4.6).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { IPC } from '../../src/shared/ipc-channels'
import { DEFAULT_SETTINGS } from '../../src/renderer/stores/settingsStore'
import { askConductorProviderChoice } from '../../src/shared/ask-conductor-provider'
import { webSessionIdClass, isWebSessionAccountId, PROFILE_ID_RE } from '../../src/shared/account-web-session'

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
const api = el.exposed.electronAPI as any

/** Fire `payload` at every listener of `channel`, as main's send would (event first). */
const deliver = (channel: string, payload: unknown) => { for (const fn of el.listeners.get(channel) ?? []) fn({ sender: 'main' }, payload) }

beforeEach(() => {
  el.ipcRenderer.on.mockClear()
  el.ipcRenderer.removeListener.mockClear()
  el.ipcRenderer.invoke.mockClear()
  el.listeners.clear()
})

describe('S0 channel names', () => {
  it('pins each new channel string (renames are breaking: the bridges and the d.ts hang off them)', () => {
    const ipc = IPC as unknown as Record<string, string>
    expect(ipc.ASK_CONDUCTOR_HAND_OFF).toBe('askConductor:handOff')
    expect(ipc.ASK_CONDUCTOR_NOTICE).toBe('askConductor:notice')
    expect(ipc.CANVAS_AGENT_MARKER_UNDELIVERED).toBe('canvas:agentMarkerUndelivered')
    expect(ipc.CANVAS_SESSION_GUIDANCE).toBe('canvas:sessionGuidance')
    expect(ipc.DEBUG_ACCOUNT_LOG_FOLDERS).toBe('debug:accountLogFolders')
    expect(ipc.DEBUG_OPEN_ACCOUNT_LOG_FOLDER).toBe('debug:openAccountLogFolder')
  })

  it('keeps every channel value unique', () => {
    const values = Object.values(IPC)
    expect(new Set(values).size).toBe(values.length)
  })
})

describe('S0 preload bridges map to their own channel constants', () => {
  it('invoke bridges call exactly their channel with the argument unchanged', async () => {
    const ipc = IPC as unknown as Record<string, string>
    const cases: Array<[() => Promise<unknown>, string, unknown[]]> = [
      [() => api.askConductor.handOff({ sessionId: 's1', question: 'why?' }), ipc.ASK_CONDUCTOR_HAND_OFF, [{ sessionId: 's1', question: 'why?' }]],
      [() => api.canvas.sessionGuidance({ sessionId: 's1' }), ipc.CANVAS_SESSION_GUIDANCE, [{ sessionId: 's1' }]],
      [() => api.debug.accountLogFolders(), ipc.DEBUG_ACCOUNT_LOG_FOLDERS, []],
      [() => api.debug.openAccountLogFolder({ accountId: 'acct-0123456789abcdef', folder: 'log' }), ipc.DEBUG_OPEN_ACCOUNT_LOG_FOLDER, [{ accountId: 'acct-0123456789abcdef', folder: 'log' }]],
    ]
    for (const [call, channel, args] of cases) {
      expect(channel, 'the channel constant exists').toEqual(expect.any(String))
      el.ipcRenderer.invoke.mockClear()
      await call()
      expect(el.ipcRenderer.invoke).toHaveBeenCalledTimes(1)
      expect(el.ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...args)
    }
  })

  it('push bridges subscribe exactly their channel, forward only the payload, and dispose what they added', () => {
    const ipc = IPC as unknown as Record<string, string>
    const cases: Array<[(cb: (x: unknown) => void) => () => void, string]> = [
      [(cb) => api.askConductor.onNotice(cb), ipc.ASK_CONDUCTOR_NOTICE],
      [(cb) => api.canvas.onAgentMarkerUndelivered(cb), ipc.CANVAS_AGENT_MARKER_UNDELIVERED],
    ]
    for (const [subscribe, channel] of cases) {
      expect(channel, 'the channel constant exists').toEqual(expect.any(String))
      el.ipcRenderer.on.mockClear()
      el.ipcRenderer.removeListener.mockClear()
      const cb = vi.fn()
      const off = subscribe(cb)
      expect(el.ipcRenderer.on).toHaveBeenCalledTimes(1)
      expect(el.ipcRenderer.on).toHaveBeenCalledWith(channel, expect.any(Function))
      const payload = { sessionId: 's1' }
      deliver(channel, payload)
      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb.mock.calls[0]).toHaveLength(1)
      expect(cb.mock.calls[0][0]).toBe(payload)
      const [, registered] = el.ipcRenderer.on.mock.calls[0]
      off()
      expect(el.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, registered)
      deliver(channel, payload)
      expect(cb).toHaveBeenCalledTimes(1)
    }
  })

  it('the widened bridges pass the provider through unchanged (P4.5 dispatch, P4.7 run)', async () => {
    const params = { name: 'n', description: 'd', projectPath: 'C:/p', provider: 'claude' as const }
    await api.cloudAgent.dispatch(params)
    expect(el.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.CLOUD_AGENT_DISPATCH, params)
    const opts = { profileId: 'profile-a', provider: 'claude' as const }
    await api.insights.run(opts)
    expect(el.ipcRenderer.invoke).toHaveBeenLastCalledWith(IPC.INSIGHTS_RUN, opts)
  })
})

describe('S0 defaults', () => {
  it('Ask Conductor runs on Claude Code by default (OD27 M4, option B)', () => {
    expect((DEFAULT_SETTINGS as unknown as Record<string, unknown>).askConductorProvider).toBe('claude')
    expect(askConductorProviderChoice(DEFAULT_SETTINGS)).toBe('claude')
  })
})

describe('S0 web-session id classes (P4.6)', () => {
  const ACCOUNT = 'acct-0123456789abcdef'
  it('names an account profile id or a provider account id, and nothing else', () => {
    expect(webSessionIdClass('profile-abc123')).toBe('profile')
    expect(webSessionIdClass(ACCOUNT)).toBe('account')
    expect(webSessionIdClass('acct-' + 'a'.repeat(64))).toBe('account')
    for (const bad of ['', 'acct-0123', 'acct-0123456789ABCDEF', 'acct-' + 'a'.repeat(65), 'realm-0123456789abcdef', 'idn-0123456789abcdef', 'profile-', 'Profile-abc', ' acct-0123456789abcdef', 'acct-0123456789abcdef\n', '../acct-0123456789abcdef', 7, null, undefined, {}]) {
      expect(webSessionIdClass(bad), JSON.stringify(bad)).toBeNull()
    }
  })
  it('the two classes never overlap, and the account check agrees with the classifier', () => {
    expect(PROFILE_ID_RE.test(ACCOUNT)).toBe(false)
    expect(isWebSessionAccountId(ACCOUNT)).toBe(true)
    expect(isWebSessionAccountId('profile-abc123')).toBe(false)
    expect(isWebSessionAccountId('acct-xyz')).toBe(false)
  })
})
