import { describe, it, expect, vi } from 'vitest'
import { HooksGateway } from '../../../src/main/hooks/hooks-gateway'

describe('HooksGateway seams', () => {
  it('uses an injected responder registry instead of the module import', () => {
    const register = vi.fn(); const deregister = vi.fn()
    const gw = new HooksGateway({ emit: () => {}, permissionResponders: { register, deregister } })
    expect(gw.permissionRegister).toBe(register)
    expect(gw.permissionDeregister).toBe(deregister)
  })

  it('defaults the responder registry to the module functions (in-process behavior unchanged)', () => {
    const gw = new HooksGateway({ emit: () => {} })
    expect(typeof gw.permissionRegister).toBe('function')
    expect(typeof gw.permissionDeregister).toBe('function')
  })

  it('registerSessionWithSecret stores a caller-supplied secret; hasSecret reflects it', () => {
    const gw = new HooksGateway({ emit: () => {} })
    expect(gw.hasSecret('s1')).toBe(false)
    gw.registerSessionWithSecret('s1', 'sekret')
    expect(gw.hasSecret('s1')).toBe(true)
  })

  it('metrics().eventsTotal increments on a real ingest', async () => {
    const gw = new HooksGateway({ emit: () => {} })
    const secret = gw.registerSession('s1')
    await gw._handleRequestForTest({
      remoteAddress: '127.0.0.1',
      url: '/hook/s1',
      headers: { 'x-ccc-hook-token': secret },
      body: JSON.stringify({ hook_event_name: 'PostToolUse', tool_name: 'Glob' }),
    })
    expect(gw.metrics().eventsTotal).toBe(1)
    expect(gw.metrics().dropsTotal).toBe(0)
  })
})
