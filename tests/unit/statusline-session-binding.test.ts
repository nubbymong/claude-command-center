// Status updates are taken only for the session that sent them.
//
// Two deliveries are taken only for their own session: the status sentinel
// an SSH session's remote prints into that session's terminal stream, and the
// per-session status file `<resources>/status/<id>.json` the local bridge
// writes when the MCP route is not available. Each knows which session it
// belongs to (the terminal it arrived on, the file it was written to), so a
// payload naming any other session reaches no consumer: not the renderer's
// status bar, not the usage figure, not the transcript binder. A payload
// naming its own session flows as before. The real spawnPty SSH branch and
// the real watcher; node-pty and Electron faked.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  ptys: [] as Array<{ emitData: (d: string) => void }>,
  sent: [] as Array<[string, unknown]>,
  resDir: '',
  /** Every warning the code under test logged. */
  warned: [] as string[],
}))

vi.mock('node-pty', () => ({
  spawn: () => {
    const { EventEmitter } = require('events') as typeof import('events')
    const out = new EventEmitter()
    out.on('error', () => {})
    const dataCbs: Array<(d: string) => void> = []
    h.ptys.push({ emitData: (d: string) => { for (const cb of dataCbs) cb(d) } })
    return {
      pid: 4545,
      process: 'ssh',
      onData: (cb: (d: string) => void) => { dataCbs.push(cb); return { dispose: () => {} } },
      onExit: () => ({ dispose: () => {} }),
      write: () => {},
      resize: () => {},
      kill: () => {},
      on: (ev: string, l: (...a: unknown[]) => void) => { out.on(ev, l) },
      _agent: { inSocket: new EventEmitter() },
    }
  },
}))
vi.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir(), getAppPath: () => process.cwd(), on: () => {}, quit: () => {}, isPackaged: false },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: true },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: () => {} },
}))
// A real temporary resources folder: the watcher makes <resources>/status.
vi.mock('../../src/main/ipc/setup-handlers', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/main/ipc/setup-handlers')>()
  const nodeOs = require('os') as typeof import('os')
  const nodeFs = require('fs') as typeof import('fs')
  const nodePath = require('path') as typeof import('path')
  h.resDir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-status-binding-'))
  return { ...real, getResourcesDirectory: () => h.resDir }
})
vi.mock('../../src/main/account-color', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/account-color')>()),
  decorateStatuslineWithColour: (d: unknown) => d,
}))
vi.mock('../../src/main/sentinel/index', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/sentinel/index')>()),
  sentinelObserve: () => {},
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: (...a: unknown[]) => { h.warned.push(a.map(String).join(' ')) }, logError: () => {}, logDebug: () => {} }))

const { spawnPty, killPty } = await import('../../src/main/pty-manager')
const watcher = await import('../../src/main/statusline-watcher')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')

const sshProvider = Object.assign(Object.create(ClaudeProvider.prototype) as object, {
  id: 'claude', displayName: 'Claude',
  resolveBinary: () => null,
  buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  ingestSessionTelemetry: () => ({ stop() {} }),
  listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }),
  configureMcpServer: async () => {},
  getSshSettingsPath: () => '',
  getSshMcpConfigPath: () => '',
  configureRemoteSettings: () => '',
  deliverStatusline: () => {},
})
const fakeWin = { webContents: { send: (ch: string, d: unknown) => { h.sent.push([ch, d]) } }, isDestroyed: () => false } as never

const usage: string[] = []
const transcripts: string[] = []
/** The sessions every consumer was handed a status update for. */
const reached = (): { renderer: string[]; usage: string[]; transcripts: string[] } => ({
  renderer: h.sent.filter(([ch]) => ch === 'statusline:update').map(([, d]) => String((d as { sessionId?: unknown }).sessionId)),
  usage: [...usage],
  transcripts: [...transcripts],
})
const payload = (sessionId: string): Record<string, unknown> => ({
  sessionId,
  model: 'm',
  transcriptPath: `/transcripts/${sessionId}.jsonl`,
  usageBuckets: [{ key: 'session:', label: '5h', group: 'session', percent: 7, resetsAt: '', severity: 'normal' }],
})
const ch = (code: number): string => String.fromCharCode(code)
/** The status sentinel as a remote prints it into its terminal stream. */
const sentinel = (body: Record<string, unknown>): string => `${ch(27)}]9999;CMSTATUS=${JSON.stringify(body)}${ch(7)}`

let stopWatcher: (() => void) | null = null
beforeAll(() => {
  registerProvider(sshProvider as never)
  stopWatcher = watcher.startStatuslineWatcher(() => fakeWin)
  watcher.setStatuslineUsageSink((sessionId) => { usage.push(sessionId) })
  watcher.setTranscriptPathSink((sessionId) => { transcripts.push(sessionId) })
})
afterAll(() => {
  stopWatcher?.()
  try { fs.rmSync(h.resDir, { recursive: true, force: true }) } catch { /* best-effort */ }
})
beforeEach(() => {
  h.sent.length = 0
  usage.length = 0
  transcripts.length = 0
})

describe('an SSH session\'s status sentinel', () => {
  const OWN = 'statusbindowna000000001'
  const OTHER = 'statusbindothr000000002'
  // Every case's session ends here, so a failed case leaves nothing running.
  afterEach(() => { try { killPty(OWN) } catch { /* gone */ } })

  it('a status update naming another session reaches no consumer', () => {
    spawnPty(fakeWin, OWN, { ssh: { username: 'me', host: 'example.com', port: 22, remotePath: '~' }, cwd: os.homedir() } as never)
    const p = h.ptys[h.ptys.length - 1]
    p.emitData(`remote output ${sentinel(payload(OTHER))} more output`)
    expect(reached()).toEqual({ renderer: [], usage: [], transcripts: [] })
    // The sentinel is still taken out of what the terminal shows.
    const shown = h.sent.filter(([c]) => c === `pty:data:${OWN}`).map(([, d]) => String(d)).join('')
    expect(shown).toBe('remote output  more output')
  })

  it('the session\'s own status update reaches every consumer, as before', () => {
    spawnPty(fakeWin, OWN, { ssh: { username: 'me', host: 'example.com', port: 22, remotePath: '~' }, cwd: os.homedir() } as never)
    const p = h.ptys[h.ptys.length - 1]
    p.emitData(sentinel(payload(OWN)))
    expect(reached()).toEqual({ renderer: [OWN], usage: [OWN], transcripts: [OWN] })
  })
})

describe('the per-session status file', () => {
  /** Write `<file>.json` and wait until the watcher has read it. */
  const writeAndWaitForRead = async (fileStem: string, body: Record<string, unknown>): Promise<void> => {
    const statusDir = path.join(h.resDir, 'status')
    fs.mkdirSync(statusDir, { recursive: true })
    const target = path.join(statusDir, `${fileStem}.json`)
    const realRead = fs.promises.readFile.bind(fs.promises)
    let readDone = false
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (...a: Parameters<typeof fs.promises.readFile>) => {
      const out = await realRead(...a)
      if (path.resolve(String(a[0])) === path.resolve(target)) readDone = true
      return out
    }) as typeof fs.promises.readFile)
    try {
      fs.writeFileSync(target, JSON.stringify(body))
      await vi.waitFor(() => { if (!readDone) throw new Error('not read yet') }, { timeout: 12_000, interval: 25 })
      // The read's continuation (parse, check, fan-out) runs right after it.
      await new Promise((r) => setTimeout(r, 50))
    } finally {
      spy.mockRestore()
    }
  }

  it('a status file whose payload names another session reaches no consumer', async () => {
    await writeAndWaitForRead('statusfileowna0000000003', payload('statusfileothr0000000004'))
    expect(reached()).toEqual({ renderer: [], usage: [], transcripts: [] })
  }, 20_000)

  // Mutation to prove this can fail: read a status file whatever its name.
  it('a status file whose name is not a session id is not read, and nothing is logged for it', async () => {
    const statusDir = path.join(h.resDir, 'status')
    fs.mkdirSync(statusDir, { recursive: true })
    h.warned.length = 0
    // Two files that are no session's: one naming itself, one naming a session.
    fs.writeFileSync(path.join(statusDir, 'status.notanid.json'), JSON.stringify(payload('status.notanid')))
    fs.writeFileSync(path.join(statusDir, 'status.another.json'), JSON.stringify(payload('statusfileothr0000000008')))
    // Then a session's own file: once it is read, the two before it were seen too.
    const sid = 'statusfileowna0000000009'
    await writeAndWaitForRead(sid, payload(sid))
    await new Promise((r) => setTimeout(r, 300))
    for (const f of ['status.notanid.json', 'status.another.json']) fs.rmSync(path.join(statusDir, f), { force: true })
    expect(reached()).toEqual({ renderer: [sid], usage: [sid], transcripts: [sid] })
    expect(h.warned.filter((l) => l.includes('status.'))).toEqual([])
  }, 20_000)

  it('a status file naming its own session reaches every consumer, as before', async () => {
    const sid = 'statusfileowna0000000005'
    await writeAndWaitForRead(sid, payload(sid))
    expect(reached()).toEqual({ renderer: [sid], usage: [sid], transcripts: [sid] })
  }, 20_000)

  // Every delivery passes one shape filter: a status file's payload reaches
  // the renderer exactly as the same payload through the session's terminal
  // does, whatever fields it carries.
  // Mutation to prove this can fail: fan a status file's payload out as it was parsed.
  it('a status file passes the same shape filter as the terminal and /status deliveries', async () => {
    const ownSsh = 'statusshapessh0000000010'
    const ownFile = 'statusshapefil0000000011'
    const odd = (sessionId: string): Record<string, unknown> => ({
      ...payload(sessionId),
      transcriptPath: '/transcripts/shared.jsonl',
      // An extra-usage block missing the numbers the status bar reads.
      rateLimitExtra: { enabled: true },
      // A label far past any real one, an account that is not an address,
      // and a nested object no reader takes.
      label: 'L'.repeat(100_000),
      accountEmail: `someone${ch(0x202e)}@example.com${ch(7)}`,
      nested: { deep: { x: 1 } },
    })
    spawnPty(fakeWin, ownSsh, { ssh: { username: 'me', host: 'example.com', port: 22, remotePath: '~' }, cwd: os.homedir() } as never)
    try {
      h.ptys[h.ptys.length - 1].emitData(sentinel(odd(ownSsh)))
    } finally {
      killPty(ownSsh)
    }
    await writeAndWaitForRead(ownFile, odd(ownFile))
    const shown = h.sent.filter(([c]) => c === 'statusline:update').map(([, d]) => d as Record<string, unknown>)
    const viaTerminal = shown.find((d) => d.sessionId === ownSsh)
    const viaFile = shown.find((d) => d.sessionId === ownFile)
    expect(viaTerminal).toBeDefined()
    expect(viaFile).toBeDefined()
    const { sessionId: _t, ...terminalFields } = viaTerminal!
    const { sessionId: _f, ...fileFields } = viaFile!
    expect(fileFields).toEqual(terminalFields)
    for (const dropped of ['rateLimitExtra', 'label', 'accountEmail', 'nested']) expect(viaFile, dropped).not.toHaveProperty(dropped)
    expect(viaFile!.model).toBe('m')
  }, 20_000)
})
