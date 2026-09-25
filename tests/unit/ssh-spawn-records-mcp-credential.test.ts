/**
 * The SSH spawn path records the session's MCP credential as a Claude one
 * BEFORE ssh starts. The reverse tunnel is live as soon as ssh logs in, and a
 * remote Claude kept running in tmux from an earlier app run reconnects through
 * it before any setup script is written (that is where the other issue sites
 * are), so the record has to exist by the time the process is handed to
 * node-pty. Drives the real spawnPty SSH branch; node-pty's spawn reads the
 * record, then throws to stop before the post-spawn state machine (same
 * short-circuit as ssh-spawn-callsite.test.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => 'linux') }
})

// The per-install secret lives under the resources dir: keep it in a temp dir.
vi.mock('../../src/main/ipc/setup-handlers', async (importOriginal) => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-ssh-credential-'))
  return { ...(await importOriginal<typeof import('../../src/main/ipc/setup-handlers')>()), getResourcesDirectory: () => dir }
})

const port = { value: 19433 }
vi.mock('../../src/main/conductor-mcp-server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/conductor-mcp-server')>()),
  getConductorMcpPort: () => port.value,
}))

let recordedAtSpawn: string | null | undefined
let spawnSid = ''
vi.mock('node-pty', () => ({
  spawn: () => {
    recordedAtSpawn = mcpSessionProvider(spawnSid)
    throw new Error('__spawn_captured__')
  },
}))

import * as osMod from 'os'
import type { SessionProvider } from '../../src/main/providers/types'
import { spawnPty } from '../../src/main/pty-manager'
import { registerProvider } from '../../src/main/providers'
import { mcpSessionProvider } from '../../src/main/conductor-mcp-server'

const fakeProvider = {
  id: 'claude',
  displayName: 'Claude',
  resolveBinary: () => null,
  buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false,
  ingestSessionTelemetry: () => ({ stop() {} }),
  listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }),
  configureMcpServer: async () => {},
  getSshSettingsPath: () => '',
  getSshMcpConfigPath: () => '',
  configureRemoteSettings: () => '',
} as unknown as SessionProvider

const fakeWin = { webContents: { send() {} }, isDestroyed: () => false } as never
const ssh = { username: 'me', host: 'example.com', port: 22, remotePath: '~/proj' }

describe('SSH spawn records the MCP credential before ssh starts', () => {
  beforeEach(() => {
    recordedAtSpawn = undefined
    registerProvider(fakeProvider)
    vi.mocked(osMod.platform).mockReturnValue('linux' as NodeJS.Platform)
  })

  it('records the session as a Claude one by the time node-pty is handed ssh', () => {
    port.value = 19433
    spawnSid = 'sidsshcred1'
    expect(mcpSessionProvider(spawnSid)).toBeNull()
    expect(() => spawnPty(fakeWin, spawnSid, { ssh, cwd: osMod.homedir() })).toThrow('__spawn_captured__')
    expect(recordedAtSpawn).toBe('claude')
  })

  it('records nothing when the conductor MCP server is not listening (no tunnel, no credential)', () => {
    port.value = 0
    spawnSid = 'sidsshcred2'
    expect(() => spawnPty(fakeWin, spawnSid, { ssh, cwd: osMod.homedir() })).toThrow('__spawn_captured__')
    expect(recordedAtSpawn).toBeNull()
  })
})
