// A local Claude session's agent templates, as the one object keyed by name
// that Claude Code's --agents takes: on Windows in the session's environment,
// written for the program its launch line starts, with only a reference to
// them on the line; elsewhere on the line, single-quoted. A set Claude Code
// would not take, or one too long for the command line, is refused with the
// reason. The real spawnPty; node-pty records the environment and the line.
// See agents-env-launch.test.ts for why, and for the value's own rule.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AGENTS_ENV, agentsEnvValue } from '../../../src/main/terminal-launch-line'
import { quoteArgForShell } from '../../../src/main/spawn-claude-command'

const UUID = '11111111-2222-3333-4444-555555555555'
const h = vi.hoisted(() => ({
  writes: [] as string[], envs: [] as Array<Record<string, string>>,
  files: { settings: '', mcp: '', plugin: '' }, res: '', bin: 'claude',
}))

vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], opts: { env: Record<string, string> }) => {
    h.envs.push({ ...opts.env })
    return {
      pid: 7601, process: 'x',
      onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }),
      write: (d: string) => { h.writes.push(String(d)) }, resize: () => {}, kill: () => {},
    }
  },
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => h.res, getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()),
  resolveResumeLaunch: (target?: { uuid: string; cwd: string }) => (target ? { resumeUuid: target.uuid, claudeCwd: target.cwd } : null),
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
vi.mock('../../../src/main/providers', () => ({
  getProvider: () => ({ resolveBinary: () => ({ cmd: h.bin, source: 'system' }), buildSpawnCommand: () => ({ cmd: 'pwsh', args: [], env: {} }), ingestSessionTelemetry: () => ({ stop: () => {} }) }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: h.bin, source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', () => ({ ensureCanvasPlugin: () => h.files.plugin }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => h.files.settings, removeLocalSessionSettings: () => {},
  writeLocalSessionMcpConfig: () => h.files.mcp, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => null }))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: () => ({}),
  readConfigChecked: (key: string) => ({ value: key === 'settings' ? {} : {}, outcome: 'ok' }),
  getConfigDir: () => os.tmpdir(),
}))
vi.mock('../../../src/main/account-profiles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/account-profiles')>()),
  isValidProfileId: () => false,
  getPrimaryProfileId: () => null,
  getProfileConfigDir: () => path.join(os.tmpdir(), 'ccc-no-such-profile'),
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
}))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')

const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } } as unknown as Parameters<typeof spawnPty>[0]
const WIN = process.platform === 'win32'
const LEAD = "$PSNativeCommandArgumentPassing = 'Legacy'; "
const TEMPLATES = [
  { name: 'reviewer', description: 'checks (a) & (b) | c > d < e ^ f, "quoted"', prompt: 'review 100% of it, then say done!' },
  { name: 'writer', description: 'caf\u00e9 \u4e2d\u6587', prompt: 'C:\\temp\\', tools: ['Read'] },
]
/** What Claude Code's --agents gets for TEMPLATES: one object keyed by name. */
const AGENTS = {
  reviewer: { description: 'checks (a) & (b) | c > d < e ^ f, "quoted"', prompt: 'review 100% of it, then say done!' },
  writer: { description: 'caf\u00e9 \u4e2d\u6587', prompt: 'C:\\temp\\', tools: ['Read'] },
}
let tmp = ''
let seq = 0
let SID = ''

beforeEach(() => {
  SID = `agents${String(++seq).padStart(18, '0')}`
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-agents-env-')))
  h.files.settings = path.join(tmp, 'settings-x.json')
  h.files.mcp = path.join(tmp, 'mcp-x.json')
  h.files.plugin = path.join(tmp, 'plugin')
  h.res = path.join(tmp, 'res')
  fs.writeFileSync(h.files.settings, '{}')
  fs.writeFileSync(h.files.mcp, '{}')
  fs.mkdirSync(h.files.plugin)
  fs.mkdirSync(path.join(h.res, 'scripts'), { recursive: true })
  h.bin = WIN ? 'C:\\Users\\Jo Smith\\.local\\bin\\claude.exe' : 'claude'
  h.writes = []
  h.envs = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** The Claude launch line, as written into the PTY once its shell is up, and
 *  the environment the PTY was started with. */
const launched = async (): Promise<{ line: string; env: Record<string, string> }> => {
  const deadline = Date.now() + 5_000
  while (!h.writes.some((w) => w.includes('--settings')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  return { line: (h.writes.find((w) => w.includes('--settings')) ?? '').replace(/\r$/, ''), env: h.envs[h.envs.length - 1] ?? {} }
}
const withPicker = (): void => { fs.writeFileSync(path.join(h.res, 'scripts', 'resume-picker.js'), '// picker\n') }

describe('a local Claude launch with agent templates', () => {
  // Mutation to prove this can fail: put the templates back on the Windows line.
  it('direct: on Windows the value for Claude Code itself is in the environment and the line names it only', async () => {
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, agentsConfig: TEMPLATES })
    const { line, env } = await launched()
    expect(line).toContain(' --settings ')
    if (WIN) {
      expect(env[AGENTS_ENV]).toBe(agentsEnvValue(AGENTS, h.bin))
      expect(line.startsWith(LEAD), line).toBe(true)
      expect(line).toContain(`& '${h.bin}' --agents \${env:CCC_AGENTS} --settings `)
      for (const t of TEMPLATES) expect(line).not.toContain(t.description)
    } else {
      expect(env[AGENTS_ENV]).toBeUndefined()
      expect(line).toContain(`'claude' --agents ${quoteArgForShell(JSON.stringify(AGENTS), false)} --settings `)
    }
  })

  it('resume picker: the value is written for node, which the line starts', async () => {
    withPicker()
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, agentsConfig: TEMPLATES, useResumePicker: true })
    const { line, env } = await launched()
    expect(line).toContain(`node ${quoteArgForShell(path.join(h.res, 'scripts', 'resume-picker.js'), WIN)} --agents `)
    if (WIN) {
      expect(env[AGENTS_ENV]).toBe(agentsEnvValue(AGENTS, 'node'))
      expect(env[AGENTS_ENV]).not.toBe(agentsEnvValue(AGENTS, h.bin))
      expect(line).toContain(' --agents ${env:CCC_AGENTS} --settings ')
    } else {
      expect(env[AGENTS_ENV]).toBeUndefined()
    }
  })

  it('an exact resume bypasses the picker: the value is written for Claude Code', async () => {
    withPicker()
    fs.mkdirSync(path.join(tmp, 'conv'))
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, agentsConfig: TEMPLATES, useResumePicker: true, resume: { uuid: UUID, cwd: path.join(tmp, 'conv') } })
    const { line, env } = await launched()
    expect(line).toContain(`--resume ${UUID} --agents `)
    if (WIN) expect(env[AGENTS_ENV]).toBe(agentsEnvValue(AGENTS, h.bin))
  })

  it('an npm launcher gets the value cmd.exe reads as text', async () => {
    if (WIN) h.bin = 'C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\claude.cmd'
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, agentsConfig: TEMPLATES })
    const { env } = await launched()
    if (WIN) {
      expect(env[AGENTS_ENV]).toBe(agentsEnvValue(AGENTS, h.bin))
      expect(env[AGENTS_ENV].startsWith('"')).toBe(true)
    }
  })

  it('without templates: no variable, and the line is as before', async () => {
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp })
    const { line, env } = await launched()
    expect(env[AGENTS_ENV]).toBeUndefined()
    expect(line).not.toContain('--agents')
    expect(line).not.toContain('PSNativeCommandArgumentPassing')
    expect(line.startsWith(WIN ? 'Set-Location ' : 'cd ')).toBe(true)
  })

  it('a set Claude Code would not take is refused before anything starts', () => {
    expect(() => spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, agentsConfig: [TEMPLATES[0], TEMPLATES[1], TEMPLATES[0]] }))
      .toThrow('Cannot start Claude Code with these agent templates: templates 1 and 3 have the same name.')
    expect(h.envs).toHaveLength(0)
    expect(h.writes).toEqual([])
  })

  it.runIf(WIN)('Windows: templates too long for npm\'s launcher are refused with the reason, and the line is never written', async () => {
    const big = [{ name: 'big', description: 'd', prompt: 'x'.repeat(9_000) }]
    h.bin = 'C:\\Users\\Jo Smith\\AppData\\Roaming\\npm\\claude.cmd'
    expect(() => spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, agentsConfig: big }))
      .toThrow('and Windows allows 8191 there. Shorten the templates, or install the native Claude Code.')
    await new Promise((r) => setTimeout(r, 500))
    expect(h.writes.filter((w) => w.includes('--agents'))).toEqual([])
    // The same templates for a native Claude Code fit its longer command line.
    killPty(SID)
    h.bin = 'C:\\Users\\Jo Smith\\.local\\bin\\claude.exe'
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, agentsConfig: big })
    const { line, env } = await launched()
    expect(line).toContain(' --agents ${env:CCC_AGENTS} --settings ')
    expect(env[AGENTS_ENV]).toBe(agentsEnvValue({ big: { description: 'd', prompt: 'x'.repeat(9_000) } }, h.bin))
  })
})
