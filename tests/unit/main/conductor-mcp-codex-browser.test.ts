/// <reference types="vite/client" />
// [host] WP2 PR 4, P4.2 (row 52): a Codex session's vision tools and its push
// to the user's in-app browser are its own. A real listen on an ephemeral
// port, driven by the MCP SDK's own client over a Codex session's credential
// (the provider is the one the credential was issued to): every vision call
// goes to that session's own pinned browser target, and a push lands in that
// session's pane -- never another session's, whatever the model names.
// P4.2 review: run over /mcp (streamable HTTP, the route Codex itself uses,
// A42-3) as well as /sse; /mcp serves only a session whose credential this
// run issued to Codex (A42-1); and over /mcp the Vision switch alone keeps the
// vision tools from a Codex connection (A42-2).

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const settings: { value: Record<string, unknown> | null } = { value: null }

vi.mock('../../../src/main/vision-manager', () => ({
  startGlobalVision: vi.fn(),
  stopGlobalVision: vi.fn(),
  isGlobalVisionRunning: vi.fn(() => false),
  getGlobalVisionConfig: vi.fn(),
  cleanupLegacyVisionMarkers: vi.fn(),
  getGlobalManager: vi.fn(() => null),
  launchBrowser: vi.fn(),
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: vi.fn((name: string) => (name === 'settings' ? settings.value : null)), saveConfig: vi.fn() }))
vi.mock('../../../src/main/update-watcher', () => ({ isPackagedApp: () => false, getProjectRootPath: vi.fn(() => ''), hasSourcePath: vi.fn(() => false) }))
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-codex-browser-'))
  return { getResourcesDirectory: () => dir }
})

const server = await import('../../../src/main/conductor-mcp-server')
const { IPC } = await import('../../../src/shared/ipc-channels')

const visionCalls: Array<{ command: string; sessionId?: string }> = []
const sent: Array<{ channel: string; payload: unknown }> = []
const vm = { executeCommand: async (cmd: { command: string; sessionId?: string }) => { visionCalls.push(cmd); return { ok: true, data: 'page text' } } }
const win = { isDestroyed: () => false, webContents: { send: (channel: string, payload: unknown) => { sent.push({ channel, payload }) } } }

let port = 0
beforeAll(async () => {
  port = 32000 + Math.floor(Math.random() * 1000)
  await server.startMcpServer(port, () => vm as never, () => win as never)
})
afterAll(() => { server.stopMcpServer() })
beforeEach(() => { visionCalls.length = 0; sent.length = 0; settings.value = null })

const SID = 'cxbr1111cxbr1111cxbr1111'
const OTHER = 'othr2222othr2222othr2222'

type Route = 'mcp' | 'sse'
async function withCodexClient<T>(fn: (c: Client) => Promise<T>, route: Route = 'mcp', sid: string = SID): Promise<T> {
  const token = server.issueMcpSessionToken(sid, 'codex')
  const client = new Client({ name: 'codex-browser-test', version: '0.0.0' })
  await client.connect(route === 'sse'
    ? new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse?cccSessionId=${sid}&token=${token}`))
    : new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?cccSessionId=${sid}`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
  try { return await fn(client) } finally { await client.close() }
}
/** A raw tools/list on /mcp with this credential, as any caller could send it. */
async function rawMcpToolsList(sid: string, token: string): Promise<{ status: number; body: string }> {
  const r = await fetch(`http://127.0.0.1:${port}/mcp?cccSessionId=${sid}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  return { status: r.status, body: await r.text() }
}
const textOf = (r: unknown): string => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('')

describe.each(['mcp', 'sse'] as const)('a Codex session\'s vision tools (over /%s)', (route) => {
  it('are routed to that session\'s own pinned browser target', async () => {
    const r = await withCodexClient((c) => c.callTool({ name: 'vision_text', arguments: { selector: 'main' } }), route)
    expect(textOf(r)).toContain('page text')
    expect(visionCalls).toEqual([{ command: 'text', args: ['main'], sessionId: SID }])
  })
})

describe.each(['mcp', 'sse'] as const)('a Codex session\'s push to the in-app browser (over /%s)', (route) => {
  it('lands in that session\'s pane', async () => {
    const r = await withCodexClient((c) => c.callTool({ name: 'open_in_app_browser', arguments: { url: 'https://example.com/pr/7' } }), route)
    expect(textOf(r)).toContain('"ok":true')
    expect(sent).toEqual([{ channel: IPC.WEBVIEW_AGENT_PUSH, payload: { sessionId: SID, url: 'https://example.com/pr/7' } }])
  })

  it('refuses another session named by the model, and pushes nothing', async () => {
    const r = await withCodexClient((c) => c.callTool({ name: 'open_in_app_browser', arguments: { url: 'https://example.com/', sessionId: OTHER } }), route)
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(textOf(r)).toMatch(/only on the authenticated session/)
    expect(sent).toEqual([])
  })

  it('refuses a scheme other than http and https', async () => {
    const r = await withCodexClient((c) => c.callTool({ name: 'open_in_app_browser', arguments: { url: 'file:///C:/Windows/win.ini' } }), route)
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(sent).toEqual([])
  })
})

describe('/mcp serves only a session whose credential this run issued to Codex (A42-1)', () => {
  it('[host] a credential never issued this run (it still verifies: the key outlives a run) is refused, and lists no tool', async () => {
    const sid = 'prev3333prev3333prev3333'
    const r = await rawMcpToolsList(sid, server.mcpSessionToken(sid))
    expect(r.status).toBe(403)
    expect(r.body).not.toMatch(/vision_|open_in_app_browser/)
    expect(visionCalls).toEqual([])
  })

  it('[host] a Claude session\'s credential is refused there too (its tool set is the SSE route\'s)', async () => {
    const sid = 'clde4444clde4444clde4444'
    const r = await rawMcpToolsList(sid, server.issueMcpSessionToken(sid, 'claude'))
    expect(r.status).toBe(403)
  })

  it('[host] the same request with a Codex credential issued this run is served', async () => {
    const sid = 'cdxi5555cdxi5555cdxi5555'
    const r = await rawMcpToolsList(sid, server.issueMcpSessionToken(sid, 'codex'))
    expect(r.status).toBe(200)
    expect(r.body).toContain('vision_text')
  })
})

describe('over /mcp a Codex connection follows the Built-in Tools switches (A42-2)', () => {
  // With no tool at all registered the server offers no tools capability:
  // tools/list is then "method not found" (-32601), the same as an empty list.
  const tools = (sid: string): Promise<string[]> => withCodexClient(async (c) => {
    try { return (await c.listTools()).tools.map((t) => t.name) } catch (err) { if ((err as { code?: number }).code === -32601) return []; throw err }
  }, 'mcp', sid)

  it('[host] the Vision switch off: no vision tool, the in-app browser push still offered', async () => {
    settings.value = { conductorTools: { vision: false } }
    const names = await tools('vsof6666vsof6666vsof6666')
    expect(names.filter((n) => n.startsWith('vision_'))).toEqual([])
    expect(names).toContain('open_in_app_browser')
  })

  it('[host] the Built-in Tools off: neither', async () => {
    settings.value = { conductorToolsEnabled: false }
    const names = await tools('mstf7777mstf7777mstf7777')
    expect(names.filter((n) => n.startsWith('vision_'))).toEqual([])
    expect(names).not.toContain('open_in_app_browser')
  })

  it('[host] both on: the vision tools and the push', async () => {
    settings.value = {}
    const names = await tools('both8888both8888both8888')
    expect(names).toContain('vision_text')
    expect(names).toContain('open_in_app_browser')
  })
})
