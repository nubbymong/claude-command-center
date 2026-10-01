// P3.15 (row 71): a local Codex session on Windows runs under node-pty's
// bundled ConPTY (its conpty.dll and OpenConsole.exe, the console host Windows
// Terminal ships), because the ConPTY built into Windows repaints Codex's
// screen in place and leaves the terminal no scrollback (the P3.15 VM run:
// 38 lines kept, the wheel inert; 122 kept and the wheel scrolling under the
// bundled one). Nothing else changes: a Claude session, a plain terminal (of
// either provider) and an SSH session keep the system ConPTY with exactly the
// options they had. When the bundled files are missing, the Codex session
// falls back to the system ConPTY, and its launch line says which it got.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface Spawned { cmd: string; opts: Record<string, unknown>; exit: Array<(e: { exitCode: number }) => void> }
const h = vi.hoisted(() => ({
  spawned: [] as Spawned[],
  infos: [] as string[],
  choice: { kind: 'bundled', options: { useConpty: true, useConptyDll: true }, dir: '/np/prebuilds/win32-x64' } as Record<string, unknown>,
  choiceCalls: 0,
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string, _args: unknown, opts: Record<string, unknown>) => {
    const p: Spawned = { cmd, opts, exit: [] }
    h.spawned.push(p)
    return {
      pid: 7000 + h.spawned.length,
      process: cmd,
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: () => {},
    }
  },
}))
vi.mock('../../../src/main/bundled-conpty', () => ({
  bundledConptyChoice: () => { h.choiceCalls++; return h.choice },
}))
vi.mock('../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/debug-logger')>()),
  logInfo: (...a: unknown[]) => { h.infos.push(a.map(String).join(' ')) },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir(), getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({
  getConductorMcpPort: () => 0,
  issueMcpSessionToken: () => 'tok',
  registerCodexReviewSession: () => {},
  registerClaudeReviewSession: () => {},
  unregisterCodexReviewSession: () => {},
  disposeCodexReviewUsage: () => {},
}))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({
    buildSpawnCommand: (opts: Record<string, any>) => {
      // Only a Codex launch carries its realm (the Claude branch asks for its shell).
      if (!opts.realmLaunch) return { cmd: 'pwsh', args: [], env: {} }
      return { cmd: opts.realmLaunch.executable, args: [], env: { ...opts.realmLaunch.env }, hooksInstalled: false }
    },
    ingestSessionTelemetry: () => ({ stop: () => {}, noteExactRollout: () => null, refuteInferredClaim: () => false, recheckShared: () => true }),
  }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({
  getGateway: () => ({ status: () => ({ enabled: false, listening: false, port: null }), registerSession: () => 'x', unregisterSession: () => {} }),
  isExactBindSourceActive: () => true,
}))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => '/nonexistent/settings.json',
  removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => '/nonexistent/mcp.json',
  removeLocalSessionMcpConfig: () => {},
  removeLocalSessionStatusUrl: () => {},
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
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {} }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/watchdog/watchdog-manager', () => ({
  getWatchdogManager: () => ({ startWatchdog: () => {}, stopWatchdog: () => {}, feedData: () => {}, noteRedrawTrigger: () => {}, noteResize: () => {} }),
}))
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
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: async () => ({ ok: true }) }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))
vi.mock('../../../src/main/provider-accounts', () => ({ getAccountsService: () => null }))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')

const CX = 'cx0000000000000000000315'
const CL = 'cl0000000000000000000315'
const SH = 'sh0000000000000000000315'
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const launch = () => ({
  lease: { release: vi.fn(), accountId: 'acct-a' },
  executable: '/proven/a/codex',
  env: { PATH: '/usr/bin' },
  sessionsDir: '/res/codex-realms/a/sessions',
}) as never
const startCodex = () => spawnPty(fakeWin, CX, { cwd: os.tmpdir(), provider: 'codex', codexLaunch: launch() } as never)
const last = (): Spawned => h.spawned[h.spawned.length - 1]
/** What every PTY but a local Codex session's has always been given. */
const SYSTEM_OPTION_KEYS = ['cols', 'cwd', 'env', 'name', 'rows', 'useConpty']

beforeEach(() => {
  for (const sid of [CX, CL, SH]) { try { killPty(sid) } catch { /* none */ } }
  for (const p of h.spawned) for (const cb of [...p.exit]) cb({ exitCode: 0 })
  h.spawned = []
  h.infos = []
  h.choiceCalls = 0
  h.choice = { kind: 'bundled', options: { useConpty: true, useConptyDll: true }, dir: '/np/prebuilds/win32-x64' }
})

describe('the ConPTY each kind of session runs under (P3.15, row 71)', () => {
  it('a local Codex session asks node-pty for its bundled ConPTY when it is there, and its launch line says so', () => {
    startCodex()
    expect(last().cmd).toBe('/proven/a/codex')
    expect(last().opts.useConpty).toBe(true)
    expect(last().opts.useConptyDll).toBe(true)
    expect(h.infos.find((l) => l.includes('Launching Codex PTY'))).toMatch(/conpty=bundled\b/)
  })

  it('falls back to the system ConPTY (no useConptyDll at all) when the bundled files are missing, and the launch line gives the reason', () => {
    h.choice = { kind: 'system', options: { useConpty: true }, reason: 'C:\\np\\prebuilds\\win32-x64\\conpty\\conpty.dll is missing' }
    startCodex()
    expect(last().opts.useConpty).toBe(true)
    expect('useConptyDll' in last().opts).toBe(false)
    expect(Object.keys(last().opts).sort()).toEqual(SYSTEM_OPTION_KEYS)
    expect(h.infos.find((l) => l.includes('Launching Codex PTY'))).toContain('conpty=system (C:\\np\\prebuilds\\win32-x64\\conpty\\conpty.dll is missing)')
  })

  it('off Windows the Codex options are what they always were, and the launch line names no ConPTY', () => {
    h.choice = { kind: 'not-windows', options: { useConpty: true } }
    startCodex()
    expect(Object.keys(last().opts).sort()).toEqual(SYSTEM_OPTION_KEYS)
    expect(h.infos.find((l) => l.includes('Launching Codex PTY'))).not.toMatch(/conpty=/)
  })

  it('a local Claude session keeps the system ConPTY, with exactly the options it had, whatever the bundled choice', () => {
    spawnPty(fakeWin, CL, { cwd: os.tmpdir() } as never)
    expect(h.spawned.length).toBe(1)
    expect(last().opts.useConpty).toBe(true)
    expect(Object.keys(last().opts).sort()).toEqual(SYSTEM_OPTION_KEYS)
    expect(h.choiceCalls).toBe(0)
  })

  it('a plain terminal keeps the system ConPTY, whichever provider its config names', () => {
    for (const provider of ['claude', 'codex'] as const) {
      h.spawned = []
      spawnPty(fakeWin, SH, { cwd: os.tmpdir(), shellOnly: true, provider } as never)
      expect(last().opts.useConpty, provider).toBe(true)
      expect(Object.keys(last().opts).sort(), provider).toEqual(SYSTEM_OPTION_KEYS)
      killPty(SH)
    }
    expect(h.choiceCalls).toBe(0)
  })
})
