/// <reference types="vite/client" />
// WP2 PR 4 review fix pass (A1-Q2): the Conductor MCP server's start and stop
// each ask the REGISTERED Codex provider to remove the conductor block an older
// build wrote into the user's own Codex config. The call is `?.` on an optional
// member, so deleting either line or breaking the routing passes typecheck:
// this pins the call side. [host] A real listen on loopback, on a port the
// system handed out a moment before (a listen on port 0, closed; the server's
// own start takes a fixed port, so 0 itself cannot be passed); the home folder
// is a temp folder (the `os` module is mocked, named and default exports
// alike, and checked before anything starts), so the ~/.claude.json heal
// beside it reads and writes only there; the Codex provider is a counting fake.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as path from 'node:path'

const h = vi.hoisted(() => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  return { home: nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-mcp-codex-heal-')) }
})
type OsModule = typeof import('node:os') & { default?: typeof import('node:os') }
const redirectedOs = (orig: OsModule) => ({ ...orig, homedir: () => h.home, default: { ...(orig.default ?? orig), homedir: () => h.home } })
vi.mock('os', async (importOriginal) => redirectedOs(await importOriginal<OsModule>()))
vi.mock('node:os', async (importOriginal) => redirectedOs(await importOriginal<OsModule>()))
vi.mock('../../../src/main/vision-manager', () => ({
  startGlobalVision: vi.fn(), stopGlobalVision: vi.fn(), isGlobalVisionRunning: vi.fn(() => false),
  getGlobalVisionConfig: vi.fn(), cleanupLegacyVisionMarkers: vi.fn(), getGlobalManager: vi.fn(() => null), launchBrowser: vi.fn(),
}))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: vi.fn(() => null), saveConfig: vi.fn(() => true) }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => ({ reviewReady: () => false }) }))
vi.mock('../../../src/main/update-watcher', () => ({ isPackagedApp: () => false, getProjectRootPath: vi.fn(() => ''), hasSourcePath: vi.fn(() => false) }))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.home }))

const osMod = await import('os') as OsModule
const osDefault = (await import('node:os') as OsModule).default
const server = await import('../../../src/main/conductor-mcp-server')
const { registerProvider } = await import('../../../src/main/providers')

let heals = 0
beforeAll(() => {
  // Nothing starts unless the home every module sees is the temp folder.
  if (osMod.homedir() !== h.home || osMod.default?.homedir() !== h.home || osDefault?.homedir() !== h.home) throw new Error('the home folder is not redirected; refusing to start the server')
  registerProvider({ id: 'codex', displayName: 'Codex', removeLegacyMcpServerConfig: () => { heals++ } } as never)
})
afterAll(() => {
  server.stopConductorMcpServer()
  if (path.basename(h.home).startsWith('ccc-mcp-codex-heal-')) fs.rmSync(h.home, { recursive: true, force: true })
})

describe('the Conductor MCP server heals the Codex config through the registered provider [host]', () => {
  it('start asks once and stop asks once more; the ~/.claude.json heal beside it ran in the temp home', async () => {
    const claudeJson = path.join(h.home, '.claude.json')
    fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { conductor: { url: 'http://127.0.0.1:1/sse' }, other: { url: 'x' } }, keep: true }))
    const port = await new Promise<number>((resolve, reject) => {
      const probe = net.createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const a = probe.address()
        probe.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))))
      })
    })
    await server.startConductorMcpServer(port)
    expect(heals, 'start did not reach the Codex provider').toBe(1)
    expect(JSON.parse(fs.readFileSync(claudeJson, 'utf8'))).toEqual({ mcpServers: { other: { url: 'x' } }, keep: true })
    server.stopConductorMcpServer()
    expect(heals, 'stop did not reach the Codex provider').toBe(2)
    // A stop with nothing running asks nothing.
    server.stopConductorMcpServer()
    expect(heals).toBe(2)
  })
})
