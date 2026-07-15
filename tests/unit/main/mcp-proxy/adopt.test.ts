import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../../src/main/debug-logger', () => ({
  logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn(),
}))

const listUpstreams = vi.fn(() => [] as any[])
const addUpstream = vi.fn((input: any) => ({ id: 'new', ...input }))
vi.mock('../../../../src/main/mcp-proxy/upstream-registry', () => ({
  listUpstreams: () => listUpstreams(),
  addUpstream: (input: any) => addUpstream(input),
}))

let backupStore: any = null
const readConfig = vi.fn(() => backupStore)
const saveConfig = vi.fn((_k: string, v: any) => { backupStore = v; return true })
vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: (...a: any[]) => readConfig(...(a as [])),
  saveConfig: (...a: any[]) => saveConfig(...(a as [string, any])),
}))

const {
  parseMcpServersObject,
  parseCodexMcpServers,
  removeServersFromObject,
  discoverAll,
  importDiscovered,
  takeOver,
  claudeJsonPath,
} = await import('../../../../src/main/mcp-proxy/adopt')

beforeEach(() => {
  listUpstreams.mockReturnValue([])
  addUpstream.mockClear()
  readConfig.mockClear()
  saveConfig.mockClear()
  backupStore = null
})

describe('parseMcpServersObject', () => {
  it('maps stdio and http/sse entries; skips invalid', () => {
    const out = parseMcpServersObject({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', 'server-fs', '/tmp'], env: { TOKEN: 'x', N: 5 } },
        remote: { type: 'sse', url: 'http://h/sse', headers: { Authorization: 'Bearer t' } },
        streamable: { type: 'streamable-http', url: 'http://h/mcp' },
        broken: { nonsense: true },
      },
    })
    expect(out).toEqual([
      { name: 'fs', transport: { kind: 'stdio', command: 'npx', args: ['-y', 'server-fs', '/tmp'], env: { TOKEN: 'x' } } },
      { name: 'remote', transport: { kind: 'sse', url: 'http://h/sse', headers: { Authorization: 'Bearer t' } } },
      { name: 'streamable', transport: { kind: 'http', url: 'http://h/mcp' } },
    ])
  })

  it('returns [] for objects without mcpServers', () => {
    expect(parseMcpServersObject({})).toEqual([])
    expect(parseMcpServersObject(null)).toEqual([])
  })
})

describe('parseCodexMcpServers', () => {
  it('reads [mcp_servers.NAME] command/args and url tables', () => {
    const toml = [
      '[mcp_servers.fs]',
      'command = "npx"',
      'args = ["-y", "server-fs"]',
      '',
      '[mcp_servers.web]',
      'url = "http://h/mcp"',
      '',
      '[other.section]',
      'command = "ignored"',
    ].join('\n')
    const out = parseCodexMcpServers(toml)
    expect(out).toEqual([
      { name: 'fs', transport: { kind: 'stdio', command: 'npx', args: ['-y', 'server-fs'] } },
      { name: 'web', transport: { kind: 'http', url: 'http://h/mcp' } },
    ])
  })
})

describe('removeServersFromObject', () => {
  it('removes named servers and reports the removed entries without mutating input', () => {
    const orig = { mcpServers: { a: { command: 'x' }, b: { command: 'y' } }, other: 1 }
    const { next, removed } = removeServersFromObject(orig, ['a'])
    expect(Object.keys((next.mcpServers as any))).toEqual(['b'])
    expect(removed).toEqual({ a: { command: 'x' } })
    expect(Object.keys((orig.mcpServers as any))).toEqual(['a', 'b']) // untouched
  })
})

describe('discoverAll (injected IO)', () => {
  it('collects across sources and flags existing entries', () => {
    listUpstreams.mockReturnValue([
      { id: 'e1', name: 'fs', transport: { kind: 'stdio', command: 'npx', args: ['-y', 'server-fs'] }, enabled: true, exposure: 'search', autostart: false },
    ])
    const io = {
      read: (p: string) => {
        if (p === claudeJsonPath()) return JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] }, gh: { command: 'gh-mcp' } } })
        return null
      },
      write: () => true,
      exists: () => true,
    }
    const found = discoverAll(io)
    const fs = found.find((f) => f.input.name === 'fs')!
    const gh = found.find((f) => f.input.name === 'gh')!
    expect(fs.existing).toBe(true)
    expect(gh.existing).toBe(false)
    expect(fs.source).toBe('claude')
  })

  it('skips a source whose JSON is malformed (never throws)', () => {
    const io = { read: (p: string) => (p === claudeJsonPath() ? '{ not json' : null), write: () => true, exists: () => true }
    expect(discoverAll(io)).toEqual([])
  })
})

describe('importDiscovered', () => {
  it('adds only non-existing entries', () => {
    const items = [
      { source: 'claude' as const, existing: true, input: { name: 'fs', transport: { kind: 'stdio' as const, command: 'x' } } },
      { source: 'claude' as const, existing: false, input: { name: 'gh', transport: { kind: 'stdio' as const, command: 'gh' } } },
    ]
    const added = importDiscovered(items)
    expect(added).toBe(1)
    expect(addUpstream).toHaveBeenCalledTimes(1)
    expect(addUpstream).toHaveBeenCalledWith(items[1].input)
  })
})

describe('takeOver', () => {
  it('strips servers from the client file and backs up removed entries', () => {
    let written: string | null = null
    const io = {
      read: () => JSON.stringify({ mcpServers: { fs: { command: 'x' }, gh: { command: 'y' } } }),
      write: (_p: string, c: string) => { written = c; return true },
      exists: () => true,
    }
    const res = takeOver('claude', ['fs'], io)
    expect(res).toEqual({ ok: true, removed: 1 })
    expect(JSON.parse(written!).mcpServers).toEqual({ gh: { command: 'y' } })
    expect(saveConfig).toHaveBeenCalledWith('mcpAdoptBackup', { claude: { fs: { command: 'x' } } })
  })

  it('fails closed on malformed JSON — never writes', () => {
    let wrote = false
    const io = { read: () => '{ broken', write: () => { wrote = true; return true }, exists: () => true }
    const res = takeOver('claude', ['fs'], io)
    expect(res.ok).toBe(false)
    expect(wrote).toBe(false)
  })

  it('reports zero removed when the name is absent', () => {
    const io = { read: () => JSON.stringify({ mcpServers: { gh: { command: 'y' } } }), write: () => true, exists: () => true }
    expect(takeOver('claude', ['fs'], io)).toEqual({ ok: true, removed: 0 })
  })
})
