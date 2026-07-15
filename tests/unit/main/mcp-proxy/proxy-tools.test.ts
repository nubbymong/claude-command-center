import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  registerProxyTools,
  jsonSchemaToZodShape,
  jsonSchemaToZodType,
  type ProxyToolDeps,
} from '../../../../src/main/mcp-proxy/proxy-tools'
import { ProxyDispatchError, type AggregatedTool, type UpstreamRuntimeState } from '../../../../src/main/mcp-proxy/supervisor'

function fakeServer() {
  const tools = new Map<string, { description: string; shape: any; handler: (a?: any) => any }>()
  return {
    tools,
    tool(name: string, description: string, shape: any, handler: (a?: any) => any) {
      tools.set(name, { description, shape, handler })
    },
    sendToolListChanged: vi.fn(),
    invoke(name: string, args?: any) {
      return tools.get(name)!.handler(args)
    },
  }
}

async function parse(result: any) {
  return { json: JSON.parse(result.content[0].text), isError: !!result.isError }
}

const TOOLS: AggregatedTool[] = [
  { upstreamId: 'u1', upstreamName: 'Filesystem', tool: { name: 'read_file', description: 'Read a file from disk', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'path' } }, required: ['path'] } } },
  { upstreamId: 'u2', upstreamName: 'GitHub', tool: { name: 'create_issue', description: 'Open an issue' } },
]
const STATE: UpstreamRuntimeState[] = [
  { id: 'u1', name: 'Filesystem', status: 'online', exposure: 'search', toolCount: 1 },
  { id: 'u2', name: 'GitHub', status: 'online', exposure: 'search', toolCount: 1 },
]

function deps(over: Partial<ProxyToolDeps> = {}): ProxyToolDeps {
  return {
    getTools: () => TOOLS,
    getState: () => STATE,
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'upstream-ok' }] })),
    ...over,
  }
}

describe('meta-tool registration', () => {
  it('registers exactly the four search meta-tools when no upstream is passthrough', () => {
    const s = fakeServer()
    registerProxyTools(s, z, deps())
    expect([...s.tools.keys()].sort()).toEqual(['call_tool', 'describe_tool', 'list_servers', 'search_tools'])
  })
})

describe('search_tools', () => {
  it('returns ranked rows', async () => {
    const s = fakeServer()
    registerProxyTools(s, z, deps())
    const { json } = await parse(await s.invoke('search_tools', { query: 'read file' }))
    expect(json.results[0].name).toBe('filesystem__read_file')
  })

  it('returns a hint when nothing matches', async () => {
    const s = fakeServer()
    registerProxyTools(s, z, deps())
    const { json } = await parse(await s.invoke('search_tools', { query: 'kubernetes' }))
    expect(json.results).toEqual([])
    expect(json.hint).toBeTruthy()
  })
})

describe('describe_tool', () => {
  it('returns the full input schema', async () => {
    const s = fakeServer()
    registerProxyTools(s, z, deps())
    const { json } = await parse(await s.invoke('describe_tool', { name: 'filesystem__read_file' }))
    expect(json.inputSchema.properties.path).toBeTruthy()
  })

  it('errors for an unknown name', async () => {
    const s = fakeServer()
    registerProxyTools(s, z, deps())
    const res = await s.invoke('describe_tool', { name: 'nope__x' })
    expect(res.isError).toBe(true)
  })
})

describe('call_tool', () => {
  it('resolves the namespaced name and routes to the upstream', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }] }))
    const s = fakeServer()
    registerProxyTools(s, z, deps({ callTool }))
    const res = await s.invoke('call_tool', { name: 'filesystem__read_file', arguments: { path: '/x' } })
    expect(callTool).toHaveBeenCalledWith('u1', 'read_file', { path: '/x' })
    expect(res.content[0].text).toBe('done')
  })

  it('errors on an unknown tool name (before dispatch)', async () => {
    const callTool = vi.fn()
    const s = fakeServer()
    registerProxyTools(s, z, deps({ callTool }))
    const res = await s.invoke('call_tool', { name: 'ghost__tool' })
    expect(res.isError).toBe(true)
    expect(callTool).not.toHaveBeenCalled()
  })

  it('maps a TOOL_NOT_FOUND race to a re-search hint, not a hard error', async () => {
    const callTool = vi.fn(async () => {
      throw new ProxyDispatchError('TOOL_NOT_FOUND', 'Tool read_file is no longer offered by Filesystem')
    })
    const s = fakeServer()
    registerProxyTools(s, z, deps({ callTool }))
    const res = await s.invoke('call_tool', { name: 'filesystem__read_file' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toContain('search_tools')
  })

  it('wraps a non-content upstream result as JSON text', async () => {
    const callTool = vi.fn(async () => ({ raw: 42 }))
    const s = fakeServer()
    registerProxyTools(s, z, deps({ callTool }))
    const res = await s.invoke('call_tool', { name: 'github__create_issue' })
    expect(JSON.parse(res.content[0].text)).toEqual({ raw: 42 })
  })
})

describe('list_servers', () => {
  it('reports status + exposure per server', async () => {
    const s = fakeServer()
    registerProxyTools(s, z, deps())
    const { json } = await parse(await s.invoke('list_servers'))
    expect(json.servers).toHaveLength(2)
    expect(json.servers[0]).toMatchObject({ name: 'Filesystem', status: 'online', exposure: 'search' })
  })
})

describe('passthrough', () => {
  it('registers server__tool directly for passthrough upstreams and routes calls', async () => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'pt' }] }))
    const state: UpstreamRuntimeState[] = [
      { id: 'u1', name: 'Filesystem', status: 'online', exposure: 'passthrough', toolCount: 1 },
      { id: 'u2', name: 'GitHub', status: 'online', exposure: 'search', toolCount: 1 },
    ]
    const s = fakeServer()
    registerProxyTools(s, z, deps({ callTool, getState: () => state }))
    // Filesystem is passthrough -> its tool is advertised directly; GitHub is not.
    expect(s.tools.has('filesystem__read_file')).toBe(true)
    expect(s.tools.has('github__create_issue')).toBe(false)
    const res = await s.invoke('filesystem__read_file', { path: '/y' })
    expect(callTool).toHaveBeenCalledWith('u1', 'read_file', { path: '/y' })
    expect(res.content[0].text).toBe('pt')
  })
})

describe('onChanged hot-reload wiring', () => {
  it('subscribes and calls sendToolListChanged; cleanup unsubscribes', () => {
    let cb: (() => void) | null = null
    const unsub = vi.fn()
    const onChanged = vi.fn((fn: () => void) => {
      cb = fn
      return unsub
    })
    const s = fakeServer()
    const cleanup = registerProxyTools(s, z, deps({ onChanged }))
    expect(onChanged).toHaveBeenCalled()
    cb!()
    expect(s.sendToolListChanged).toHaveBeenCalled()
    cleanup()
    expect(unsub).toHaveBeenCalled()
  })
})

describe('jsonSchemaToZod (passthrough conversion)', () => {
  it('builds a shape honoring required/optional and descriptions', () => {
    const shape = jsonSchemaToZodShape(
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'the path' },
          limit: { type: 'number' },
        },
        required: ['path'],
      },
      z,
    )
    const obj = z.object(shape)
    expect(obj.safeParse({ path: '/a' }).success).toBe(true) // limit optional
    expect(obj.safeParse({ limit: 3 }).success).toBe(false) // path required
  })

  it('maps primitive/array/enum types and falls back to any', () => {
    expect(jsonSchemaToZodType({ type: 'boolean' }, z).safeParse(true).success).toBe(true)
    expect(jsonSchemaToZodType({ type: 'array', items: { type: 'string' } }, z).safeParse(['a']).success).toBe(true)
    expect(jsonSchemaToZodType({ enum: ['a', 'b'] }, z).safeParse('a').success).toBe(true)
    expect(jsonSchemaToZodType({ enum: ['a', 'b'] }, z).safeParse('c').success).toBe(false)
    expect(jsonSchemaToZodType({ type: 'weird' }, z).safeParse({ anything: 1 }).success).toBe(true) // z.any()
  })

  it('returns an empty shape for a schema without properties', () => {
    expect(jsonSchemaToZodShape(undefined, z)).toEqual({})
    expect(jsonSchemaToZodShape({ type: 'object' }, z)).toEqual({})
  })
})
