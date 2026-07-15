// @vitest-environment jsdom
/**
 * T5 (#97): useMcpProxyStore drives the Proxy sub-tool. Verifies it reads the
 * merged view from IPC, applies mutation responses, and accepts pushed updates.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { McpUpstreamView } from '../../../src/shared/types'

const api = {
  list: vi.fn(),
  add: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  onChanged: vi.fn(() => () => {}),
}
;(globalThis as any).window = (globalThis as any).window ?? {}
;(globalThis as any).window.electronAPI = { mcpProxy: api }

const { useMcpProxyStore } = await import('../../../src/renderer/stores/mcpProxyStore')

function view(over: Partial<McpUpstreamView> = {}): McpUpstreamView {
  return {
    id: 'u1',
    name: 'FS',
    transport: { kind: 'stdio', command: 'fs-mcp' },
    enabled: true,
    exposure: 'search',
    autostart: true,
    status: 'offline',
    toolCount: 0,
    ...over,
  }
}

beforeEach(() => {
  Object.values(api).forEach((f) => (f as any).mockReset?.())
  api.onChanged.mockReturnValue(() => {})
  useMcpProxyStore.setState({ upstreams: [], loading: false, error: null })
})

describe('load', () => {
  it('populates upstreams from IPC', async () => {
    api.list.mockResolvedValue([view()])
    await useMcpProxyStore.getState().load()
    expect(useMcpProxyStore.getState().upstreams).toHaveLength(1)
    expect(useMcpProxyStore.getState().loading).toBe(false)
  })

  it('records an error when the IPC throws', async () => {
    api.list.mockRejectedValue(new Error('boom'))
    await useMcpProxyStore.getState().load()
    expect(useMcpProxyStore.getState().error).toBe('boom')
  })
})

describe('add', () => {
  it('applies the returned view and reports success', async () => {
    api.add.mockResolvedValue({ ok: true, upstreams: [view({ status: 'online', toolCount: 3 })] })
    const ok = await useMcpProxyStore.getState().add({
      name: 'FS',
      transport: { kind: 'stdio', command: 'fs-mcp' },
      enabled: true,
      exposure: 'search',
      autostart: true,
    })
    expect(ok).toBe(true)
    expect(useMcpProxyStore.getState().upstreams[0].toolCount).toBe(3)
  })

  it('surfaces an error and returns false on failure', async () => {
    api.add.mockResolvedValue({ ok: false, error: 'bad transport' })
    const ok = await useMcpProxyStore.getState().add({
      name: '',
      transport: { kind: 'stdio', command: '' },
      enabled: true,
      exposure: 'search',
      autostart: false,
    })
    expect(ok).toBe(false)
    expect(useMcpProxyStore.getState().error).toBe('bad transport')
  })
})

describe('start/stop/remove apply returned views', () => {
  it('start applies the view', async () => {
    api.start.mockResolvedValue({ ok: true, upstreams: [view({ status: 'online' })] })
    await useMcpProxyStore.getState().start('u1')
    expect(useMcpProxyStore.getState().upstreams[0].status).toBe('online')
  })

  it('remove applies the (empty) view', async () => {
    useMcpProxyStore.setState({ upstreams: [view()] })
    api.remove.mockResolvedValue({ ok: true, upstreams: [] })
    await useMcpProxyStore.getState().remove('u1')
    expect(useMcpProxyStore.getState().upstreams).toHaveLength(0)
  })
})

describe('handleChanged (push)', () => {
  it('replaces upstreams from a main-process broadcast', () => {
    useMcpProxyStore.getState().handleChanged([view({ status: 'online', toolCount: 5 })])
    expect(useMcpProxyStore.getState().upstreams[0].toolCount).toBe(5)
  })
})
