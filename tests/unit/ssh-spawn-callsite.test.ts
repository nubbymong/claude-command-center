/**
 * #265 finding 4: all existing coverage exercises the PURE buildSshArgs. Nothing
 * pinned that the spawn path actually CALLS it, so a revert to an inline argv
 * array — dropping the #241 win32 ControlMaster override or the reverse tunnel —
 * would leave the suite green.
 *
 * This drives the real spawnPty SSH branch and captures the argv that reaches
 * node-pty's spawn, with os.platform() mocked to win32 so the win32-only flags
 * run on a Linux CI runner. node-pty's spawn captures its args then throws, to
 * short-circuit before spawnPty's post-spawn state machine (which needs a real
 * IPty + BrowserWindow); the SSH branch calls pty.spawn early, right after
 * buildSshArgs, so the capture is faithful.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>()
  return { ...actual, platform: vi.fn(() => 'linux') }
})

let captured: { file: string; args: string[] } | null = null
vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[]) => {
    captured = { file, args }
    // Abort the rest of spawnPty — we only need the argv it hands to spawn.
    throw new Error('__spawn_captured__')
  },
}))

import * as osMod from 'os'
import type { SessionProvider } from '../../src/main/providers/types'
import { spawnPty } from '../../src/main/pty-manager'
import { registerProvider } from '../../src/main/providers'
import { buildSshArgs } from '../../src/main/ssh-args'
import { getConductorMcpPort } from '../../src/main/conductor-mcp-server'

// Minimal SSH-capable Claude provider so getProvider('claude') + isSshCapable
// pass. Only the three SshCapableProvider methods' PRESENCE matters here (the
// spawn short-circuits before any of them is invoked).
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

describe('SSH spawn path uses buildSshArgs (call-site pin, #265 finding 4)', () => {
  beforeEach(() => {
    captured = null
    registerProvider(fakeProvider)
  })

  it('hands buildSshArgs output (incl. the #241 win32 mux flags) to pty.spawn', () => {
    vi.mocked(osMod.platform).mockReturnValue('win32' as NodeJS.Platform)

    const ssh = { username: 'me', host: 'example.com', port: 2222, remotePath: '~/proj' }
    expect(() => spawnPty(fakeWin, 'sidcallsite', { ssh, cwd: osMod.homedir() })).toThrow('__spawn_captured__')

    expect(captured).not.toBeNull()
    // win32 => ssh.exe binary
    expect(captured!.file).toBe('ssh.exe')
    // The EXACT argv the pure builder produces for win32. Computed with the same
    // live MCP port the spawn path reads, so this equals what pty-manager built.
    // A revert to an inline array that drops ControlMaster/ControlPath fails here.
    expect(captured!.args).toEqual(buildSshArgs(ssh, getConductorMcpPort(), 'win32'))
    // Belt-and-braces: the win32 mux override is actually present in what spawned.
    expect(captured!.args).toContain('ControlMaster=no')
    expect(captured!.args).toContain('ControlPath=none')
    expect(captured!.args[0]).toBe('me@example.com')
  })

  it('selects the posix ssh binary and omits the win32 mux flags on linux', () => {
    vi.mocked(osMod.platform).mockReturnValue('linux' as NodeJS.Platform)

    const ssh = { username: 'me', host: 'example.com', port: 22, remotePath: '~/proj' }
    expect(() => spawnPty(fakeWin, 'sidcallsite2', { ssh, cwd: osMod.homedir() })).toThrow('__spawn_captured__')

    expect(captured!.file).toBe('ssh')
    expect(captured!.args).toEqual(buildSshArgs(ssh, getConductorMcpPort(), 'linux'))
    expect(captured!.args).not.toContain('ControlMaster=no')
  })

  // #265 sink-guard backstop on the REAL spawn path. Calling spawnPty directly
  // bypasses the IPC sshSchema — exactly the "call site that skips Zod" the
  // buildSshArgs guard defends against. It must throw before anything spawns, so
  // an option-injecting host/username can never reach argv even off the IPC path.
  it('the buildSshArgs sink guard fires on the real spawn path (schema-bypass backstop)', () => {
    vi.mocked(osMod.platform).mockReturnValue('win32' as NodeJS.Platform)
    const ssh = { username: '-oProxyCommand=touch /tmp/pwn', host: 'example.com', port: 22, remotePath: '~/proj' }
    expect(() => spawnPty(fakeWin, 'sidmalicious', { ssh, cwd: osMod.homedir() })).toThrow(/Refusing to build SSH args/)
    expect(captured).toBeNull() // nothing was ever handed to pty.spawn
  })
})
