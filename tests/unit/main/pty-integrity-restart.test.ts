// P3.16 (M5): the Services page's PTY byte count across a Restart. The
// renderer counts the bytes it received per terminal mount (TerminalView's
// effect, which spawns the PTY), so a Restart starts its count at 0; main's
// integrity monitor keeps one record per session id. Each spawn of the id is a
// new process with a new count: the record a spawn replaces ends with it
// (pty-manager's per-spawn teardown, which killPty and every respawn run), so
// a Restart shows no gap of the bytes before it, on either ConPTY (the record
// is per session id, whatever the console host).
//
// Drives the REAL spawnPty and killPty with a fake node-pty whose data the
// test emits, and the REAL integrity monitor. Mock stack after
// pty-session-liveness.test.ts.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const h = vi.hoisted(() => ({
  procs: [] as Array<{ data: Array<(d: string) => void>; exit: Array<(e: { exitCode: number }) => void>; killed: boolean }>,
  dir: '',
}))

vi.mock('node-pty', () => ({
  spawn: () => {
    const rec = { data: [] as Array<(d: string) => void>, exit: [] as Array<(e: { exitCode: number }) => void>, killed: false }
    h.procs.push(rec)
    return {
      pid: 5000 + h.procs.length,
      process: 'pwsh',
      onData: (cb: (d: string) => void) => { rec.data.push(cb); return { dispose: () => {} } },
      // Round 2 (Q5): kept, so a case can report the process's exit.
      onExit: (cb: (e: { exitCode: number }) => void) => { rec.exit.push(cb); return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: () => { rec.killed = true },
    }
  },
}))

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  h.dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-test-pty-integrity-'))
  return {
    getResourcesDirectory: () => h.dir,
    getDataDirectory: () => h.dir,
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
  registerClaudeReviewSession: () => {},
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

const { PtyIntegrityMonitor, setPtyIntegrityMonitor } = await import('../../../src/main/services/pty-integrity-monitor')
const { spawnPty, killPty, beginSpawnPreparation } = await import('../../../src/main/pty-manager')

const SID = 'ptyrestart1ptyrestart1pt'
/** The session's partner terminal, as the renderer names its PTY. */
const PID = `${SID}-partner`
const fakeWin = {
  isDestroyed: () => false,
  webContents: { send: () => {} },
} as unknown as Parameters<typeof spawnPty>[0]

let monitor: InstanceType<typeof PtyIntegrityMonitor>
beforeEach(() => {
  try { killPty(SID) } catch { /* none */ }
  try { killPty(PID) } catch { /* none */ }
  monitor = new PtyIntegrityMonitor({ emit: () => {}, emitDebounceMs: 0 })
  setPtyIntegrityMonitor(monitor)
  h.procs.length = 0
})
afterAll(() => {
  try { killPty(SID) } catch { /* already gone */ }
  try { killPty(PID) } catch { /* already gone */ }
  setPtyIntegrityMonitor(null)
  // Only the folder this file's mock made: its own prefix, directly in the temp folder.
  if (h.dir && path.dirname(h.dir) === os.tmpdir() && path.basename(h.dir).startsWith('ccc-test-pty-integrity-')) {
    fs.rmSync(h.dir, { recursive: true, force: true })
  }
})

const spawnOptions = () => ({ cwd: os.tmpdir(), cols: 80, rows: 24 } as Parameters<typeof spawnPty>[2])
/** Start `id`'s next process through `start` (spawnPty unless a case says). */
function spawn(id = SID, start: () => void = () => spawnPty(fakeWin, id, spawnOptions())): { data: (d: string) => void } {
  const before = h.procs.length
  let threw = ''
  try {
    start()
  } catch (err) { threw = String((err as Error)?.stack ?? err) }
  const proc = h.procs[before]
  expect(threw, 'the spawn completed').toBe('')
  expect(proc?.data.length, 'the spawn armed its data hook').toBeGreaterThan(0)
  return { data: (d) => { for (const cb of proc.data) cb(d) } }
}
const report = (bytesReceived: number, id = SID) =>
  monitor.recordRendererReport({ sessionId: id, bytesReceived, bytesWritten: 0, strippedBytes: 0, cols: 80, rows: 24, resizeCount: 0 })
const row = (id = SID) => monitor.snapshot().sessions.find((s) => s.sessionId === id)

describe('the PTY byte count across a Restart (P3.16, M5)', () => {
  it('a Restart (kill, then spawn the id again) starts the count with the new process: no gap of the bytes before it', () => {
    const first = spawn()
    first.data('x'.repeat(10_000))
    report(10_000)
    expect(row()?.byteGap).toBe(0)
    killPty(SID)
    const second = spawn()
    // The old process's late output is not the new one's (dropped by the data guard).
    first.data('y'.repeat(500))
    second.data('z'.repeat(3_000))
    // The new mount's count, from 0.
    report(3_000)
    expect(row()?.bytesFromPty).toBe(3_000)
    expect(row()?.byteGap).toBe(0)
    expect(monitor.diagnostics().logs.filter((l) => l.code === 'pty-byte-gap')).toEqual([])
    // P3.16 round 1 (N8): a Restart is not the session's end: no "session ended" event.
    expect(monitor.snapshot().recentEvents.some((e) => e.kind === 'end')).toBe(false)
  })

  it('a respawn of the id without a kill first (spawnPty ends the PTY it replaces) does the same', () => {
    const first = spawn()
    first.data('x'.repeat(8_000))
    report(8_000)
    const second = spawn()
    second.data('z'.repeat(1_000))
    report(1_000)
    expect(row()?.bytesFromPty).toBe(1_000)
    expect(row()?.byteGap).toBe(0)
  })

  it('within one process the count is kept as before: a real gap still shows', () => {
    const first = spawn()
    first.data('x'.repeat(10_000))
    report(2_000)
    expect(row()?.byteGap).toBe(8_000)
    expect(monitor.diagnostics().logs.map((l) => l.code)).toContain('pty-byte-gap')
  })
})

// P3.16a round 2 (Q5, the VM Judge item): a Restart pressed while the partner
// view is shown ends the main process, and its next process starts only when
// the main view is shown, so that process's exit arrives with no new spawn
// after it. The renderer says the kill is a Restart's: the exit then restarts
// the count quietly, with no "session ended" event. A close is the session's
// end: one event, whether its process ends then or had ended before.
describe('a Restart is not the session\'s end on the Services page (P3.16a round 2, Q5)', () => {
  const ends = (id = SID) => monitor.snapshot().recentEvents.filter((e) => e.kind === 'end' && e.sessionId === id)
  const exitOf = (i: number) => { for (const cb of [...h.procs[i].exit]) cb({ exitCode: 0 }) }

  it('a Restart whose next process has not started yet (the partner view): the exit logs no "session ended", and the count waits at 0', () => {
    const first = spawn()
    first.data('x'.repeat(4_000))
    report(4_000)
    killPty(SID, { reason: 'restart' })
    exitOf(0)
    expect(ends()).toEqual([])
    expect(row()).toMatchObject({ bytesFromPty: 0, bytesReceived: 0, byteGap: 0 })
    // Shown at last: the next process counts from 0.
    const second = spawn()
    second.data('z'.repeat(700))
    report(700)
    expect(row()?.byteGap).toBe(0)
    expect(ends()).toEqual([])
  })

  // (Each case gives the monitor a record first, as the terminal's first report does.)
  it('a close: one "session ended" when its process ends', () => {
    spawn()
    report(0)
    killPty(SID, { reason: 'close' })
    exitOf(0)
    expect(ends()).toHaveLength(1)
  })

  it('a tab restarted from the partner view and closed before its main view was shown: one "session ended", at the close', () => {
    spawn()
    report(0)
    killPty(SID, { reason: 'restart' })
    exitOf(0)
    expect(ends()).toEqual([])
    killPty(SID, { reason: 'close' })
    expect(ends()).toHaveLength(1)
    expect(row()).toBeUndefined()
  })

  it('a Restart\'s mark is for that exit only: once the next process has started, that process\'s own end is the session\'s end', () => {
    spawn()
    killPty(SID, { reason: 'restart' })
    spawn()
    report(0)
    // The old process's late exit: a newer spawn owns the session.
    exitOf(0)
    expect(ends()).toEqual([])
    exitOf(1)
    expect(ends()).toHaveLength(1)
  })

  it('a process that ended by itself, then a close: one "session ended", at the exit', () => {
    spawn()
    report(0)
    exitOf(0)
    expect(ends()).toHaveLength(1)
    killPty(SID, { reason: 'close' })
    expect(ends()).toHaveLength(1)
  })

  // Fixer 3 (F2): a spawn main prepares first (beginSpawnPreparation: a Codex
  // session, or a pinned Claude Code version installed first) clears the
  // Restart's mark as spawnPty does, so the next process's own end is the
  // session's end.
  const prepared = () => () => beginSpawnPreparation(fakeWin, SID, null).spawn(spawnOptions())
  it('a Restart whose next process starts through a preparation: that process\'s own end is the session\'s end', () => {
    spawn()
    report(0)
    killPty(SID, { reason: 'restart' })
    const prep = beginSpawnPreparation(fakeWin, SID, null)
    // The ended process's exit while the next one is prepared: handed to the preparation.
    exitOf(0)
    expect(ends()).toEqual([])
    spawn(SID, () => prep.spawn(spawnOptions()))
    report(0)
    exitOf(1)
    expect(ends()).toHaveLength(1)
  })

  it('a Restart of a tab whose process had ended, its next process started through a preparation: that process\'s own end is the session\'s end', () => {
    spawn()
    report(0)
    exitOf(0)
    expect(ends()).toHaveLength(1)
    killPty(SID, { reason: 'restart' })
    spawn(SID, prepared())
    report(0)
    exitOf(1)
    expect(ends()).toHaveLength(2)
  })

  // Fixer 3 (F1): a Restart (or a Recover) ends the hidden partner's process
  // as a Restart's too, and the partner's next one starts only when its view
  // is shown. A close before that ends the partner's record as well: the
  // renderer's close always kills the partner (ptyTracker.killSessionPty),
  // here through pty:kill as main's handler takes it (pty-handlers.ts: only
  // the exact 'restart' is a Restart's).
  it('a tab restarted, then closed before its partner view was shown again: the partner\'s record ends too, at the close', async () => {
    const { killSessionPty, markSpawned } = await import('../../../src/renderer/ptyTracker')
    const g = globalThis as { window?: unknown }
    const before = g.window
    g.window = { electronAPI: { pty: { kill: (id: string, reason?: unknown) => killPty(id, { reason: reason === 'restart' ? 'restart' : 'close' }) } } }
    try {
      spawn(SID); markSpawned(SID); report(0, SID)
      spawn(PID); markSpawned(PID); report(0, PID)
      killSessionPty(SID, { restart: true })
      exitOf(0)
      exitOf(1)
      expect(ends(SID)).toEqual([])
      expect(ends(PID)).toEqual([])
      // The main view is shown: its next process starts. The tab is closed
      // before the partner view is shown again.
      spawn(SID); markSpawned(SID); report(0, SID)
      killSessionPty(SID)
      exitOf(2)
      expect(ends(SID)).toHaveLength(1)
      expect(ends(PID)).toHaveLength(1)
      expect(row(PID)).toBeUndefined()
    } finally {
      g.window = before
    }
  })
})
