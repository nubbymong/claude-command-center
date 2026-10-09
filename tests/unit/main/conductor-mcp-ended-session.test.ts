/// <reference types="vite/client" />
// A status update a session's credential started sending before the session
// ended is not taken after it: the server checks the session's record again
// once the body has been read. (A tool call still running when its session
// ends: conductor-mcp-provider-binding.test.ts.) The real server on a loopback
// port, driven over raw HTTP.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as http from 'http'

const h = vi.hoisted(() => ({ dispatched: [] as string[] }))
vi.mock('../../../src/main/install-secret', () => ({ getInstallSecret: () => 'a7'.repeat(32) }))
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
vi.mock('../../../src/main/statusline-watcher', () => ({ dispatchSSHStatuslineUpdate: (payload: string) => { h.dispatched.push(payload) } }))
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-mcp-ended-'))
  return { getResourcesDirectory: () => dir }
})

const server = await import('../../../src/main/conductor-mcp-server')

let port = 0
beforeAll(async () => {
  // Its own range, so it cannot draw the port of another MCP test running beside it.
  port = 36000 + Math.floor(Math.random() * 1000)
  await server.startMcpServer(port, () => null)
})
afterAll(() => { server.stopMcpServer() })

/** POST /status whose body is held until the server has taken the request
 *  (Expect: 100-continue: the server's own check at the top has run when the
 *  client hears Continue); `beforeBody` runs then. */
function statusPost(sid: string, token: string, beforeBody: () => void): Promise<number> {
  const body = JSON.stringify({ model: { display_name: 'MARK-STATUS-44a' } })
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST',
      path: `/status?cccSessionId=${encodeURIComponent(sid)}&token=${token}`,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Expect: '100-continue' },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('continue', () => { beforeBody(); req.end(body) })
    req.on('error', reject)
  })
}

describe('a status update whose body is still arriving when its session ends', () => {
  it('a session that is still running has it taken (the control)', async () => {
    h.dispatched.length = 0
    const token = server.issueMcpSessionToken('end-status-live', 'claude')
    expect(await statusPost('end-status-live', token, () => {})).toBe(204)
    expect(h.dispatched).toHaveLength(1)
    expect(h.dispatched[0]).toContain('MARK-STATUS-44a')
    server.releaseMcpSessionProvider('end-status-live')
  })

  it('is refused and not taken once the session has ended', async () => {
    h.dispatched.length = 0
    const token = server.issueMcpSessionToken('end-status-gone', 'claude')
    expect(await statusPost('end-status-gone', token, () => server.releaseMcpSessionProvider('end-status-gone'))).toBe(403)
    expect(h.dispatched).toEqual([])
  })

  it('is refused and not taken when the same session has been launched again since', async () => {
    h.dispatched.length = 0
    const token = server.issueMcpSessionToken('end-status-relaunch', 'claude')
    // The launch ends and the next launch of the same session starts (its
    // credential is the same in this run) before the body has been read.
    const relaunch = () => {
      server.releaseMcpSessionProvider('end-status-relaunch')
      expect(server.issueMcpSessionToken('end-status-relaunch', 'claude')).toBe(token)
    }
    expect(await statusPost('end-status-relaunch', token, relaunch)).toBe(403)
    expect(h.dispatched).toEqual([])
    server.releaseMcpSessionProvider('end-status-relaunch')
  })

  it('a later credential issue in the same launch is the same launch: the status is taken (the control)', async () => {
    h.dispatched.length = 0
    const token = server.issueMcpSessionToken('end-status-reissue', 'claude')
    expect(await statusPost('end-status-reissue', token, () => { server.issueMcpSessionToken('end-status-reissue', 'claude') })).toBe(204)
    expect(h.dispatched).toHaveLength(1)
    server.releaseMcpSessionProvider('end-status-reissue')
  })
})
