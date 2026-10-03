/// <reference types="vite/client" />
// [host] WP2 PR 4, P4.2 (row 52): a Codex session's vision tools and its push
// to the user's in-app browser are its own. A real listen on an ephemeral
// port, driven by the MCP SDK's own client over a Codex session's credential
// (the provider is the one the credential was issued to): every vision call
// goes to that session's own pinned browser target, and a push lands in that
// session's pane -- never another session's, whatever the model names.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
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
vi.mock('../../../src/main/config-manager', () => ({ readConfig: vi.fn(() => null), saveConfig: vi.fn() }))
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
beforeEach(() => { visionCalls.length = 0; sent.length = 0 })

const SID = 'cxbr1111cxbr1111cxbr1111'
const OTHER = 'othr2222othr2222othr2222'

async function withCodexClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const token = server.issueMcpSessionToken(SID, 'codex')
  const client = new Client({ name: 'codex-browser-test', version: '0.0.0' })
  await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse?cccSessionId=${SID}&token=${token}`)))
  try { return await fn(client) } finally { await client.close() }
}
const textOf = (r: unknown): string => ((r as { content?: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('')

describe('a Codex session\'s vision tools', () => {
  it('are routed to that session\'s own pinned browser target', async () => {
    const r = await withCodexClient((c) => c.callTool({ name: 'vision_text', arguments: { selector: 'main' } }))
    expect(textOf(r)).toContain('page text')
    expect(visionCalls).toEqual([{ command: 'text', args: ['main'], sessionId: SID }])
  })
})

describe('a Codex session\'s push to the in-app browser', () => {
  it('lands in that session\'s pane', async () => {
    const r = await withCodexClient((c) => c.callTool({ name: 'open_in_app_browser', arguments: { url: 'https://example.com/pr/7' } }))
    expect(textOf(r)).toContain('"ok":true')
    expect(sent).toEqual([{ channel: IPC.WEBVIEW_AGENT_PUSH, payload: { sessionId: SID, url: 'https://example.com/pr/7' } }])
  })

  it('refuses another session named by the model, and pushes nothing', async () => {
    const r = await withCodexClient((c) => c.callTool({ name: 'open_in_app_browser', arguments: { url: 'https://example.com/', sessionId: OTHER } }))
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(textOf(r)).toMatch(/only on the authenticated session/)
    expect(sent).toEqual([])
  })

  it('refuses a scheme other than http and https', async () => {
    const r = await withCodexClient((c) => c.callTool({ name: 'open_in_app_browser', arguments: { url: 'file:///C:/Windows/win.ini' } }))
    expect((r as { isError?: boolean }).isError).toBe(true)
    expect(sent).toEqual([])
  })
})
