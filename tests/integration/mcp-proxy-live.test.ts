// @vitest-environment node
/**
 * LIVE end-to-end verification of the Conductor proxy (plan verification steps).
 *
 * Unlike the unit tests (which inject fakes), this exercises the REAL stack:
 *   - a real child-process MCP server over the real stdio transport
 *     (tests/fixtures/mcp-echo-server.mjs)
 *   - the real McpProxySupervisor default connection factory (spawns the child,
 *     speaks MCP, caches tools, routes calls)
 *   - the real ToolIndex (BM25) + registerProxyTools facade on a real McpServer
 *   - a real MCP Client over a real (in-memory) transport pair — i.e. exactly
 *     the path Claude Code takes: tools/list -> search_tools -> call_tool.
 *
 * Only the config/persistence + logging boundary is stubbed (no Electron here);
 * everything protocol-related is real.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { fileURLToPath } from 'node:url'

// Stub only the Electron-bound leaves. Registry is bypassed via injected deps.
vi.mock('../../src/main/config-manager', () => ({
  readConfig: () => null,
  saveConfig: () => true,
}))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {},
}))

const { McpProxySupervisor } = await import('../../src/main/mcp-proxy/supervisor')
const { registerProxyTools } = await import('../../src/main/mcp-proxy/proxy-tools')
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js')
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js')
const zod = await import('zod')
const z = (zod as any).z ?? zod

const fixture = fileURLToPath(new URL('../fixtures/mcp-echo-server.mjs', import.meta.url))
const upstream = {
  id: 'echo1',
  name: 'Echo',
  transport: { kind: 'stdio' as const, command: process.execPath, args: [fixture] },
  enabled: true,
  exposure: 'search' as const,
  autostart: true,
}

let sup: InstanceType<typeof McpProxySupervisor>

beforeAll(async () => {
  sup = new McpProxySupervisor({ loadUpstreams: () => [upstream], emitChanged: () => {} })
  await sup.start()
}, 30000)

afterAll(async () => {
  await sup?.stopAll()
})

describe('LIVE: supervisor <-> real stdio MCP upstream', () => {
  it('connects the child process and comes online', () => {
    const state = sup.getState()
    expect(state).toHaveLength(1)
    expect(state[0]).toMatchObject({ name: 'Echo', status: 'online' })
  })

  it('caches the upstream tool list via a real tools/list', () => {
    const names = sup.getTools().map((t) => t.tool.name).sort()
    expect(names).toEqual(['add', 'echo'])
  })

  it('routes a real tools/call to the child and returns its result', async () => {
    const res: any = await sup.callTool('echo1', 'add', { a: 2, b: 3 })
    expect(res.content[0].text).toBe('5')
  })
})

describe('LIVE: MCP client <-> proxy facade (the path Claude takes)', () => {
  let client: InstanceType<typeof Client>

  beforeAll(async () => {
    const server = new McpServer({ name: 'conductor-test', version: '1.0.0' }, { capabilities: {} })
    registerProxyTools(server, z, {
      getTools: () => sup.getTools(),
      getState: () => sup.getState(),
      callTool: (id, tool, args) => sup.callTool(id, tool, args),
    })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()
    client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} })
    await Promise.all([server.connect(serverT), client.connect(clientT)])
  }, 30000)

  it('advertises exactly the fixed meta-tools (upstream tools are NOT in the list)', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t: any) => t.name).sort()
    expect(names).toEqual(['call_tool', 'describe_tool', 'list_servers', 'search_tools'])
  })

  it('search_tools finds a namespaced upstream tool', async () => {
    const res: any = await client.callTool({ name: 'search_tools', arguments: { query: 'echo text' } })
    const payload = JSON.parse(res.content[0].text)
    expect(payload.results.map((r: any) => r.name)).toContain('echo__echo')
  })

  it('describe_tool returns the upstream input schema on demand', async () => {
    const res: any = await client.callTool({ name: 'describe_tool', arguments: { name: 'echo__add' } })
    const payload = JSON.parse(res.content[0].text)
    expect(payload.inputSchema.properties.a).toBeTruthy()
    expect(payload.inputSchema.properties.b).toBeTruthy()
  })

  it('call_tool routes through the proxy to the real upstream', async () => {
    const res: any = await client.callTool({ name: 'call_tool', arguments: { name: 'echo__echo', arguments: { text: 'hello proxy' } } })
    expect(res.content[0].text).toBe('hello proxy')
  })

  it('list_servers reports the upstream online', async () => {
    const res: any = await client.callTool({ name: 'list_servers', arguments: {} })
    const payload = JSON.parse(res.content[0].text)
    expect(payload.servers.find((s: any) => s.name === 'Echo')).toMatchObject({ status: 'online' })
  })

  it('after the upstream stops, call_tool fails gracefully (race guard)', async () => {
    await sup.stopUpstream('echo1')
    const res: any = await client.callTool({ name: 'call_tool', arguments: { name: 'echo__echo', arguments: { text: 'x' } } })
    // Tool no longer resolvable -> unknown-tool guidance, not a crash.
    expect(res.isError).toBe(true)
    expect(res.content[0].text.toLowerCase()).toContain('search_tools')
  })
})
