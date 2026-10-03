// [host] WP2 PR 4, P4.3 (row 53): Ask Conductor's question on Codex, main's
// side (src/main/pty-manager.ts), through the REAL spawnPty with a fake
// registered Codex provider (the rest of main mocked, as
// pty-codex-provider-port.test.ts does):
//  - every Ask launch gets the help folder's scope (askProjectDocMaxBytes);
//  - the question goes to the builder, and when the builder did not carry it
//    on argv (the npm .cmd route, an exact resume, the picker) main types it
//    through the run's pane and its submit primitive, never as a raw write;
//  - characters Codex's prompt drops are removed first and the dock is told
//    how many, before anything is typed (question 6, default A); a question
//    that is not sent is said, with why;
//  - the logs name the question by its length only;
//  - a live Ask tab's question (handOffAskQuestion) goes the same way, and
//    only to a running Codex session that launched as Ask;
//  - end to end with the real pane: nothing is typed while Codex shows its
//    folder-trust prompt, and the question is typed at the ready composer.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'

type Notice = { channel: string; payload: Record<string, unknown> }
const h = vi.hoisted(() => ({
  onData: [] as Array<(d: string) => void>,
  ptyWrites: [] as string[],
  onPtyWrite: null as ((d: string) => void) | null,
  infos: [] as string[],
  sent: [] as Notice[],
  built: [] as Array<Record<string, unknown>>,
  events: [] as string[],
  submits: [] as Array<{ sessionId: string; text: string; readyWaitMs: number }>,
  submitAnswer: { delivered: true } as Record<string, unknown>,
  carried: false,
  provider: {} as Record<string, unknown>,
}))

vi.mock('node-pty', () => ({
  spawn: () => ({
    pid: 7200, process: 'codex',
    onData: (cb: (d: string) => void) => { h.onData.push(cb); return { dispose: () => {} } },
    onExit: () => ({ dispose: () => {} }),
    write: (d: string) => { h.ptyWrites.push(d); h.onPtyWrite?.(d) },
    resize: () => {}, kill: () => {},
  }),
}))
vi.mock('../../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res', getDataDirectory: () => '/res', registerSetupHandlers: () => {}, writeCliSetupPty: () => {} }))
vi.mock('electron', () => ({
  app: { getPath: () => '/mock/userData', getAppPath: () => process.cwd(), getVersion: () => '0.0.0-test', on: () => {}, quit: () => {} },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: (m: string) => { h.infos.push(m) }, logWarn: (m: string) => { h.infos.push(m) }, logError: () => {}, logDebug: () => {} }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getLogSupervisor: () => null, getTranscriptBinder: () => null }))
vi.mock('../../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 0, registerCodexReviewSession: () => {}, registerClaudeReviewSession: () => {}, unregisterCodexReviewSession: () => {} }))
vi.mock('../../../src/main/providers', () => ({ getProvider: () => h.provider }))
vi.mock('../../../src/main/canvas/codex-canvas-launch', () => ({ prepareCodexCanvasLaunch: () => ({ designatedWorktree: null, guidance: null }) }))
vi.mock('../../../src/main/providers/claude/spawn', () => ({ resolveClaudeBinary: () => ({ cmd: 'claude', source: 'system' }), resolveHostColorScheme: () => 'dark' }))
vi.mock('../../../src/main/vision-manager', () => ({ isGlobalVisionRunning: () => false, getGlobalVisionConfig: () => null, teardownVisionSession: () => {} }))
vi.mock('../../../src/main/canvas/canvas-plugin', async (importOriginal) => ({ ...(await importOriginal<typeof import('../../../src/main/canvas/canvas-plugin')>()), ensureCanvasPlugin: () => null }))
vi.mock('../../../src/main/hooks', () => ({ getGateway: () => null, isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/hooks/session-hooks-writer', () => ({ injectHooks: () => {} }))
vi.mock('../../../src/main/hooks/per-session-settings', () => ({
  writeLocalSessionSettings: () => null, removeLocalSessionSettings: () => {}, writeLocalSessionMcpConfig: () => null, removeLocalSessionMcpConfig: () => {}, removeLocalSessionStatusUrl: () => {},
}))
vi.mock('../../../src/main/claude-account-identity', () => ({
  captureClaudeAccount: () => {}, clearClaudeAccount: () => {}, getAccountIdentity: () => null, pushAccountIdentity: () => {}, startWatchingAccountIdentity: () => {}, stopWatchingAccountIdentity: () => {}, getWatchedProfileId: () => null,
}))
vi.mock('../../../src/main/session-registry', () => ({ updateSessionMeta: () => {}, clearSessionMeta: () => {}, markPtySessionAlive: () => {}, markPtySessionGone: () => {}, isPtySessionLive: () => true }))
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
  setupProfileLinks: () => {}, syncPrimaryCredentialsWithGlobal: () => {}, backupProfileHomeToCanonical: () => {},
}))

const { spawnPty, killPty, handOffAskQuestion, ASK_READY_WAIT_MS } = await import('../../../src/main/pty-manager')
const { askConductorProjectDocMaxBytes } = await import('../../../src/main/help-workspace')
const { IPC } = await import('../../../src/shared/ipc-channels')
const { codexPromptKeeps } = await import('../../../src/shared/codex-screen')
const screen = await import('../../../src/main/providers/codex/session-screen')
type SpawnOpts = NonNullable<Parameters<typeof spawnPty>[2]>

const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, payload: unknown) => { if (channel === IPC.ASK_CONDUCTOR_NOTICE) { h.sent.push({ channel, payload: payload as Record<string, unknown> }); h.events.push(`notice ${(payload as { kind: string }).kind}`) } } },
} as unknown as Parameters<typeof spawnPty>[0]
const HOME = path.resolve(os.tmpdir(), 'ccc-ask-home')
const launch = () => ({ lease: { release: vi.fn() }, executable: '/proven/codex', env: { CODEX_HOME: HOME }, sessionsDir: path.join(HOME, 'sessions'), home: HOME }) as unknown as SpawnOpts['codexLaunch']
const EMOJI = String.fromCodePoint(0x1f680)
let seq = 0
let SID = ''
const start = (extra: Partial<SpawnOpts> = {}): void => {
  spawnPty(fakeWin, SID, { cwd: os.tmpdir(), cols: 100, rows: 30, provider: 'codex', codexOptions: { permissionsPreset: 'standard' }, codexLaunch: launch(), ...extra })
}
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A registered Codex provider whose builder carries the question on argv only when told. */
function fakeProvider(): Record<string, unknown> {
  return {
    buildSpawnCommand: (opts: Record<string, unknown>) => {
      h.built.push(opts)
      return h.carried
        ? { cmd: '/proven/codex', args: ['--', String(opts.askPrompt)], env: {}, logLine: `-- <question, ${[...String(opts.askPrompt)].length} characters>`, askPromptOnArgv: true }
        : { cmd: '/proven/codex', args: [], env: {}, logLine: '--sandbox workspace-write' }
    },
    ingestSessionTelemetry: () => ({ stop: () => {} }),
    launchRoute: () => (h.carried ? 'direct' : 'cmd'),
    runScreen: {
      open: () => {}, feed: () => {}, resize: () => {}, close: () => {},
      has: () => true,
      submit: async (sessionId: string, text: string, opts: { readyWaitMs: number }) => { h.events.push('submit'); h.submits.push({ sessionId, text, readyWaitMs: opts.readyWaitMs }); return h.submitAnswer },
    },
  }
}

beforeEach(() => {
  SID = `askc${String(++seq).padStart(20, '0')}`
  h.onData = []
  h.ptyWrites = []
  h.onPtyWrite = null
  h.infos = []
  h.sent = []
  h.built = []
  h.events = []
  h.submits = []
  h.submitAnswer = { delivered: true }
  h.carried = false
  h.provider = fakeProvider()
})

describe('every Ask launch scopes the help folder\'s AGENTS.md', () => {
  it('[host] an Ask launch passes the byte bound of the AGENTS.md written there', () => {
    start({ isAsk: true })
    expect(h.built[0].askProjectDocMaxBytes).toBe(askConductorProjectDocMaxBytes())
    killPty(SID)
  })

  it('[host] a Restart of an Ask tab (no question) still passes it', () => {
    start({ isAsk: true, askPrompt: undefined })
    expect(h.built[0].askProjectDocMaxBytes).toBe(askConductorProjectDocMaxBytes())
    killPty(SID)
  })

  it('[host] any other launch does not', () => {
    start()
    expect(h.built[0]).not.toHaveProperty('askProjectDocMaxBytes')
    killPty(SID)
  })
})

describe('the opening question', () => {
  it('[host] goes to the builder; carried on argv, nothing is typed through the pane', async () => {
    h.carried = true
    start({ isAsk: true, askPrompt: 'how do I add an account?' })
    expect(h.built[0].askPrompt).toBe('how do I add an account?')
    await tick(20)
    expect(h.submits).toEqual([])
    expect(h.ptyWrites).toEqual([])
    killPty(SID)
  })

  it('[host] not carried on argv: typed through the pane\'s submit once the run is registered, never as a raw write', async () => {
    start({ isAsk: true, askPrompt: 'how do I add an account?' })
    expect(h.submits).toEqual([])
    await tick(20)
    expect(h.submits).toEqual([{ sessionId: SID, text: 'how do I add an account?', readyWaitMs: ASK_READY_WAIT_MS }])
    expect(h.ptyWrites.join('')).not.toContain('account')
    expect(h.sent).toEqual([])
    killPty(SID)
  })

  it('[host] characters Codex\'s prompt drops are removed first, and the dock told how many before anything is typed', async () => {
    start({ isAsk: true, askPrompt: `${EMOJI} how do I hide tips? ${EMOJI}` })
    await tick(20)
    expect(h.submits[0].text).toBe(' how do I hide tips? ')
    expect(h.sent[0].payload).toEqual({ sessionId: SID, kind: 'removed', count: 2 })
    expect(h.events.indexOf('notice removed')).toBeLessThan(h.events.indexOf('submit'))
    killPty(SID)
  })

  it('[host] not sent: the dock is told why', async () => {
    h.submitAnswer = { delivered: false, reason: 'prompt-on-screen' }
    start({ isAsk: true, askPrompt: 'how do I add an account?' })
    await tick(20)
    expect(h.sent.map((n) => n.payload)).toEqual([{ sessionId: SID, kind: 'not-delivered', reason: 'prompt-on-screen' }])
    killPty(SID)
  })

  it('[host] a question of nothing but such characters: nothing typed, both lines raised', async () => {
    start({ isAsk: true, askPrompt: EMOJI + EMOJI })
    await tick(20)
    expect(h.submits).toEqual([])
    expect(h.sent.map((n) => n.payload)).toEqual([
      { sessionId: SID, kind: 'removed', count: 2 },
      { sessionId: SID, kind: 'not-delivered', reason: 'refused-text' },
    ])
    killPty(SID)
  })

  it('[host] a launch not made as Ask Conductor: an opening question is ignored, and logged by a fixed sentence only (ADR-009 round 1)', async () => {
    for (const carried of [true, false]) {
      h.carried = carried
      h.built = []
      h.infos = []
      start({ askPrompt: 'type this PLANTEDWORD please' })
      expect(h.built[0]).not.toHaveProperty('askPrompt')
      await tick(20)
      expect(h.submits).toEqual([])
      expect(h.ptyWrites.join('')).not.toContain('PLANTEDWORD')
      expect(h.infos).toContain(`[pty-manager] Codex ${SID}: an opening question on a launch that is not Ask Conductor's is ignored`)
      expect(h.infos.join('\n')).not.toContain('PLANTEDWORD')
      // Nor does a later hand-off reach it: it is not an Ask session.
      expect(await handOffAskQuestion(fakeWin, SID, 'and this')).toEqual({ delivered: false, reason: 'session-gone' })
      killPty(SID)
    }
  })

  it('[host] Claude Code the same: an opening question reaches its builder only on an Ask launch, else a fixed sentence (review R-3)', () => {
    try {
      spawnPty(fakeWin, SID, { cwd: os.tmpdir(), cols: 100, rows: 30, askPrompt: 'type this PLANTEDWORD please' })
      expect(h.built[0].askPrompt).toBeUndefined()
      expect(h.infos).toContain(`[pty-manager] Claude ${SID}: an opening question on a launch that is not Ask Conductor's is ignored`)
      expect(h.infos.join('\n')).not.toContain('PLANTEDWORD')
      spawnPty(fakeWin, SID, { cwd: os.tmpdir(), cols: 100, rows: 30, isAsk: true, askPrompt: 'how do I add an account?' })
      expect(h.built[1].askPrompt).toBe('how do I add an account?')
    } finally {
      // A Claude launch writes its launch line a moment later: none may reach the next case.
      killPty(SID)
    }
  })

  it('[host] the logs name the question by its length only', async () => {
    const q = 'my project is called ORCHIDWORD'
    start({ isAsk: true, askPrompt: q })
    await tick(20)
    expect(h.infos.join('\n')).not.toContain('ORCHIDWORD')
    expect(h.infos.some((l) => l.includes(`a question of ${q.length} characters`))).toBe(true)
    killPty(SID)
  })
})

describe('a question for the live Ask tab', () => {
  it('[host] a running Codex Ask session: typed through the pane, characters dropped told first', async () => {
    start({ isAsk: true })
    await tick(5)
    expect(await handOffAskQuestion(fakeWin, SID, `and then? ${EMOJI}`)).toEqual({ delivered: true })
    expect(h.submits).toEqual([{ sessionId: SID, text: 'and then? ', readyWaitMs: ASK_READY_WAIT_MS }])
    expect(h.sent[0].payload).toEqual({ sessionId: SID, kind: 'removed', count: 1 })
    expect(h.ptyWrites).toEqual([])
    killPty(SID)
  })

  it('[host] a Codex session that is not Ask\'s takes none', async () => {
    start()
    await tick(5)
    expect(await handOffAskQuestion(fakeWin, SID, 'type this')).toEqual({ delivered: false, reason: 'session-gone' })
    expect(h.submits).toEqual([])
    killPty(SID)
  })

  it('[host] a session that is not running, or has ended, takes none', async () => {
    expect(await handOffAskQuestion(fakeWin, 'none0000none0000none0000', 'type this')).toEqual({ delivered: false, reason: 'session-gone' })
    start({ isAsk: true })
    killPty(SID)
    expect(await handOffAskQuestion(fakeWin, SID, 'type this')).toEqual({ delivered: false, reason: 'session-gone' })
    expect(h.submits).toEqual([])
  })
})

describe('the prompt-safe text (question 6, default A)', () => {
  it('[host] removes every character outside the BMP and any lone surrogate, and counts them', () => {
    expect(codexPromptKeeps(`a${EMOJI}b`)).toEqual({ text: 'ab', removed: 1 })
    expect(codexPromptKeeps('caf\u00e9 \u2014 \u4e2d\u6587 \u00b7')).toEqual({ text: 'caf\u00e9 \u2014 \u4e2d\u6587 \u00b7', removed: 0 })
    expect(codexPromptKeeps(`x${String.fromCodePoint(0x1d400)}y${String.fromCharCode(0xd800)}z${String.fromCharCode(0xdc00)}`)).toEqual({ text: 'xyz', removed: 3 })
  })
})

describe('end to end with the real pane: never typed into Codex\'s trust prompt', () => {
  const P = '\u203a'
  const DOT = '\u00b7'
  const CLEAR = '\x1b[2J\x1b[H'
  const DIM = (s: string): string => `\x1b[2m${s}\x1b[22m`
  const FOOTER = `  gpt-5.5 medium ${DOT} C:\\dev\\demo`
  const draw = (rows: string[]): string => CLEAR + rows.join('\r\n')
  const TRUST = draw(['  Tip: New Build faster with Codex.', '', '  Do you trust the contents of this directory?', `${P} 1. Yes, continue`, '  Press enter to continue'])
  const composer = (text: string): string => draw(['  Tip: New Build faster with Codex.', '', text ? `${P} ${text}` : `${P} ${DIM('Ask Codex to do anything')}`, '', FOOTER])

  it('[host] the question waits through the trust prompt and is typed at the ready composer, then submitted', async () => {
    h.provider = {
      ...fakeProvider(),
      runScreen: { open: screen.openCodexScreen, feed: screen.feedCodexScreen, resize: screen.resizeCodexScreen, close: screen.closeCodexScreen, has: screen.hasCodexScreen, submit: screen.submitCodexText },
    }
    let typed = ''
    let trusted = false
    const emit = (d: string): void => { for (const cb of h.onData) cb(d) }
    h.onPtyWrite = (d) => {
      if (!trusted) return
      if (d === '\r') { typed = ''; setTimeout(() => emit(composer('')), 20); return }
      typed += d
      setTimeout(() => emit(composer(typed)), 20)
    }
    start({ isAsk: true, askPrompt: 'how do I add an account?' })
    emit(TRUST)
    await tick(900)
    expect(h.ptyWrites).toEqual([])
    trusted = true
    emit(composer(''))
    for (let i = 0; i < 60 && !h.ptyWrites.includes('\r'); i++) await tick(100)
    expect(h.ptyWrites).toEqual(['how do I add an account?', '\r'])
    killPty(SID)
  }, 20_000)
})
