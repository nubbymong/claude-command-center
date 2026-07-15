import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { McpUpstream } from '../../../../src/shared/types'

vi.mock('../../../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}))

// The supervisor imports the registry + internal-events at module load; stub
// both so no real config/electron is touched. loadUpstreams is injected per
// test via deps, so the registry mock just needs to exist.
vi.mock('../../../../src/main/mcp-proxy/upstream-registry', () => ({ listUpstreams: () => [] }))

const {
  McpProxySupervisor,
  ProxyDispatchError,
} = await import('../../../../src/main/mcp-proxy/supervisor')

type Hooks = { onToolsChanged: () => void; onClosed: (e?: Error) => void }

/** A scriptable fake upstream connection. */
class FakeConn {
  hooks: Hooks | null = null
  closed = false
  connectError: Error | null = null
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
  callResult: unknown = { content: [{ type: 'text', text: 'ok' }] }
  callSpy = vi.fn()

  constructor(tools: FakeConn['tools'] = [{ name: 'do_thing', description: 'does a thing' }]) {
    this.tools = tools
  }
  async connect(hooks: Hooks) {
    if (this.connectError) throw this.connectError
    this.hooks = hooks
  }
  async listTools() {
    return this.tools
  }
  async callTool(name: string, args: Record<string, unknown> | undefined) {
    this.callSpy(name, args)
    return this.callResult
  }
  async close() {
    this.closed = true
  }
}

function up(partial: Partial<McpUpstream> & { id: string }): McpUpstream {
  return {
    id: partial.id,
    name: partial.name ?? partial.id,
    transport: partial.transport ?? { kind: 'stdio', command: 'x' },
    enabled: partial.enabled ?? true,
    exposure: partial.exposure ?? 'search',
    autostart: partial.autostart ?? false,
  }
}

function makeSup(upstreams: McpUpstream[], conns: Map<string, FakeConn>) {
  const changed: string[] = []
  const sup = new McpProxySupervisor({
    loadUpstreams: () => upstreams,
    connectionFactory: (u) => {
      const c = conns.get(u.id) ?? new FakeConn()
      conns.set(u.id, c)
      return c
    },
    emitChanged: (r) => changed.push(r),
  })
  return { sup, changed }
}

let conns: Map<string, FakeConn>
beforeEach(() => {
  conns = new Map()
})

describe('sync', () => {
  it('adds registry entries as offline without connecting', () => {
    const { sup } = makeSup([up({ id: 'a' })], conns)
    sup.sync()
    expect(sup.getState()).toEqual([
      { id: 'a', name: 'a', status: 'offline', exposure: 'search', toolCount: 0, lastError: undefined },
    ])
    expect(conns.size).toBe(0)
  })

  it('drops entries removed from the registry', () => {
    const list = [up({ id: 'a' }), up({ id: 'b' })]
    const { sup } = makeSup(list, conns)
    sup.sync()
    list.splice(1, 1) // remove b
    sup.sync()
    expect(sup.getState().map((s) => s.id)).toEqual(['a'])
  })
})

describe('start / startUpstream', () => {
  it('connects only enabled autostart upstreams and caches their tools', async () => {
    const list = [
      up({ id: 'a', autostart: true }),
      up({ id: 'b', autostart: false }),
      up({ id: 'c', autostart: true, enabled: false }),
    ]
    const { sup } = makeSup(list, conns)
    await sup.start()
    const byId = Object.fromEntries(sup.getState().map((s) => [s.id, s.status]))
    expect(byId).toEqual({ a: 'online', b: 'offline', c: 'offline' })
    expect(sup.getTools().map((t) => t.tool.name)).toEqual(['do_thing'])
  })

  it('marks an upstream error (not thrown) when connect fails', async () => {
    const bad = new FakeConn()
    bad.connectError = new Error('spawn ENOENT')
    conns.set('a', bad)
    const { sup } = makeSup([up({ id: 'a', autostart: true })], conns)
    await sup.start()
    const s = sup.getState()[0]
    expect(s.status).toBe('error')
    expect(s.lastError).toContain('ENOENT')
    expect(bad.closed).toBe(true)
    expect(sup.getTools()).toEqual([])
  })

  it('startUpstream is idempotent when already online', async () => {
    const { sup } = makeSup([up({ id: 'a' })], conns)
    sup.sync()
    await sup.startUpstream('a')
    await sup.startUpstream('a')
    expect(sup.getState()[0].status).toBe('online')
  })
})

describe('tools/list_changed', () => {
  it('re-lists tools when the upstream notifies', async () => {
    const { sup } = makeSup([up({ id: 'a' })], conns)
    sup.sync()
    await sup.startUpstream('a')
    const conn = conns.get('a')!
    conn.tools = [{ name: 'do_thing' }, { name: 'new_tool' }]
    conn.hooks!.onToolsChanged()
    await new Promise((r) => setImmediate(r)) // let the async refresh settle
    expect(sup.getTools().map((t) => t.tool.name)).toEqual(['do_thing', 'new_tool'])
  })
})

describe('connection close', () => {
  it('marks offline and clears tools when the transport closes', async () => {
    const { sup } = makeSup([up({ id: 'a' })], conns)
    sup.sync()
    await sup.startUpstream('a')
    conns.get('a')!.hooks!.onClosed()
    expect(sup.getState()[0].status).toBe('offline')
    expect(sup.getTools()).toEqual([])
  })

  it('marks error when the transport closes with an error', async () => {
    const { sup } = makeSup([up({ id: 'a' })], conns)
    sup.sync()
    await sup.startUpstream('a')
    conns.get('a')!.hooks!.onClosed(new Error('broken pipe'))
    expect(sup.getState()[0].status).toBe('error')
    expect(sup.getState()[0].lastError).toBe('broken pipe')
  })
})

describe('callTool routing', () => {
  it('routes to the owning upstream connection', async () => {
    const { sup } = makeSup([up({ id: 'a' })], conns)
    sup.sync()
    await sup.startUpstream('a')
    const res = await sup.callTool('a', 'do_thing', { x: 1 })
    expect(conns.get('a')!.callSpy).toHaveBeenCalledWith('do_thing', { x: 1 })
    expect(res).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('throws UPSTREAM_NOT_FOUND for an unknown upstream', async () => {
    const { sup } = makeSup([], conns)
    sup.sync()
    await expect(sup.callTool('nope', 'x', {})).rejects.toMatchObject({ code: 'UPSTREAM_NOT_FOUND' })
  })

  it('throws UPSTREAM_OFFLINE when not connected', async () => {
    const { sup } = makeSup([up({ id: 'a' })], conns)
    sup.sync()
    await expect(sup.callTool('a', 'do_thing', {})).rejects.toMatchObject({ code: 'UPSTREAM_OFFLINE' })
  })

  it('throws TOOL_NOT_FOUND for the list->call race (tool vanished)', async () => {
    const { sup } = makeSup([up({ id: 'a' })], conns)
    sup.sync()
    await sup.startUpstream('a')
    await expect(sup.callTool('a', 'ghost_tool', {})).rejects.toMatchObject({ code: 'TOOL_NOT_FOUND' })
    expect(ProxyDispatchError).toBeTypeOf('function')
  })
})

describe('stopUpstream / stopAll', () => {
  it('closes the connection and goes offline', async () => {
    const { sup } = makeSup([up({ id: 'a' })], conns)
    sup.sync()
    await sup.startUpstream('a')
    await sup.stopUpstream('a')
    expect(conns.get('a')!.closed).toBe(true)
    expect(sup.getState()[0].status).toBe('offline')
  })
})
