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

vi.mock('../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => null),
  saveConfig: vi.fn(),
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

let port = 0
beforeAll(async () => {
  port = 29000 + Math.floor(Math.random() * 1000)
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

// Present only to a Claude connection; the host-transfer tool is offered to both.
const CLAUDE_ONLY = ['vision_status', 'open_in_app_browser']
const SHARED = 'fetch_host_screenshot'

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
  })

  it.each(['', '&source=claude', '&source=unknown', '&source='])(
    'serves a Codex session the Codex tool set (extra query %j)',
    async (extra) => {
      const token = server.issueMcpSessionToken('pb-codex', 'codex')
      const tools = await toolsOffered('pb-codex', token, extra)
      expect(tools).toContain(SHARED)
      for (const name of CLAUDE_ONLY) expect(tools).not.toContain(name)
    },
  )

  it('serves the latest issue: a session re-issued as Codex gets the Codex set', async () => {
    server.issueMcpSessionToken('pb-reissued', 'claude')
    const token = server.issueMcpSessionToken('pb-reissued', 'codex')
    const tools = await toolsOffered('pb-reissued', token)
    for (const name of CLAUDE_ONLY) expect(tools).not.toContain(name)
  })

  it('serves a Codex session the Codex set after a later Claude issue for its id', async () => {
    server.issueMcpSessionToken('pb-sticky-sse', 'codex')
    const token = server.issueMcpSessionToken('pb-sticky-sse', 'claude')
    const tools = await toolsOffered('pb-sticky-sse', token)
    expect(tools).toContain(SHARED)
    for (const name of CLAUDE_ONLY) expect(tools).not.toContain(name)
  })

  it('refuses a session with a valid token that was never issued this run', async () => {
    expect(await sseStatus('pb-never-issued', server.mcpSessionToken('pb-never-issued'))).toBe(403)
  })

  it('still refuses a wrong token before anything else', async () => {
    server.issueMcpSessionToken('pb-wrong-token', 'claude')
    expect(await sseStatus('pb-wrong-token', server.mcpSessionToken('pb-someone-else'))).toBe(401)
  })
})
