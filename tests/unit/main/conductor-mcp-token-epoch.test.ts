/// <reference types="vite/client" />
// Built-in tools credentials are issued per app run and refused once their
// session ends; a persistent remote session keeps its own across a restart.
// The real server on a loopback port, driven over raw HTTP so every route a
// session's credential reaches (/sse, the stream's /messages endpoint,
// /status) is asked directly. The install secret is a fixed test value, so the
// persistent form (the HMAC of the session id alone) can be computed here and
// presented; an app restart is a fresh load of the server module.
import { describe, it, expect, vi, afterAll } from 'vitest'
import * as crypto from 'crypto'
import * as http from 'http'

const SECRET = 'e5'.repeat(32)

vi.mock('../../../src/main/install-secret', () => ({ getInstallSecret: () => SECRET }))
vi.mock('../../../src/main/vision-manager', () => ({
  startGlobalVision: vi.fn(), stopGlobalVision: vi.fn(), isGlobalVisionRunning: vi.fn(() => false),
  getGlobalVisionConfig: vi.fn(), cleanupLegacyVisionMarkers: vi.fn(), getGlobalManager: vi.fn(() => null), launchBrowser: vi.fn(),
}))
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => null),
  readConfigChecked: vi.fn(() => ({ value: {}, outcome: 'ok' })),
  saveConfig: vi.fn(),
}))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => ({ reviewReady: () => false }) }))
vi.mock('../../../src/main/update-watcher', () => ({ isPackagedApp: () => false, getProjectRootPath: vi.fn(() => ''), hasSourcePath: vi.fn(() => false) }))
vi.mock('../../../src/main/statusline-watcher', () => ({ dispatchSSHStatuslineUpdate: vi.fn() }))
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-token-epoch-'))
  return { getResourcesDirectory: () => dir }
})

type ServerModule = typeof import('../../../src/main/conductor-mcp-server')
let server: ServerModule
let port = 0

/** Start the app's server as a fresh run would: a new load of the module. */
async function startRun(): Promise<void> {
  server?.stopMcpServer()
  vi.resetModules()
  server = await import('../../../src/main/conductor-mcp-server')
  port = 33000 + Math.floor(Math.random() * 1000)
  await server.startMcpServer(port, () => null)
}
afterAll(() => { server?.stopMcpServer() })

/** The persistent form: HMAC(secret, session id), the same in every run. */
const stableToken = (sid: string) => crypto.createHmac('sha256', SECRET).update(sid, 'utf8').digest('hex')
const q = (sid: string, token: string) => `cccSessionId=${encodeURIComponent(sid)}&token=${token}`

function sseStatus(sid: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/sse?${q(sid, token)}`, (res) => { resolve(res.statusCode ?? 0); res.destroy() })
    req.on('error', reject)
  })
}

async function statusPost(sid: string, token: string): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}/status?${q(sid, token)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":{"display_name":"test"}}' })
  await r.text()
  return r.status
}

/** Open an SSE stream and read the /messages endpoint it advertises. */
function openStream(sid: string, token: string): Promise<{ endpoint: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/sse?${q(sid, token)}`, (res) => {
      if (res.statusCode !== 200) { res.destroy(); reject(new Error(`stream refused: ${res.statusCode}`)); return }
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buf += chunk
        const m = /event: endpoint\r?\ndata: (\S+)/.exec(buf)
        if (m) resolve({ endpoint: m[1], close: () => res.destroy() })
      })
    })
    req.on('error', reject)
  })
}

async function messagesPost(endpoint: string): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
  })
  await r.text()
  return r.status
}

describe('built-in tools credentials are issued per run', () => {
  it('a session\'s credential works only in the run that issued it', async () => {
    await startRun()
    const first = server.issueMcpSessionToken('ep-local', 'claude')
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe(stableToken('ep-local'))
    expect(await sseStatus('ep-local', stableToken('ep-local'))).toBe(401)
    expect(await sseStatus('ep-local', first)).toBe(200)

    await startRun()
    const second = server.issueMcpSessionToken('ep-local', 'claude')
    expect(second).not.toBe(first)
    expect(await sseStatus('ep-local', first)).toBe(401)
    expect(await statusPost('ep-local', first)).toBe(401)
    expect(await sseStatus('ep-local', second)).toBe(200)
  })

  it('a credential is refused on every route once its session ends', async () => {
    await startRun()
    const token = server.issueMcpSessionToken('ep-end', 'claude')
    const stream = await openStream('ep-end', token)
    try {
      expect(await messagesPost(stream.endpoint)).toBe(202)
      expect(await statusPost('ep-end', token)).toBe(204)
      server.releaseMcpSessionProvider('ep-end')
      expect(await sseStatus('ep-end', token)).toBe(403)
      expect(await statusPost('ep-end', token)).toBe(403)
      expect(await messagesPost(stream.endpoint)).toBe(403)
    } finally {
      stream.close()
    }
  })

  it('a credential no launch was issued in this run is refused on every route', async () => {
    await startRun()
    // The value a run credential would have, read without issuing one.
    const unissued = server.mcpSessionToken('ep-never')
    expect(await sseStatus('ep-never', unissued)).toBe(403)
    expect(await statusPost('ep-never', unissued)).toBe(403)
  })

  it('a persistent remote session is served again after a restart', async () => {
    await startRun()
    const held = server.issueMcpSessionToken('ep-persist', 'claude', { persistent: true })
    expect(held).toBe(stableToken('ep-persist'))
    expect(await statusPost('ep-persist', held)).toBe(204)

    await startRun()
    // Before the restarted app reconnects to it, the remote's credential is not
    // served: nothing in this run has issued the session's form yet.
    expect(await statusPost('ep-persist', held)).toBe(401)
    expect(await sseStatus('ep-persist', held)).toBe(401)
    expect(server.issueMcpSessionToken('ep-persist', 'claude', { persistent: true })).toBe(held)
    expect(await statusPost('ep-persist', held)).toBe(204)
    expect(await sseStatus('ep-persist', held)).toBe(200)
  })

  it('a run credential refuses the persistent form, and a persistent credential refuses the run form', async () => {
    await startRun()
    const run = server.issueMcpSessionToken('ep-forms', 'claude')
    expect(await sseStatus('ep-forms', stableToken('ep-forms'))).toBe(401)
    expect(await sseStatus('ep-forms', run)).toBe(200)
    server.releaseMcpSessionProvider('ep-forms')
    const persistent = server.issueMcpSessionToken('ep-forms', 'claude', { persistent: true })
    expect(persistent).not.toBe(run)
    expect(await sseStatus('ep-forms', run)).toBe(401)
    expect(await sseStatus('ep-forms', persistent)).toBe(200)
  })

  it('the launch\'s first issue fixes the form; every later issue in it keeps that form', async () => {
    await startRun()
    const persistent = server.issueMcpSessionToken('ep-keep-p', 'claude', { persistent: true })
    expect(server.issueMcpSessionToken('ep-keep-p', 'claude')).toBe(persistent)
    expect(server.issueMcpSessionToken('ep-keep-p', 'claude', {})).toBe(persistent)
    expect(server.issueMcpSessionToken('ep-keep-p', 'claude', { persistent: false })).toBe(persistent)
    expect(await sseStatus('ep-keep-p', persistent)).toBe(200)

    const run = server.issueMcpSessionToken('ep-keep-r', 'claude')
    expect(server.issueMcpSessionToken('ep-keep-r', 'claude')).toBe(run)
    expect(server.issueMcpSessionToken('ep-keep-r', 'claude', { persistent: true })).toBe(run)
    expect(run).not.toBe(stableToken('ep-keep-r'))
    expect(await sseStatus('ep-keep-r', run)).toBe(200)
    expect(await sseStatus('ep-keep-r', stableToken('ep-keep-r'))).toBe(401)

    // A release ends the launch: the next one starts from the run form again.
    server.releaseMcpSessionProvider('ep-keep-p')
    expect(server.issueMcpSessionToken('ep-keep-p', 'claude')).not.toBe(persistent)
  })

  it('the stream\'s advertised endpoint carries the session\'s own form', async () => {
    await startRun()
    const persistent = server.issueMcpSessionToken('ep-endpoint', 'claude', { persistent: true })
    const stream = await openStream('ep-endpoint', persistent)
    try {
      expect(new URLSearchParams(stream.endpoint.split('?')[1]).get('token')).toBe(persistent)
      expect(await messagesPost(stream.endpoint)).toBe(202)
    } finally {
      stream.close()
    }
  })
})
