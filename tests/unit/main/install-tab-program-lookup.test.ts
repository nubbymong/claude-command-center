// The install or update tab finds what its line starts only in the folders
// PATH names in full.
//
// The tab the app opens to run its own install or update line
// (openCommandTerminal) carries terminalOptions.noCommandSecrets. The REAL
// spawnPty hands that mark to the session's spawn builder as
// fullyQualifiedLookup, which on Windows keeps the tab's program lookup to the
// folders PATH names in full (session-launch-env.test.ts covers the builder;
// install-tab-command-secrets.test.ts the leg from the renderer to spawnPty).
// Any other terminal tab, and any session that is not a terminal tab, gets no
// such mark. node-pty records; nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  built: [] as Array<Record<string, unknown>>,
  writes: [] as string[],
}))

vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>()
  return { ...real, platform: () => 'linux' as NodeJS.Platform, default: { ...real, platform: () => 'linux' as NodeJS.Platform } }
})
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on() {} },
  app: { getPath: () => process.env.TEMP },
}))
vi.mock('node-pty', () => ({ spawn: (file: string) => ({
  pid: 4747, cols: 80, rows: 24, process: file,
  onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
  write: (d: string) => { h.writes.push(String(d)) }, resize() {}, kill() {}, pause() {}, resume() {}, clear() {},
}) }))
vi.mock('../../../src/main/login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/login-shell')>()),
  localSessionShell: () => '/bin/bash',
}))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { registerFakeClaudePackage } = await import('../../helpers/claude-package')

const win = { webContents: { send: () => {} }, isDestroyed: () => false } as never
// The shape of the npm line main builds for the tab (recipeRunLine); the package is a stand-in.
const RUN_LINE = "npm.cmd 'install' '-g' '@example/cli'"
let folder = ''
let seq = 0
let SID = ''

beforeEach(() => {
  vi.useFakeTimers()
  SID = `lookuptab${String(++seq).padStart(15, '0')}`
  folder = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-tab-lookup-')))
  h.built = []
  h.writes = []
  // A Claude session resolves its program; a terminal tab never asks.
  registerFakeClaudePackage({ id: 'claude', displayName: 'Claude', resolveBinary: () => ({ cmd: '/opt/test-only/claude', args: [] }),
    buildSpawnCommand: (opts: Record<string, unknown>) => { h.built.push(opts); return { cmd: '/bin/bash', args: ['-l'], env: {} } },
    detectUiRunning: () => false,
    ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
    resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {},
    getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '' } as never)
})
afterEach(() => {
  try { killPty(SID) } catch { /* not started */ }
  vi.useRealTimers()
  if (path.dirname(folder) === os.tmpdir() && /^ccc-tab-lookup-/.test(path.basename(folder))) fs.rmSync(folder, { recursive: true, force: true })
})

const open = (options: Record<string, unknown>): Record<string, unknown> => {
  spawnPty(win, SID, { cwd: folder, ...options } as never)
  vi.advanceTimersByTime(400)
  expect(h.built.length).toBe(1)
  return h.built[0]
}

describe('the spawn builder is told which tab is the install or update tab', () => {
  // Mutation to prove this can fail: pass fullyQualifiedLookup as undefined.
  it('the install or update tab: marked, and its line is still typed as built', () => {
    const opts = open({ shellOnly: true, terminalOptions: { command: RUN_LINE, elevated: false, noCommandSecrets: true } })
    expect(opts.fullyQualifiedLookup).toBe(true)
    expect(opts.shellOnly).toBe(true)
    expect(h.writes).toContain(`${RUN_LINE}\r`)
  })

  it('its Restart, a plain shell that keeps the mark with the command spent: still marked', () => {
    const opts = open({ shellOnly: true, terminalOptions: { elevated: false, noCommandSecrets: true } })
    expect(opts.fullyQualifiedLookup).toBe(true)
  })

  it('a terminal tab the user opens, with or without a first-run command: not marked', () => {
    expect(open({ shellOnly: true, terminalOptions: { command: 'htop' } }).fullyQualifiedLookup).toBe(false)
  })

  it('a terminal tab with no options at all: not marked', () => {
    expect(open({ shellOnly: true }).fullyQualifiedLookup).toBe(false)
  })

  it('a session that is not a terminal tab is never marked, whatever its options say', () => {
    expect(open({ terminalOptions: { noCommandSecrets: true } }).fullyQualifiedLookup).toBe(false)
  })
})
