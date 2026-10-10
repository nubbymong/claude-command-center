// A session's extra CLI arguments come after the app's own options.
//
// A local Claude Code launch line carries the app's own options (the
// per-session --settings, --mcp-config and --plugin-dir) and the user's extra
// CLI arguments. The user's words come LAST, so an option among them that
// takes a value (`--append-system-prompt`, `--fallback-model`, ...) can never
// take one of the app's options as its value; left without one, Claude Code
// stops and says so. On Windows, where PowerShell reads the line, each of the
// user's words is single-quoted, so PowerShell hands it to Claude Code as
// written. An Ask Conductor launch carries no extra arguments: its
// `-- <question>` stays the last thing on the line. The real spawnPty; the
// per-session files are real temporary files; node-pty records the line.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const UUID = '11111111-2222-3333-4444-555555555555'
const h = vi.hoisted(() => ({ writes: [] as string[], files: { settings: '', mcp: '', plugin: '' } }))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 7600, process: 'x',
    onData: () => ({ dispose: () => {} }), onExit: () => ({ dispose: () => {} }),
    write: (d: string) => { h.writes.push(String(d)) }, resize: () => {}, kill: () => {},
  }),
}))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir(), getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {}, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/spawn-claude-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/spawn-claude-command')>()),
  resolveResumeLaunch: (target?: { uuid: string; cwd: string }) => (target ? { resumeUuid: target.uuid, claudeCwd: target.cwd } : null),
}))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/conductor-mcp-server')>()), getConductorMcpPort: () => 0 }))
vi.mock('../../../src/main/providers', () => ({
  // An Ask question rides the environment (the real builder's CCC_ASK_PROMPT).
  getProvider: () => ({ resolveBinary: () => ({ cmd: 'claude', source: 'system' }), buildSpawnCommand: (o: { askPrompt?: string }) => ({ cmd: 'pwsh', args: [], env: o.askPrompt ? { CCC_ASK_PROMPT: o.askPrompt } : {} }), ingestSessionTelemetry: () => ({ stop: () => {} }) }),
}))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
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
let tmp = ''
let seq = 0
let SID = ''

beforeEach(() => {
  SID = `xargs${String(++seq).padStart(19, '0')}`
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-xargs-order-')))
  h.files.settings = path.join(tmp, 'settings-x.json')
  h.files.mcp = path.join(tmp, 'mcp-x.json')
  h.files.plugin = path.join(tmp, 'plugin')
  fs.writeFileSync(h.files.settings, '{}')
  fs.writeFileSync(h.files.mcp, '{}')
  fs.mkdirSync(h.files.plugin)
  h.writes = []
})
afterEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** The Claude launch line, as written into the PTY once its shell is up. */
const launchLine = async (): Promise<string> => {
  const deadline = Date.now() + 5_000
  while (!h.writes.some((w) => w.includes('--settings')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  return (h.writes.find((w) => w.includes('--settings')) ?? '').replace(/\r$/, '')
}
/** The user's words as this platform's launch line carries them: single-quoted
 *  one by one where PowerShell reads the line (Windows), as typed elsewhere. */
const onLine = (words: string): string =>
  process.platform === 'win32' ? words.split(' ').map((w) => `'${w}'`).join(' ') : words
/** Where each of the app's own options and the user's words sit on the line. */
const positions = (line: string, words: string): { settings: number; mcp: number; plugin: number; words: number } => ({
  settings: line.indexOf(' --settings '),
  mcp: line.indexOf(' --mcp-config '),
  plugin: line.indexOf(' --plugin-dir '),
  words: line.indexOf(` ${onLine(words)}`),
})

describe('a local launch', () => {
  // Mutation to prove this can fail: place the extra args before --settings again.
  it('extra arguments come after the app\'s own options, last on the line', async () => {
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, extraArgs: '--append-system-prompt' })
    const line = await launchLine()
    const at = positions(line, '--append-system-prompt')
    expect(at.settings).toBeGreaterThan(0)
    expect(at.mcp).toBeGreaterThan(at.settings)
    expect(at.plugin).toBeGreaterThan(at.mcp)
    expect(at.words).toBeGreaterThan(at.plugin)
    expect(line.endsWith(` ${onLine('--append-system-prompt')}; exit`)).toBe(true)
  })

  it('on an exact resume too', async () => {
    fs.mkdirSync(path.join(tmp, 'conv'))
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, resume: { uuid: UUID, cwd: path.join(tmp, 'conv') }, extraArgs: '--fallback-model sonnet' })
    const line = await launchLine()
    expect(line).toContain(`--resume ${UUID}`)
    const at = positions(line, '--fallback-model sonnet')
    expect(at.words).toBeGreaterThan(at.plugin)
    expect(line.endsWith(` ${onLine('--fallback-model sonnet')}; exit`)).toBe(true)
  })

  it("each of the user's words reaches the line as one word: single-quoted where PowerShell reads it", async () => {
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, extraArgs: '--allowedTools=Bash,Edit  --add-dir=docs' })
    const line = await launchLine()
    const want = process.platform === 'win32' ? " '--allowedTools=Bash,Edit' '--add-dir=docs'; exit" : ' --allowedTools=Bash,Edit --add-dir=docs; exit'
    expect(line.endsWith(want), line).toBe(true)
  })

  // Mutation to prove this can fail: place the extra args on an Ask launch.
  it('an Ask launch carries no extra arguments; its question stays last', async () => {
    spawnPty(fakeWin, SID, { cols: 100, rows: 30, cwd: tmp, isAsk: true, askPrompt: 'how do I add an account?', extraArgs: '--append-system-prompt' })
    const line = await launchLine()
    expect(line).not.toContain('--append-system-prompt')
    expect(line).toMatch(/ -- \S+; exit$/)
  })
})
