// WP2 commit 6: each review direction has its own switch (Settings, Built-in
// tools), read per connection from the saved settings. A Claude session's
// tool list carries codex_review only while "Codex review" is on; a Codex
// session's carries claude_review only while "Claude review" is on (and a
// Claude review could run). A real listen on an ephemeral port, driven by the
// MCP SDK's own clients: SSE for a Claude session, streamable HTTP for Codex.
// Pins the wiring from the settings key to the gate, which the pure
// offeredReviewTool tests cannot see.

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const settings: { value: Record<string, unknown> } = { value: {} }

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
  readConfig: vi.fn((name: string) => (name === 'settings' ? settings.value : null)),
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
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-review-switches-'))
  return { getResourcesDirectory: () => dir }
})

// A Claude review could run now: only the switch decides in these tests.
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({ reviewReady: () => true }),
}))

const server = await import('../../../src/main/conductor-mcp-server')

let port = 0
beforeAll(async () => {
  // Its own range, so it cannot draw the port of another MCP test running beside it.
  port = 31000 + Math.floor(Math.random() * 1000)
  await server.startMcpServer(port, () => null)
})
afterAll(() => {
  server.stopMcpServer()
})

async function claudeSessionTools(sessionId: string): Promise<string[]> {
  const token = server.issueMcpSessionToken(sessionId, 'claude')
  const client = new Client({ name: 'review-switches-claude', version: '0.0.0' })
  await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse?cccSessionId=${encodeURIComponent(sessionId)}&token=${token}`)))
  try {
    return (await client.listTools()).tools.map((t) => t.name)
  } finally {
    await client.close()
  }
}

async function codexSessionTools(sessionId: string): Promise<string[]> {
  const token = server.issueMcpSessionToken(sessionId, 'codex')
  const client = new Client({ name: 'review-switches-codex', version: '0.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp?cccSessionId=${encodeURIComponent(sessionId)}`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  })
  await client.connect(transport)
  try {
    return (await client.listTools()).tools.map((t) => t.name)
  } finally {
    await client.close()
  }
}

describe('each review direction follows its own switch', () => {
  it('Codex review: a Claude session is offered codex_review while it is on, and not once it is off', async () => {
    settings.value = { codexEnabled: true }
    expect(await claudeSessionTools('rs-claude-1')).toContain('codex_review')
    settings.value = { codexEnabled: true, conductorTools: { codexReview: false } }
    expect(await claudeSessionTools('rs-claude-2')).not.toContain('codex_review')
    // The other direction's switch does not decide it.
    settings.value = { codexEnabled: true, conductorTools: { claudeReview: false } }
    expect(await claudeSessionTools('rs-claude-3')).toContain('codex_review')
  })

  it('Claude review: a Codex session is offered claude_review while it is on (absent means on), and not once it is off', async () => {
    settings.value = {}
    expect(await codexSessionTools('rs-codex-1')).toContain('claude_review')
    settings.value = { conductorTools: { claudeReview: false } }
    expect(await codexSessionTools('rs-codex-2')).not.toContain('claude_review')
    // The other direction's switch does not decide it.
    settings.value = { conductorTools: { codexReview: false } }
    expect(await codexSessionTools('rs-codex-3')).toContain('claude_review')
  })
})
