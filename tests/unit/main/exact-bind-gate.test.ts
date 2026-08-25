import { describe, it, expect, beforeEach, vi } from 'vitest'

// #480: `isExactBindSourceActive()` gates the (cross-prone) heuristic resume
// fallback. It keys ONLY on the `hooksEnabled` setting — NOT the live
// gateway.listening flag, which blips false during gateway startup / crash-
// backoff / manual restart. Keying on the transient flag would unlock the
// fallback in the DEFAULT (hooks-on) config during those windows and let two
// same-repo cards cross (adversarial round 2, MAJOR). These tests pin that.

const readConfigSpy = vi.fn<(key: string) => unknown>()
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => readConfigSpy(key),
}))

import { isExactBindSourceActive, setGateway } from '../../../src/main/hooks'
import type { HooksGatewayLike } from '../../../src/main/hooks'
import type { HooksGatewayStatus } from '../../../src/shared/hook-types'

function fakeGateway(status: HooksGatewayStatus): HooksGatewayLike {
  return {
    registerSession: () => '',
    unregisterSession: () => {},
    getBuffer: () => [],
    status: () => status,
    start: async () => status,
    stop: async () => {},
    setPermissionGateActive: () => {},
    subscribe: () => () => {},
  } as unknown as HooksGatewayLike
}

describe('#480 gate: isExactBindSourceActive()', () => {
  beforeEach(() => {
    readConfigSpy.mockReset()
  })

  it('defaults TRUE when the settings file is absent (config null)', () => {
    readConfigSpy.mockReturnValue(null)
    expect(isExactBindSourceActive()).toBe(true)
  })

  it('defaults TRUE when the key is absent from an existing settings object', () => {
    readConfigSpy.mockReturnValue({ somethingElse: 1 })
    expect(isExactBindSourceActive()).toBe(true)
  })

  it('stays TRUE with hooks enabled even while the gateway is NOT listening (no race unlock)', () => {
    readConfigSpy.mockReturnValue({ hooksEnabled: true })
    // Transient states the supervisor/proxy legitimately produce with hooks ON.
    setGateway(fakeGateway({ enabled: true, listening: false, port: null }))
    expect(isExactBindSourceActive()).toBe(true) // exact source WILL arrive once it settles
  })

  it('stays TRUE with hooks enabled even when the gateway singleton is null (pre-init)', () => {
    readConfigSpy.mockReturnValue({ hooksEnabled: true })
    // @ts-expect-error deliberately clear the singleton to model pre-init
    setGateway(null)
    expect(isExactBindSourceActive()).toBe(true)
  })

  it('is FALSE only when the user disabled hooks (the intended fallback case)', () => {
    readConfigSpy.mockReturnValue({ hooksEnabled: false })
    setGateway(fakeGateway({ enabled: true, listening: true, port: 5 }))
    expect(isExactBindSourceActive()).toBe(false)
  })

  it('propagates a readConfig throw — consumers wrap it and fail safe', () => {
    readConfigSpy.mockImplementation(() => { throw new Error('no resources dir') })
    expect(() => isExactBindSourceActive()).toThrow()
  })
})
