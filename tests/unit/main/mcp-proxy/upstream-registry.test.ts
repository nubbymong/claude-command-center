import { describe, it, expect, beforeEach, vi } from 'vitest'

// In-memory config store backing the mocked config-manager.
let store: unknown = null
const mockReadConfig = vi.fn((_key: string) => store)
const mockSaveConfig = vi.fn((_key: string, value: unknown) => {
  store = value
  return true
})

vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: (...args: any[]) => mockReadConfig(...(args as [string])),
  saveConfig: (...args: any[]) => mockSaveConfig(...(args as [string, unknown])),
}))

vi.mock('../../../../src/main/debug-logger', () => ({
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
}))

const {
  normalizeTransport,
  normalizeUpstream,
  normalizeUpstreams,
  buildUpstream,
  addUpstream,
  getUpstream,
  listUpstreams,
  updateUpstream,
  removeUpstream,
} = await import('../../../../src/main/mcp-proxy/upstream-registry')

beforeEach(() => {
  store = null
  mockReadConfig.mockClear()
  mockSaveConfig.mockClear()
})

describe('normalizeTransport', () => {
  it('accepts a stdio transport and drops empty args/env', () => {
    expect(normalizeTransport({ kind: 'stdio', command: 'npx', args: [], env: {} })).toEqual({
      kind: 'stdio',
      command: 'npx',
    })
  })

  it('keeps non-empty args and string-only env', () => {
    expect(
      normalizeTransport({
        kind: 'stdio',
        command: 'node',
        args: ['server.js', 42, 'x'],
        env: { A: '1', B: 2 },
      }),
    ).toEqual({ kind: 'stdio', command: 'node', args: ['server.js', 'x'], env: { A: '1' } })
  })

  it('rejects stdio without a command', () => {
    expect(normalizeTransport({ kind: 'stdio', command: '   ' })).toBeNull()
    expect(normalizeTransport({ kind: 'stdio' })).toBeNull()
  })

  it('accepts http and sse transports with a url', () => {
    expect(normalizeTransport({ kind: 'http', url: 'http://x/mcp' })).toEqual({
      kind: 'http',
      url: 'http://x/mcp',
    })
    expect(
      normalizeTransport({ kind: 'sse', url: 'http://x/sse', headers: { Authorization: 'Bearer t' } }),
    ).toEqual({ kind: 'sse', url: 'http://x/sse', headers: { Authorization: 'Bearer t' } })
  })

  it('rejects http/sse without a url and unknown kinds', () => {
    expect(normalizeTransport({ kind: 'http' })).toBeNull()
    expect(normalizeTransport({ kind: 'websocket', url: 'ws://x' })).toBeNull()
    expect(normalizeTransport(null)).toBeNull()
  })
})

describe('normalizeUpstream', () => {
  const base = { id: 'u1', name: 'FS', transport: { kind: 'stdio', command: 'fs-mcp' } }

  it('fills defaults: enabled=true, exposure=search, autostart=false', () => {
    expect(normalizeUpstream(base)).toEqual({
      id: 'u1',
      name: 'FS',
      transport: { kind: 'stdio', command: 'fs-mcp' },
      enabled: true,
      exposure: 'search',
      autostart: false,
    })
  })

  it('honors explicit flags and a valid exposure', () => {
    const u = normalizeUpstream({ ...base, enabled: false, exposure: 'passthrough', autostart: true })
    expect(u).toMatchObject({ enabled: false, exposure: 'passthrough', autostart: true })
  })

  it('coerces an invalid exposure back to search', () => {
    expect(normalizeUpstream({ ...base, exposure: 'bogus' })?.exposure).toBe('search')
  })

  it('drops entries missing id, name, or a valid transport', () => {
    expect(normalizeUpstream({ ...base, id: '' })).toBeNull()
    expect(normalizeUpstream({ ...base, name: '' })).toBeNull()
    expect(normalizeUpstream({ ...base, transport: { kind: 'stdio' } })).toBeNull()
    expect(normalizeUpstream('nope')).toBeNull()
  })
})

describe('normalizeUpstreams', () => {
  it('returns [] for non-array input', () => {
    expect(normalizeUpstreams(null)).toEqual([])
    expect(normalizeUpstreams({})).toEqual([])
  })

  it('drops invalid and duplicate-id entries, keeps the first of a dup', () => {
    const raw = [
      { id: 'a', name: 'A', transport: { kind: 'stdio', command: 'a' } },
      { id: 'bad' }, // invalid
      { id: 'a', name: 'A2', transport: { kind: 'stdio', command: 'a2' } }, // dup id
      { id: 'b', name: 'B', transport: { kind: 'http', url: 'http://b' } },
    ]
    const out = normalizeUpstreams(raw)
    expect(out.map((u) => u.id)).toEqual(['a', 'b'])
    expect(out[0].name).toBe('A')
  })
})

describe('buildUpstream', () => {
  it('mints a uuid id and applies defaults', () => {
    const u = buildUpstream({ name: 'FS', transport: { kind: 'stdio', command: 'fs-mcp' } })
    expect(u.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(u).toMatchObject({ name: 'FS', enabled: true, exposure: 'search', autostart: false })
  })

  it('throws on an invalid transport or empty name', () => {
    expect(() => buildUpstream({ name: 'x', transport: { kind: 'stdio' } as any })).toThrow()
    expect(() =>
      buildUpstream({ name: '  ', transport: { kind: 'stdio', command: 'x' } }),
    ).toThrow()
  })
})

describe('CRUD round-trip', () => {
  it('add → list → get persists a clean entry', () => {
    const created = addUpstream({ name: 'FS', transport: { kind: 'stdio', command: 'fs-mcp' } })
    expect(created).not.toBeNull()
    expect(mockSaveConfig).toHaveBeenCalledWith('mcpUpstreams', expect.any(Array))
    expect(listUpstreams()).toHaveLength(1)
    expect(getUpstream(created!.id)).toEqual(created)
  })

  it('update merges a patch and preserves id + untouched fields', () => {
    const created = addUpstream({ name: 'FS', transport: { kind: 'stdio', command: 'fs-mcp' } })!
    const updated = updateUpstream(created.id, { exposure: 'passthrough', enabled: false })
    expect(updated).toMatchObject({ id: created.id, name: 'FS', exposure: 'passthrough', enabled: false })
    expect(getUpstream(created.id)?.exposure).toBe('passthrough')
  })

  it('update swaps the transport when a valid one is supplied, ignores an invalid one', () => {
    const created = addUpstream({ name: 'FS', transport: { kind: 'stdio', command: 'fs-mcp' } })!
    updateUpstream(created.id, { transport: { kind: 'http', url: 'http://x/mcp' } })
    expect(getUpstream(created.id)?.transport).toEqual({ kind: 'http', url: 'http://x/mcp' })
    updateUpstream(created.id, { transport: { kind: 'stdio' } as any })
    expect(getUpstream(created.id)?.transport).toEqual({ kind: 'http', url: 'http://x/mcp' })
  })

  it('update returns null for an unknown id', () => {
    expect(updateUpstream('missing', { name: 'x' })).toBeNull()
  })

  it('remove deletes by id and reports absence', () => {
    const created = addUpstream({ name: 'FS', transport: { kind: 'stdio', command: 'fs-mcp' } })!
    expect(removeUpstream(created.id)).toBe(true)
    expect(listUpstreams()).toHaveLength(0)
    expect(removeUpstream(created.id)).toBe(false)
  })
})
