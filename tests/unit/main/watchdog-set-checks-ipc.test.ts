// #605: watchdog:setChecks is the one renderer-reachable lever over whether the
// watchdog types into a PTY, so its payload is validated field by field. These
// assert the handler drops anything it is not sure about rather than coercing
// it, and that an unknown session is a no-op. Same shape as the canvas IPC
// suite: a fake ipcMain captures the handler, the manager is mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: () => {},
  },
}))

const managerMock = vi.hoisted(() => ({
  setSessionChecks: vi.fn(),
  getStates: vi.fn(() => []),
}))

vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({
  getWatchdogManager: () => managerMock,
}))

const { registerWatchdogHandlers } = await import('../../../src/main/ipc/watchdog-handlers')

function invoke(sessionId: unknown, checks: unknown): unknown {
  const fn = handlers.get(IPC.WATCHDOG_SET_CHECKS)
  if (!fn) throw new Error('watchdog:setChecks was never registered')
  return fn({}, sessionId, checks)
}

beforeEach(() => {
  handlers.clear()
  vi.clearAllMocks()
  managerMock.setSessionChecks.mockReturnValue(true)
  registerWatchdogHandlers()
})

describe('#605 watchdog:setChecks payload validation', () => {
  it('passes through the three known boolean fields', () => {
    expect(invoke('s1', { rateLimit: false, overload: true, safeguard: false })).toBe(true)
    expect(managerMock.setSessionChecks).toHaveBeenCalledWith('s1', {
      rateLimit: false, overload: true, safeguard: false,
    })
  })

  it('accepts a partial payload — one check at a time is the normal case', () => {
    invoke('s1', { overload: false })
    expect(managerMock.setSessionChecks).toHaveBeenCalledWith('s1', { overload: false })
  })

  it('drops unknown keys rather than forwarding them', () => {
    invoke('s1', { overload: false, enabled: true, __proto__: { x: 1 }, send: 'continue' })
    expect(managerMock.setSessionChecks).toHaveBeenCalledWith('s1', { overload: false })
  })

  it('drops non-boolean values rather than coercing them', () => {
    invoke('s1', { rateLimit: 'true', overload: 1, safeguard: null })
    expect(managerMock.setSessionChecks, 'nothing survived, so nothing is applied').not.toHaveBeenCalled()
  })

  it('refuses a non-object payload', () => {
    for (const bad of [null, undefined, 'overload', 42, ['overload'], true]) {
      expect(invoke('s1', bad)).toBe(false)
    }
    expect(managerMock.setSessionChecks).not.toHaveBeenCalled()
  })

  it('refuses a missing or non-string session id', () => {
    for (const bad of [undefined, null, '', 42, {}]) {
      expect(invoke(bad, { overload: false })).toBe(false)
    }
    expect(managerMock.setSessionChecks).not.toHaveBeenCalled()
  })

  it('reports false when the session has no armed watcher', () => {
    managerMock.setSessionChecks.mockReturnValue(false)
    expect(invoke('not-watched', { overload: false })).toBe(false)
  })
})
