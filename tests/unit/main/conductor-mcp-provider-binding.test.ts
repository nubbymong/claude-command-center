/// <reference types="vite/client" />
// A connection's tool set follows the provider its session's credential was
// issued to (issueMcpSessionToken), read back on the SSE route; nothing the
// request says changes it, and a session with no credential issued this run
// is not served. A real listen on an ephemeral port, driven by the MCP SDK's
// own SSE client -- the way a Claude CLI connects.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as http from 'http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

vi.mock('../../../src/main/vision-manager', () => ({
  startGlobalVision: vi.fn(),
  stopGlobalVision: vi.fn(),
  isGlobalVisionRunning: vi.fn(() => false),
  getGlobalVisionConfig: vi.fn(),
  cleanupLegacyVisionMarkers: vi.fn(),
  getGlobalManager: vi.fn(() => null),
  launchBrowser: vi.fn(),
}))

// Codex is set up and both reviews can run, so each connection is offered
// its provider's own review tool: what tells the two tool sets apart now that
// a Codex session is offered the canvas, vision and browser tools too (P4.1,
// P4.2).
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => ({ codexEnabled: true, codexAnswered: true })),
  saveConfig: vi.fn(),
}))

vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({ reviewReady: () => true }),
}))

vi.mock('../../../src/main/update-watcher', () => ({
  isPackagedApp: () => false,
  getProjectRootPath: vi.fn(() => ''),
  hasSourcePath: vi.fn(() => false),
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-provider-binding-'))
  return { getResourcesDirectory: () => dir }
})

const server = await import('../../../src/main/conductor-mcp-server')
const { CODEX_CONDUCTOR_TOOLS, CANVAS_TOOL_NAMES, VISION_TOOL_NAMES } = await import('../../../src/main/providers/codex/conductor-tools')

let port = 0
beforeAll(async () => {
  // Its own range, so it cannot draw the port of another MCP test running beside it.
  port = 30000 + Math.floor(Math.random() * 1000)
  await server.startMcpServer(port, () => null)
})
afterAll(() => {
  server.stopMcpServer()
})

const sseUrl = (sessionId: string, token: string, extra = '') =>
  new URL(`http://127.0.0.1:${port}/sse?cccSessionId=${encodeURIComponent(sessionId)}&token=${token}${extra}`)

async function toolsOffered(sessionId: string, token: string, extra = ''): Promise<string[]> {
  const client = new Client({ name: 'provider-binding-test', version: '0.0.0' })
  await client.connect(new SSEClientTransport(sseUrl(sessionId, token, extra)))
  try {
    return (await client.listTools()).tools.map((t) => t.name)
  } finally {
    await client.close()
  }
}

function sseStatus(sessionId: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(sseUrl(sessionId, token), (res) => {
      resolve(res.statusCode ?? 0)
      res.destroy()
    })
    req.on('error', reject)
  })
}

// Each provider is offered the other's review (codex_review to a Claude
// connection, claude_review to a Codex one); the rest is offered to both.
// WP2 PR 4, P4.2 (row 52): the vision tools and the in-app browser push are
// no longer Claude's alone.
const CLAUDE_ONLY = ['codex_review']
const CODEX_ONLY = ['claude_review']
const SHARED = 'fetch_host_screenshot'
const NOW_BOTH = ['vision_status', 'vision_text', 'vision_screenshot', 'open_in_app_browser', 'canvas_render']

describe('issueMcpSessionToken', () => {
  it('returns the session token and records the provider it was issued to', () => {
    expect(server.mcpSessionProvider('pb-unissued')).toBeNull()
    expect(server.issueMcpSessionToken('pb-record', 'codex')).toBe(server.mcpSessionToken('pb-record'))
    expect(server.mcpSessionProvider('pb-record')).toBe('codex')
  })

  it('keeps the latest issue for a session id', () => {
    server.issueMcpSessionToken('pb-latest', 'claude')
    server.issueMcpSessionToken('pb-latest', 'codex')
    expect(server.mcpSessionProvider('pb-latest')).toBe('codex')
  })

  it('keeps a Codex record for the run: a later Claude issue for that id does not replace it', () => {
    const first = server.issueMcpSessionToken('pb-sticky', 'codex')
    expect(server.issueMcpSessionToken('pb-sticky', 'claude')).toBe(first)
    expect(server.mcpSessionProvider('pb-sticky')).toBe('codex')
  })
})

// Every writer outside the server issues through issueMcpSessionToken, so the
// provider is always recorded; only the server mints a token directly (to
// verify one, and for a session that already authenticated). No source outside
// it names the minting function at all -- not in an import, an alias or a
// comment -- so there is nothing to parse around.
const SOURCES = import.meta.glob('../../../src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

describe('token issue sites', () => {
  it('no source outside the server names the direct minting function', () => {
    const files = Object.keys(SOURCES)
    expect(files.length).toBeGreaterThan(200)
    expect(files.some((f) => f.endsWith('/src/main/providers/claude/ssh-shim.ts'))).toBe(true)
    const offenders = files.filter((f) => !f.endsWith('/src/main/conductor-mcp-server.ts') && /\bmcpSessionToken\b/.test(SOURCES[f]))
    expect(offenders).toEqual([])
  })
})

describe('SSE route: the tool set follows the issued provider', () => {
  it('serves a Claude session the Claude tool set', async () => {
    const token = server.issueMcpSessionToken('pb-claude', 'claude')
    const tools = await toolsOffered('pb-claude', token)
    expect(tools).toContain(SHARED)
    for (const name of CLAUDE_ONLY) expect(tools).toContain(name)
    for (const name of CODEX_ONLY) expect(tools).not.toContain(name)
    for (const name of NOW_BOTH) expect(tools).toContain(name)
  })

  it.each(['', '&source=claude', '&source=unknown', '&source='])(
    'serves a Codex session the Codex tool set (extra query %j)',
    async (extra) => {
      const token = server.issueMcpSessionToken('pb-codex', 'codex')
      const tools = await toolsOffered('pb-codex', token, extra)
      expect(tools).toContain(SHARED)
      for (const name of CLAUDE_ONLY) expect(tools).not.toContain(name)
      for (const name of CODEX_ONLY) expect(tools).toContain(name)
    },
  )

  // WP2 PR 4, P4.1 (row 51): the Agent Canvas tools reach a Codex session
  // too: its connection is bound to its session by its own credential, as a
  // Claude one is, and the serving rule is keyed on that session id.
  it('serves a Codex session the Agent Canvas tools', async () => {
    const token = server.issueMcpSessionToken('pb-codex-canvas', 'codex')
    const tools = await toolsOffered('pb-codex-canvas', token)
    for (const name of CANVAS_TOOL_NAMES) expect(tools).toContain(name)
  })

  // The table a Codex launch's per-preset approvals read
  // (providers/codex/conductor-tools.ts) is held to what a Codex connection
  // really lists: no tool is offered that it does not name.
  it('every tool a Codex connection is offered is in the launch\'s tool table', async () => {
    const token = server.issueMcpSessionToken('pb-codex-table', 'codex')
    const tools = await toolsOffered('pb-codex-table', token)
    const table = CODEX_CONDUCTOR_TOOLS.map((t) => t.name)
    expect(tools.filter((t) => !table.includes(t))).toEqual([])
    // ...and, with every switch on and a Claude review ready, it names
    // nothing the connection lacks.
    expect(table.filter((t) => !tools.includes(t))).toEqual([])
  })

  // WP2 PR 4, P4.2 (row 52): the vision tools and the push to the user's
  // in-app browser reach a Codex session under the same switches.
  it('serves a Codex session the vision tools and the in-app browser push', async () => {
    const token = server.issueMcpSessionToken('pb-codex-vision', 'codex')
    const tools = await toolsOffered('pb-codex-vision', token)
    for (const name of VISION_TOOL_NAMES) expect(tools).toContain(name)
    expect(tools).toContain('open_in_app_browser')
  })

  it('serves the latest issue: a session re-issued as Codex gets the Codex set', async () => {
    server.issueMcpSessionToken('pb-reissued', 'claude')
    const token = server.issueMcpSessionToken('pb-reissued', 'codex')
    const tools = await toolsOffered('pb-reissued', token)
    for (const name of CLAUDE_ONLY) expect(tools).not.toContain(name)
    for (const name of CODEX_ONLY) expect(tools).toContain(name)
  })

  it('serves a Codex session the Codex set after a later Claude issue for its id', async () => {
    server.issueMcpSessionToken('pb-sticky-sse', 'codex')
    const token = server.issueMcpSessionToken('pb-sticky-sse', 'claude')
    const tools = await toolsOffered('pb-sticky-sse', token)
    expect(tools).toContain(SHARED)
    for (const name of CLAUDE_ONLY) expect(tools).not.toContain(name)
    for (const name of CODEX_ONLY) expect(tools).toContain(name)
  })

  it('refuses a session with a valid token that was never issued this run', async () => {
    expect(await sseStatus('pb-never-issued', server.mcpSessionToken('pb-never-issued'))).toBe(403)
  })

  it('still refuses a wrong token before anything else', async () => {
    server.issueMcpSessionToken('pb-wrong-token', 'claude')
    expect(await sseStatus('pb-wrong-token', server.mcpSessionToken('pb-someone-else'))).toBe(401)
  })
})
