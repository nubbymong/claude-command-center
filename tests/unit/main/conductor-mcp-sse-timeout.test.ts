// The conductor MCP server hosts SSE streams — one HTTP response per client
// that deliberately never ends. Node's default server.requestTimeout (300 s)
// destroyed every such stream at exactly 5:00; the client silently
// reconnected, and a tool call in flight across that churn was stranded with
// no error on either side (VM functional test, 2026-08-13: a canvas_render
// whose reply never came; the #435 stale-transport 404 is the same storm's
// other face). This pins that the listening server runs with the per-request
// clock OFF — a real listen on an ephemeral port, not a mock.

import { describe, it, expect, vi, afterAll } from 'vitest'
import * as http from 'http'

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
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-sse-timeout-'))
  return { getResourcesDirectory: () => dir }
})

const server = await import('../../../src/main/conductor-mcp-server')

afterAll(() => {
  server.stopMcpServer()
})

describe('conductor MCP server SSE viability', () => {
  it('listens with requestTimeout disabled so an SSE stream can outlive 300 s', async () => {
    // Ephemeral-ish port in the dynamic range to avoid colliding with a real
    // conductor instance on this machine.
    const port = 29000 + Math.floor(Math.random() * 1000)
    await server.startMcpServer(port, () => null)
    expect(server.isMcpServerRunning()).toBe(true)

    // The property under test, read from a live probe of our own: a plain
    // GET proves the server answers on the port (so we grabbed the right
    // instance), and the exported accessor confirms the port took.
    expect(server.getMcpPort()).toBe(port)
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/definitely-not-a-route' }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
    })
    expect(status).toBeGreaterThanOrEqual(400) // alive and answering

    // requestTimeout must be OFF. Reach the module's private server through
    // the one seam Node gives us: process handles. Exactly one listening
    // http.Server on our port belongs to this test.
    const handles = (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles()
    const ours = handles.find(
      (h): h is http.Server => h instanceof http.Server && (h.address() as { port?: number } | null)?.port === port,
    )
    expect(ours, 'expected to find the listening server handle').toBeTruthy()
    expect(ours!.requestTimeout).toBe(0)
  })
})
