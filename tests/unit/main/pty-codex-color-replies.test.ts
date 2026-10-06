// [host] The real spawnPty with node-pty faked (the mocks are
// pty-conpty-per-provider.test.ts's): a local Codex session's colour query
// (OSC 10/11 `?`) is answered by MAIN the moment the PTY emits it, written
// straight back into that PTY, and kept from the renderer so its xterm.js does
// not answer a second time. Codex waits 100 ms for the answer (codex-rs tui
// terminal_probe.rs DEFAULT_TIMEOUT) and a later one reaches its composer as
// typed text; the renderer's answer was up to 114 ms late on Electron 44 (VM
// runs col-insca*). A Claude session and a plain terminal are untouched: their
// queries reach the renderer exactly as before and main writes nothing.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

interface Spawned { cmd: string; opts: Record<string, unknown>; exit: Array<(e: { exitCode: number }) => void>; emitData: (d: string) => void; writes: string[] }
const h = vi.hoisted(() => ({
  spawned: [] as Spawned[],
  settings: {} as Record<string, unknown>,
  dark: true,
  /** What main's other readers of a Codex session's output were given (round 1 review: the filtered bytes). */
  recorded: [] as Array<[string, number]>,
  fed: [] as Array<[string, string]>,
  screen: [] as Array<[string, string]>,
}))

vi.mock('node-pty', () => ({
  spawn: (cmd: string, _args: unknown, opts: Record<string, unknown>) => {
    const dataCbs: Array<(d: string) => void> = []
    const { EventEmitter } = require('events') as typeof import('events')
    const out = new EventEmitter()
    out.on('error', () => {})
    const p: Spawned = { cmd, opts, exit: [], emitData: (d) => { for (const cb of dataCbs) cb(d) }, writes: [] }
    h.spawned.push(p)
    return {
      pid: 7100 + h.spawned.length,
      process: cmd,
      onData: (cb: (d: string) => void) => { dataCbs.push(cb); return { dispose: () => {} } },
      onExit: (cb: (e: { exitCode: number }) => void) => { p.exit.push(cb); return { dispose: () => {} } },
      write: (d: string) => { p.writes.push(String(d)) },
      resize: () => {},
      kill: vi.fn(),
      _agent: { inSocket: new EventEmitter() },
      on: (ev: string, l: (...a: unknown[]) => void) => { out.on(ev, l) },
    }
  },
}))
vi.mock('../../../src/main/bundled-conpty', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/bundled-conpty')>()),
  bundledConptyChoice: () => ({ kind: 'not-windows', options: { useConpty: true } }),
}))
const TEST_DATA = await vi.hoisted(async () => (await import('../../helpers/test-data-dir')).useTestDataDirectory())
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => os.tmpdir(), getDataDirectory: () => os.tmpdir(), registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { get shouldUseDarkColors() { return h.dark } },
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
    resolveBinary: () => ({ cmd: 'claude', source: 'system' }),
    buildSpawnCommand: (opts: Record<string, any>) => {
      if (!opts.realmLaunch) return { cmd: 'pwsh', args: [], env: {} }
      return { cmd: opts.realmLaunch.executable, args: [], env: { ...opts.realmLaunch.env }, hooksInstalled: false }
    },
    ingestSessionTelemetry: () => ({ stop: () => {}, noteExactRollout: () => null, refuteInferredClaim: () => false, recheckShared: () => true }),
    runScreen: { open: () => {}, feed: (sid: string, d: string) => { h.screen.push([sid, d]) }, resize: () => {}, close: () => {} },
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
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({
  getPtyIntegrityMonitor: () => ({ recordPtyData: (sid: string, n: number) => { h.recorded.push([sid, n]) }, recordResizeApplied: () => {}, resetSession: () => {}, endSession: () => {} }),
}))
vi.mock('../../../src/main/watchdog/watchdog-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/watchdog/watchdog-manager')>()),
  getWatchdogManager: () => ({ startWatchdog: () => {}, stopWatchdog: () => {}, feedData: (sid: string, d: string) => { h.fed.push([sid, String(d)]) }, noteRedrawTrigger: () => {}, noteResize: () => {} }),
}))
vi.mock('../../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/config-manager')>()),
  readConfig: (key: string) => (key === 'settings' ? h.settings : {}),
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
void TEST_DATA

const CX = 'cx0000000000000000000c01'
const CL = 'cl0000000000000000000c01'
const SH = 'sh0000000000000000000c01'
const sent: Array<[string, unknown]> = []
const fakeWin = { isDestroyed: () => false, webContents: { send: (ch: string, d: unknown) => { sent.push([ch, d]) } } } as unknown as Parameters<typeof spawnPty>[0]
const launch = () => ({
  lease: { release: vi.fn(), accountId: 'acct-a' },
  executable: '/proven/a/codex',
  env: { PATH: '/usr/bin' },
  sessionsDir: '/res/codex-realms/a/sessions',
}) as never
const last = (): Spawned => h.spawned[h.spawned.length - 1]
const forwarded = (sid: string) => sent.filter(([ch]) => ch === `pty:data:${sid}`).map(([, d]) => String(d)).join('')
const colourReplies = (p: Spawned) => p.writes.filter((w) => /\x1b\]1[01];rgb:/.test(w))

const ESC = '\x1b'
const ST = `${ESC}\\`
const CODEX_QUERY = `${ESC}]10;?${ST}${ESC}]11;?${ST}`
const DARK_REPLIES = [`${ESC}]10;rgb:eeee/f2f2/f7f7${ST}`, `${ESC}]11;rgb:1717/1e1e/2727${ST}`]
const LIGHT_REPLIES = [`${ESC}]10;rgb:1111/1616/1f1f${ST}`, `${ESC}]11;rgb:e8e8/ecec/f3f3${ST}`]
/** Main's other readers of a session's output (the integrity monitor's byte
 *  count, the Watchdog's pane, the run screen) got exactly what the renderer got. */
const readersSawWhatTheRendererGot = (sid: string) => {
  expect(h.recorded.filter(([s]) => s === sid).reduce((n, [, len]) => n + len, 0)).toBe(forwarded(sid).length)
  expect(h.fed.filter(([s]) => s === sid).map(([, d]) => d).join('')).toBe(forwarded(sid))
  expect(h.screen.filter(([s]) => s === sid).map(([, d]) => d).join('')).toBe(forwarded(sid))
}

beforeEach(() => {
  for (const sid of [CX, CL, SH]) { try { killPty(sid) } catch { /* none */ } }
  for (const p of h.spawned) for (const cb of [...p.exit]) cb({ exitCode: 0 })
  h.spawned = []
  h.settings = {}
  h.dark = true
  h.recorded = []
  h.fed = []
  h.screen = []
  sent.length = 0
})

describe('a local Codex session: main answers its colour query (OSC 10/11)', () => {
  it('the moment the PTY emits it: both answers written into that PTY, the query kept from the renderer, the output around it forwarded', () => {
    spawnPty(fakeWin, CX, { cwd: os.tmpdir(), provider: 'codex', codexLaunch: launch() } as never)
    const p = last()
    expect(p.cmd).toBe('/proven/a/codex')
    p.emitData(`${ESC}[2J${ESC}[1;1Hready`)
    p.emitData(CODEX_QUERY)
    // Synchronously, inside the data event: no timer, no renderer round trip.
    expect(colourReplies(p)).toEqual(DARK_REPLIES)
    p.emitData(`${ESC}[3;1H\u203a Ask Codex`)
    // In each query's place the renderer gets ST alone (it ends what the query's ESC would have ended).
    expect(forwarded(CX)).toBe(`${ESC}[2J${ESC}[1;1Hready${ST}${ST}${ESC}[3;1H\u203a Ask Codex`)
    expect(forwarded(CX)).not.toContain(']10;?')
    expect(forwarded(CX)).not.toContain(']11;?')
    readersSawWhatTheRendererGot(CX)
  })

  it('a query split across PTY chunks: answered once, and neither half reaches the renderer', () => {
    spawnPty(fakeWin, CX, { cwd: os.tmpdir(), provider: 'codex', codexLaunch: launch() } as never)
    const p = last()
    p.emitData('a' + CODEX_QUERY.slice(0, 11))
    expect(colourReplies(p)).toEqual([DARK_REPLIES[0]])
    p.emitData(CODEX_QUERY.slice(11) + 'b')
    expect(colourReplies(p)).toEqual(DARK_REPLIES)
    expect(forwarded(CX)).toBe(`a${ST}${ST}b`)
    // Both chunks held a query AND other bytes: main's other readers got only
    // the other bytes too (round 1 review).
    readersSawWhatTheRendererGot(CX)
  })

  it('in the light theme (and system following a light OS), the light theme\'s colours', () => {
    h.settings = { theme: 'system' }
    h.dark = false
    spawnPty(fakeWin, CX, { cwd: os.tmpdir(), provider: 'codex', codexLaunch: launch() } as never)
    last().emitData(CODEX_QUERY)
    expect(colourReplies(last())).toEqual(LIGHT_REPLIES)
  })

  it('a terminal background main cannot read exactly: the query goes to the renderer untouched, main writes nothing', () => {
    h.settings = { terminal: { background: 'rgb(1, 2, 3)' } }
    spawnPty(fakeWin, CX, { cwd: os.tmpdir(), provider: 'codex', codexLaunch: launch() } as never)
    last().emitData(CODEX_QUERY)
    expect(colourReplies(last())).toEqual([])
    expect(forwarded(CX)).toBe(CODEX_QUERY)
  })

  it('a replaced run\'s late query is neither answered nor forwarded (the generation guard comes first)', () => {
    spawnPty(fakeWin, CX, { cwd: os.tmpdir(), provider: 'codex', codexLaunch: launch() } as never)
    const old = last()
    killPty(CX)
    for (const cb of [...old.exit]) cb({ exitCode: 0 })
    spawnPty(fakeWin, CX, { cwd: os.tmpdir(), provider: 'codex', codexLaunch: launch() } as never)
    sent.length = 0
    old.emitData(CODEX_QUERY)
    expect(colourReplies(old)).toEqual([])
    expect(forwarded(CX)).toBe('')
  })
})

describe('every other local session is untouched: the renderer gets the query, main answers nothing', () => {
  it('a local Claude session', () => {
    spawnPty(fakeWin, CL, { cwd: os.tmpdir() } as never)
    const p = last()
    p.emitData('x' + CODEX_QUERY + 'y')
    expect(forwarded(CL)).toContain('x' + CODEX_QUERY + 'y')
    expect(colourReplies(p)).toEqual([])
  })

  it('a plain terminal, whichever provider its config names', () => {
    for (const provider of ['claude', 'codex'] as const) {
      sent.length = 0
      spawnPty(fakeWin, SH, { cwd: os.tmpdir(), shellOnly: true, provider } as never)
      const p = last()
      p.emitData(CODEX_QUERY)
      expect(forwarded(SH), provider).toContain(CODEX_QUERY)
      expect(colourReplies(p), provider).toEqual([])
      killPty(SH)
    }
  })
})
