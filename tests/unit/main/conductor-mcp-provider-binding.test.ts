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
  readConfigChecked: vi.fn(() => ({ value: { codexEnabled: true, codexAnswered: true }, outcome: 'ok' })),
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

/** The browser the vision tools reach: none, except in the cases that drive a
 *  tool call (a fake that answers when the case says). */
let heldVision: unknown = null

let port = 0
beforeAll(async () => {
  // Its own range, so it cannot draw the port of another MCP test running beside it.
  port = 30000 + Math.floor(Math.random() * 1000)
  await server.startMcpServer(port, () => heldVision as never)
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

  it('keeps a Codex record for the launch: a later Claude issue for that id does not replace it', () => {
    const first = server.issueMcpSessionToken('pb-sticky', 'codex')
    expect(server.issueMcpSessionToken('pb-sticky', 'claude')).toBe(first)
    expect(server.mcpSessionProvider('pb-sticky')).toBe('codex')
  })

  it('releasing a session at its teardown clears its record and no other; the next launch records its own provider', () => {
    server.issueMcpSessionToken('pb-rel-a', 'codex')
    server.issueMcpSessionToken('pb-rel-b', 'codex')
    server.releaseMcpSessionProvider('pb-rel-a')
    expect(server.mcpSessionProvider('pb-rel-a')).toBeNull()
    expect(server.mcpSessionProvider('pb-rel-b')).toBe('codex')
    // The token is the session's HMAC either way: a release changes what it is served, not what it proves.
    expect(server.issueMcpSessionToken('pb-rel-a', 'claude')).toBe(server.mcpSessionToken('pb-rel-a'))
    expect(server.mcpSessionProvider('pb-rel-a')).toBe('claude')
    // An unchanged provider keeps its record across a release and the next issue.
    server.releaseMcpSessionProvider('pb-rel-b')
    server.issueMcpSessionToken('pb-rel-b', 'codex')
    expect(server.mcpSessionProvider('pb-rel-b')).toBe('codex')
    // Releasing a session that has no record is harmless.
    expect(() => server.releaseMcpSessionProvider('pb-rel-never')).not.toThrow()
  })
})

/** A raw tools/list on the Codex route (/mcp) with this credential, as any caller could send it. */
async function mcpStatus(sessionId: string, token: string): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/mcp?cccSessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  })
  await r.text()
  return r.status
}

// #628 review: an Ask tab keeps its session id when it is revived, and the
// assistant it runs on can change. The record is released when the session's
// process is torn down (cleanupSessionResources), so the next launch's issue
// stands and the tab is served its new assistant's tool set on both routes.
describe('a session revived on another assistant is served that assistant\'s tool set', () => {
  it('Codex, then Claude: the SSE route serves the Claude set and the Codex route refuses it', async () => {
    server.issueMcpSessionToken('pb-revive-cc', 'codex')
    server.releaseMcpSessionProvider('pb-revive-cc')
    const token = server.issueMcpSessionToken('pb-revive-cc', 'claude')
    const tools = await toolsOffered('pb-revive-cc', token)
    for (const name of CLAUDE_ONLY) expect(tools).toContain(name)
    for (const name of CODEX_ONLY) expect(tools).not.toContain(name)
    expect(await mcpStatus('pb-revive-cc', token)).toBe(403)
  })

  it('Claude, then Codex: the SSE route serves the Codex set and the Codex route serves it', async () => {
    server.issueMcpSessionToken('pb-revive-xc', 'claude')
    server.releaseMcpSessionProvider('pb-revive-xc')
    const token = server.issueMcpSessionToken('pb-revive-xc', 'codex')
    const tools = await toolsOffered('pb-revive-xc', token)
    for (const name of CLAUDE_ONLY) expect(tools).not.toContain(name)
    for (const name of CODEX_ONLY) expect(tools).toContain(name)
    expect(await mcpStatus('pb-revive-xc', token)).toBe(200)
  })

  it('between the teardown and the next launch, the session\'s credential is served nothing on either route', async () => {
    const token = server.issueMcpSessionToken('pb-revive-gap', 'codex')
    server.releaseMcpSessionProvider('pb-revive-gap')
    expect(await sseStatus('pb-revive-gap', token)).toBe(403)
    expect(await mcpStatus('pb-revive-gap', token)).toBe(403)
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

  // The other direction: a session issued to Claude is served the Claude set
  // whatever its URL asks for, wherever in the query the ask sits.
  it.each([
    ['&source=codex', (sid: string, token: string) => sseUrl(sid, token, '&source=codex')],
    ['?source=codex first', (sid: string, token: string) => new URL(`http://127.0.0.1:${port}/sse?source=codex&cccSessionId=${encodeURIComponent(sid)}&token=${token}`)],
    ['source=codex twice', (sid: string, token: string) => sseUrl(sid, token, '&source=codex&source=codex')],
  ])('serves a Claude session the Claude tool set (query %s)', async (_name, url) => {
    const token = server.issueMcpSessionToken('pb-claude-asks', 'claude')
    const client = new Client({ name: 'provider-binding-test', version: '0.0.0' })
    await client.connect(new SSEClientTransport(url('pb-claude-asks', token)))
    let tools: string[]
    try {
      tools = (await client.listTools()).tools.map((t) => t.name)
    } finally {
      await client.close()
    }
    expect(tools).toContain(SHARED)
    for (const name of CLAUDE_ONLY) expect(tools).toContain(name)
    for (const name of CODEX_ONLY) expect(tools).not.toContain(name)
  })

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

/** A raw SSE stream: the /messages endpoint it advertises, and whether the
 *  server has ended it. */
function openRawStream(sessionId: string, token: string): Promise<{ endpoint: string; ended: () => boolean; whenEnded: Promise<void>; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get(sseUrl(sessionId, token), (res) => {
      if (res.statusCode !== 200) { res.destroy(); reject(new Error(`stream refused: ${res.statusCode}`)); return }
      let ended = false
      let markEnded!: () => void
      const whenEnded = new Promise<void>((r) => { markEnded = () => { ended = true; r() } })
      res.on('end', () => markEnded())
      res.on('close', () => markEnded())
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buf += chunk
        const m = /event: endpoint\r?\ndata: (\S+)/.exec(buf)
        if (m) resolve({ endpoint: m[1], ended: () => ended, whenEnded, close: () => res.destroy() })
      })
    })
    req.on('error', reject)
  })
}

/** A tools/list POSTed to a stream's endpoint: 202 while the stream takes it. */
async function postToStream(endpoint: string): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} }),
  })
  await r.text()
  return r.status
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Ending a session (its process torn down, whatever the reason) closes every
// tool connection that session opened; its next launch connects afresh and is
// served that launch's tool set.
describe('ending a session closes its open tool connections', () => {
  it('releasing a session closes its open streams', async () => {
    const token = server.issueMcpSessionToken('pb-close', 'claude')
    const raw = await openRawStream('pb-close', token)
    const client = new Client({ name: 'provider-binding-close', version: '0.0.0' })
    await client.connect(new SSEClientTransport(sseUrl('pb-close', token)))
    try {
      expect(await postToStream(raw.endpoint)).toBe(202)
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('codex_review')

      server.releaseMcpSessionProvider('pb-close')
      await Promise.race([raw.whenEnded, settle(2000)])
      expect(raw.ended(), 'the server ended the stream').toBe(true)
      await expect(client.listTools()).rejects.toThrow()
      expect(await postToStream(raw.endpoint)).not.toBe(202)

      // The next launch, on the other provider: the old stream's endpoint is
      // gone for good, and a new connection gets the new launch's tool set.
      const next = server.issueMcpSessionToken('pb-close', 'codex')
      expect(await postToStream(raw.endpoint)).toBe(404)
      const tools = await toolsOffered('pb-close', next)
      for (const name of CODEX_ONLY) expect(tools).toContain(name)
      for (const name of CLAUDE_ONLY) expect(tools).not.toContain(name)
    } finally {
      raw.close()
      await client.close().catch(() => {})
      server.releaseMcpSessionProvider('pb-close')
    }
  })

  it('another session\'s stream stays open', async () => {
    const ids = ['pb-keep', 'PB-KEEP', 'pb-keep2', 'pb-kee', 'pb-keep ', '__proto__', 'constructor']
    const streams = new Map<string, Awaited<ReturnType<typeof openRawStream>>>()
    try {
      for (const id of ids) streams.set(id, await openRawStream(id, server.issueMcpSessionToken(id, 'claude')))
      server.releaseMcpSessionProvider('pb-keep')
      await Promise.race([streams.get('pb-keep')!.whenEnded, settle(2000)])
      expect(streams.get('pb-keep')!.ended()).toBe(true)
      await settle(200)
      for (const id of ids.slice(1)) {
        expect(streams.get(id)!.ended(), id).toBe(false)
        expect(await postToStream(streams.get(id)!.endpoint), id).toBe(202)
        expect(server.mcpSessionProvider(id), id).toBe('claude')
      }
      // Releasing an id that holds nothing closes nothing.
      server.releaseMcpSessionProvider('pb-never-opened')
      await settle(100)
      for (const id of ids.slice(1)) expect(streams.get(id)!.ended(), id).toBe(false)
    } finally {
      for (const [id, s] of streams) { s.close(); server.releaseMcpSessionProvider(id) }
    }
  })
})

// The Codex route answers each request on its own response, which ending a
// session does not close: a tool call still running when its session ends
// gives back none of its tool's answer, value or failure.
describe('a tool call on the Codex route still running when its session ends', () => {
  type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  const arrivals: Array<(p: Pending) => void> = []
  beforeAll(() => {
    heldVision = {
      isConnected: () => true,
      getBrowser: () => 'chrome',
      executeCommand: () => new Promise((resolve, reject) => { arrivals.shift()?.({ resolve, reject }) }),
    }
  })
  afterAll(() => { heldVision = null })
  /** The next command the fake browser is asked, held until the case settles it. */
  const nextCommand = () => new Promise<Pending>((resolve) => { arrivals.push(resolve) })
  /** A tools/call of vision_status on the Codex route, as Codex sends it. */
  async function callVisionStatus(sid: string, token: string): Promise<{ status: number; text: string }> {
    const r = await fetch(`http://127.0.0.1:${port}/mcp?cccSessionId=${encodeURIComponent(sid)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'vision_status', arguments: {} } }),
    })
    return { status: r.status, text: await r.text() }
  }

  it('a session that is still running gets its tool\'s answer (the control)', async () => {
    const token = server.issueMcpSessionToken('pb-call-live', 'codex')
    const arrived = nextCommand()
    const answer = callVisionStatus('pb-call-live', token)
    ;(await arrived).resolve({ ok: true, data: { connected: true, browser: 'MARK-LIVE-7f3' } })
    const { status, text } = await answer
    expect(status).toBe(200)
    expect(text).toContain('MARK-LIVE-7f3')
    server.releaseMcpSessionProvider('pb-call-live')
  })

  it('gives back none of the tool\'s answer once the session has ended', async () => {
    const token = server.issueMcpSessionToken('pb-call-value', 'codex')
    const arrived = nextCommand()
    const answer = callVisionStatus('pb-call-value', token)
    const pending = await arrived
    server.releaseMcpSessionProvider('pb-call-value')
    pending.resolve({ ok: true, data: { connected: true, browser: 'MARK-ENDED-91c' } })
    const { status, text } = await answer
    expect(status).toBe(200)
    expect(text).not.toContain('MARK-ENDED-91c')
    const body = JSON.parse(text) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } }
    expect(body.result?.isError).toBe(true)
    expect(body.result?.content?.[0]?.text).toBe(server.endedSessionToolResult().content[0].text)
  })

  it('nor its failure', async () => {
    const token = server.issueMcpSessionToken('pb-call-fail', 'codex')
    const arrived = nextCommand()
    const answer = callVisionStatus('pb-call-fail', token)
    const pending = await arrived
    server.releaseMcpSessionProvider('pb-call-fail')
    pending.reject(new Error('MARK-FAIL-2d8 at C:\\Users\\someone\\private-folder'))
    const { text } = await answer
    expect(text).not.toContain('MARK-FAIL-2d8')
    expect(text).toContain(server.endedSessionToolResult().content[0].text)
  })

  it('nor, when the same session has been launched again since, on either assistant, its answer or its failure', async () => {
    for (const next of ['codex', 'claude'] as const) {
      for (const settles of ['value', 'failure'] as const) {
        const sid = `pb-call-relaunch-${next}-${settles}`
        const token = server.issueMcpSessionToken(sid, 'codex')
        const arrived = nextCommand()
        const answer = callVisionStatus(sid, token)
        const pending = await arrived
        // The launch ends and the next launch of the same session starts
        // (its credential is the same in this run) before the call returns.
        server.releaseMcpSessionProvider(sid)
        expect(server.issueMcpSessionToken(sid, next)).toBe(token)
        if (settles === 'value') pending.resolve({ ok: true, data: { connected: true, browser: 'MARK-OLD-LAUNCH-5e1' } })
        else pending.reject(new Error('MARK-OLD-LAUNCH-5e1 failed'))
        const { text } = await answer
        expect(text, `${next} ${settles}`).not.toContain('MARK-OLD-LAUNCH-5e1')
        expect(text, `${next} ${settles}`).toContain(server.endedSessionToolResult().content[0].text)
        server.releaseMcpSessionProvider(sid)
      }
    }
  })

  it('a later credential issue in the same launch is the same launch: the call gets its tool\'s answer (the control)', async () => {
    const token = server.issueMcpSessionToken('pb-call-reissue', 'codex')
    const arrived = nextCommand()
    const answer = callVisionStatus('pb-call-reissue', token)
    const pending = await arrived
    expect(server.issueMcpSessionToken('pb-call-reissue', 'codex')).toBe(token)
    pending.resolve({ ok: true, data: { connected: true, browser: 'MARK-SAME-LAUNCH-0b4' } })
    const { status, text } = await answer
    expect(status).toBe(200)
    expect(text).toContain('MARK-SAME-LAUNCH-0b4')
    server.releaseMcpSessionProvider('pb-call-reissue')
  })

  it('a Claude session\'s tool call on its stream gets its tool\'s own answer: the check is the Codex route\'s alone', async () => {
    const token = server.issueMcpSessionToken('pb-call-stream', 'claude')
    const client = new Client({ name: 'provider-binding-stream-call', version: '0.0.0' })
    await client.connect(new SSEClientTransport(sseUrl('pb-call-stream', token)))
    try {
      const arrived = nextCommand()
      const answer = client.callTool({ name: 'vision_status', arguments: {} })
      ;(await arrived).resolve({ ok: true, data: { connected: true, browser: 'MARK-STREAM-c62' } })
      const result = await answer as { isError?: boolean; content?: Array<{ text?: string }> }
      expect(result.isError).not.toBe(true)
      expect(JSON.stringify(result.content)).toContain('MARK-STREAM-c62')
      expect(JSON.stringify(result.content)).not.toContain(server.endedSessionToolResult().content[0].text)
    } finally {
      await client.close().catch(() => {})
      server.releaseMcpSessionProvider('pb-call-stream')
    }
  })
})
