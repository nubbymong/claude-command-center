// #572: "End remote" on a password-auth host was a SILENT NO-OP — the kill
// exec ran with BatchMode=yes (key/agent only), failed fast, and the remote
// tmux+claude survived every End click, accumulating ~350MB orphans per
// "ended" session until the host ran out of memory (the mongminer incident,
// 2026-08-30). endSshRemote now answers exactly one real password prompt over
// a dedicated PTY for password targets, and stays the BatchMode exec for key
// targets. These tests pin both shapes and the prompt discipline: the match
// runs on the ESCAPE-STRIPPED last line, end-anchored (the RC9 ConPTY-glue
// lesson), so a MOTD that merely mentions passwords can never trigger the
// credential write.
//
// Mock stack copied from pty-session-liveness.test.ts (which drives the same
// module); node-pty and child_process are the controllable fakes under test.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface FakePty {
  args: string[]
  writes: string[]
  killed: boolean
  data: ((d: string) => void) | null
  exit: ((e: { exitCode: number }) => void) | null
}

const h = vi.hoisted(() => ({
  ptySpawns: [] as Array<{
    args: string[]
    writes: string[]
    killed: boolean
    data: ((d: string) => void) | null
    exit: ((e: { exitCode: number }) => void) | null
  }>,
  execFiles: [] as Array<{ bin: string; args: string[] }>,
  execFileError: null as Error | null,
}))

vi.mock('node-pty', () => ({
  spawn: (_bin: string, args: string[]) => {
    const rec = { args, writes: [] as string[], killed: false, data: null as ((d: string) => void) | null, exit: null as ((e: { exitCode: number }) => void) | null }
    h.ptySpawns.push(rec)
    return {
      pid: 999,
      process: 'ssh',
      onData: (cb: (d: string) => void) => { rec.data = cb; return { dispose: () => {} } },
      onExit: (cb: (e: { exitCode: number }) => void) => { rec.exit = cb; return { dispose: () => {} } },
      write: (d: string) => { rec.writes.push(d) },
      resize: () => {},
      kill: () => { rec.killed = true },
    }
  },
}))

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: () => '',
  execFile: (bin: string, args: string[], _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
    h.execFiles.push({ bin, args })
    queueMicrotask(() => cb?.(h.execFileError, '', ''))
    return { unref: () => {} }
  },
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-end-remote-'))
  return {
    getResourcesDirectory: () => dir,
    getDataDirectory: () => dir,
    registerSetupHandlers: () => {},
    writeCliSetupPty: () => {},
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))

vi.mock('../../../src/main/logging/logging-service', () => ({
  getLogSupervisor: () => null,
  getTranscriptBinder: () => null,
}))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  registerCodexReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }),
    ingestSessionTelemetry: () => ({ stop: () => {} }),
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({
  resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }),
  resolveHostColorScheme: () => 'dark',
}))
vi.mock('../../../src/main/vision-manager', () => ({
  isGlobalVisionRunning: () => false,
  getGlobalVisionConfig: () => null,
  teardownVisionSession: () => {},
}))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null,
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => null,
  removeLocalSessionMcpConfig: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {},
  clearClaudeAccount: () => {},
  getAccountIdentity: () => null,
  pushAccountIdentity: () => {},
  startWatchingAccountIdentity: () => {},
  stopWatchingAccountIdentity: () => {},
  getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {},
  syncPrimaryCredentialsWithGlobal: () => {},
  backupProfileHomeToCanonical: () => {},
}))

const { endSshRemote, _setSshTargetForTest } = await import('../../../src/main/pty-manager')

const lastPty = (): FakePty => h.ptySpawns[h.ptySpawns.length - 1]

beforeEach(() => {
  h.ptySpawns.length = 0
  h.execFiles.length = 0
  h.execFileError = null
})

describe('endSshRemote (#572)', () => {
  it('resolves no-target for a session with no SSH target', async () => {
    await expect(endSshRemote('never-spawned')).resolves.toBe('no-target')
    expect(h.ptySpawns).toHaveLength(0)
    expect(h.execFiles).toHaveLength(0)
  })

  it('key target: keeps the BatchMode exec and resolves completed', async () => {
    _setSshTargetForTest('sid-key', { username: 'u', host: 'h1', port: 22 })
    await expect(endSshRemote('sid-key')).resolves.toBe('completed')
    expect(h.ptySpawns).toHaveLength(0)
    expect(h.execFiles).toHaveLength(1)
    const args = h.execFiles[0].args
    expect(args).toContain('BatchMode=yes')
    expect(args.join(' ')).toContain('kill-session -t ccc-sid-key')
  })

  it('password target: runs under a PTY without BatchMode, answers ONE glued prompt, resolves completed', async () => {
    _setSshTargetForTest('sid-pw', { username: 'pi', host: 'h2', port: 22, password: 's3cret' })
    const p = endSshRemote('sid-pw')
    expect(h.execFiles).toHaveLength(0)
    const fake = lastPty()
    expect(fake.args).not.toContain('BatchMode=yes')
    expect(fake.args).toContain('NumberOfPasswordPrompts=1')
    // The password must never ride in argv.
    expect(fake.args.join(' ')).not.toContain('s3cret')
    // A MOTD that mentions passwords must NOT trigger the write (end-anchor rule).
    fake.data!("Your password expires in 30 days\r\n")
    expect(fake.writes).toHaveLength(0)
    // The real prompt, with ConPTY-glued escapes around it (the RC9 shape).
    fake.data!("\x1b[?25lpi@h2's password: ")
    expect(fake.writes).toEqual(['s3cret\r'])
    // More output must not retype the password.
    fake.data!('\r\n')
    expect(fake.writes).toHaveLength(1)
    fake.exit!({ exitCode: 0 })
    await expect(p).resolves.toBe('completed')
  })

  it('password target: a prompt split across chunks still matches exactly once', async () => {
    _setSshTargetForTest('sid-split', { username: 'pi', host: 'h3', port: 22, password: 'pw2' })
    const p = endSshRemote('sid-split')
    const fake = lastPty()
    fake.data!("pi@h3's pass")
    expect(fake.writes).toHaveLength(0)
    fake.data!('word: ')
    expect(fake.writes).toEqual(['pw2\r'])
    fake.exit!({ exitCode: 0 })
    await expect(p).resolves.toBe('completed')
  })

  it('password target: nonzero exit resolves failed', async () => {
    _setSshTargetForTest('sid-fail', { username: 'pi', host: 'h4', port: 22, password: 'x' })
    const p = endSshRemote('sid-fail')
    lastPty().exit!({ exitCode: 255 })
    await expect(p).resolves.toBe('failed')
  })

  it('password target: no prompt ever -> times out failed and kills the child', async () => {
    vi.useFakeTimers()
    try {
      _setSshTargetForTest('sid-hang', { username: 'pi', host: 'h5', port: 22, password: 'x' })
      const p = endSshRemote('sid-hang')
      const fake = lastPty()
      await vi.advanceTimersByTimeAsync(20_001)
      await expect(p).resolves.toBe('failed')
      expect(fake.killed).toBe(true)
      expect(fake.writes).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
