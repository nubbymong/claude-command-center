import { describe, it, expect } from 'vitest'
import { FakeChildTransport } from '../../../src/main/services/service-transport'

describe('FakeChildTransport', () => {
  it('delivers posted messages to the registered handler', () => {
    const t = new FakeChildTransport()
    const got: unknown[] = []
    t.onChild((m) => got.push(m))
    t.post({ type: 'register', sid: 's1', secret: 'x' })
    expect(got).toEqual([{ type: 'register', sid: 's1', secret: 'x' }])
  })
  it('captures the opposite direction via emitToParent for assertions', () => {
    const t = new FakeChildTransport()
    t.emitToParent({ type: 'bound', port: 19430, pid: 1 })
    expect(t.parentMessages).toEqual([{ type: 'bound', port: 19430, pid: 1 }])
  })
})
