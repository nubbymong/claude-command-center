// [host] ADR-025: the first-run setup terminal starts claude.exe straight
// after an install, often its first start ever. On Windows the handler awaits
// the first-start warm-up of the Claude Code main resolved (never anything the
// renderer sent: it sends only the terminal's size) before node-pty starts it.
// A kill, or a newer start, that arrives during that wait cancels the start.
// The PTY, the resolution and the warm-up are faked; nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as os from 'node:os'

const RESOLVED = 'C:\\Users\\A\\.local\\bin\\claude.exe'
const h = vi.hoisted(() => ({
  order: [] as string[],
  warm: [] as Array<{ program: string; env: () => unknown }>,
  gate: null as null | Promise<void>,
  refused: null as null | { code: string; providerId: string; message: string },
  handlers: new Map<string, (...a: unknown[]) => unknown>(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { h.handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: { fromWebContents: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  app: { getPath: () => os.tmpdir() },
}))
vi.mock('node-pty', () => ({
  spawn: (file: string) => {
    h.order.push(`pty ${file}`)
    return { onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(() => { h.order.push('pty killed') }), write: vi.fn() }
  },
}))
vi.mock('../../../src/main/pty-manager', () => ({ resolveClaudeForPty: () => ({ cmd: RESOLVED, args: [] }) }))
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => h.refused }))
vi.mock('../../../src/main/update-watcher', () => ({ getInstallPath: () => '', getProjectRootPath: () => '' }))
vi.mock('../../../src/main/claude-cli-probe', () => ({ probeClaudeCli: vi.fn(), CLAUDE_WINDOWS_NAMES: ['claude.exe', 'claude.cmd', 'claude.bat'] }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/data-paths', () => ({
  getDataDirectory: () => os.tmpdir(), getResourcesDirectory: () => os.tmpdir(),
  setDataDirectory: vi.fn(), setResourcesDirectory: vi.fn(), isDataDirFromRegistry: () => true,
}))
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async (program: string, env: () => unknown) => {
    h.warm.push({ program, env })
    h.order.push(`warm ${program}`)
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

// The shared test setup replaces setup-handlers with a stub; this suite drives the real one.
const real = await vi.importActual<typeof import('../../../src/main/ipc/setup-handlers')>('../../../src/main/ipc/setup-handlers')
real.registerSetupHandlers()
const spawnCliSetup = h.handlers.get('setup:spawnCliSetup')!
const killCliSetup = h.handlers.get('setup:killCliSetup')!

beforeEach(async () => {
  // A terminal an earlier case started is ended first, so each case starts with none.
  await killCliSetup({ sender: {} })
  h.order.length = 0; h.warm.length = 0; h.gate = null; h.refused = null
})
afterEach(() => { delete process.env.CCC_FIRST_START_MARK })

describe.runIf(process.platform === 'win32')('the first-run setup terminal on Windows (ADR-025)', () => {
  it('awaits the warm-up of the claude.exe main resolved before node-pty starts it', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const started = spawnCliSetup({ sender: {} }, 100, 20)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.order).toEqual([`warm ${RESOLVED}`])
    release()
    expect(await started).toBe('__cli_setup__')
    expect(h.order).toEqual([`warm ${RESOLVED}`, `pty ${RESOLVED}`])
  })

  it('warms with Claude\'s --version environment, and nothing the renderer sends reaches it', async () => {
    process.env.CCC_FIRST_START_MARK = 'never reaches a CLI run'
    const hostile = 'C:\\Users\\Public\\evil.exe'
    await spawnCliSetup({ sender: {} }, hostile, hostile, hostile)
    expect(h.warm.map((w) => w.program)).toEqual([RESOLVED])
    const env = (await (h.warm[0].env as () => Promise<{ env: Record<string, string> }> | { env: Record<string, string> })()).env
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(JSON.stringify(env)).not.toContain('evil.exe')
  })

  it('Claude Code switched off while the warm-up ran: refused in the same step as the start, and no terminal', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const started = spawnCliSetup({ sender: {} }, 100, 20)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    h.refused = { code: 'provider-off', providerId: 'claude', message: 'Claude Code is off. Turn it on in Settings, Accounts.' }
    release()
    expect(await started).toEqual({ refused: h.refused })
    expect(h.order).toEqual([`warm ${RESOLVED}`])
  })

  it('Skip for now while the warm-up runs: the terminal is never started, and nothing counts as Claude Code in use', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const started = spawnCliSetup({ sender: {} }, 100, 20)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    // The setup screen closes the terminal (Skip for now, Finish or Exit) before it exists.
    expect(await killCliSetup({ sender: {} })).toBe(true)
    release()
    expect(await started).toBeNull()
    expect(h.order).toEqual([`warm ${RESOLVED}`])
    expect(real.countCliSetupInUse()).toBe(0)
  })

  it('a second start while the first one waits on its warm-up: only the newer one starts a terminal', async () => {
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const first = spawnCliSetup({ sender: {} }, 100, 20)
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    const second = spawnCliSetup({ sender: {} }, 100, 20)
    await vi.waitFor(() => expect(h.warm).toHaveLength(2))
    release()
    expect(await first).toBeNull()
    expect(await second).toBe('__cli_setup__')
    expect(h.order.filter((o) => o.startsWith('pty '))).toEqual([`pty ${RESOLVED}`])
    expect(real.countCliSetupInUse()).toBe(1)
  })

  it('a kill after the terminal started still ends it, and a later start is not cancelled by it', async () => {
    expect(await spawnCliSetup({ sender: {} }, 100, 20)).toBe('__cli_setup__')
    await killCliSetup({ sender: {} })
    expect(h.order).toEqual([`warm ${RESOLVED}`, `pty ${RESOLVED}`, 'pty killed'])
    expect(real.countCliSetupInUse()).toBe(0)
    expect(await spawnCliSetup({ sender: {} }, 100, 20)).toBe('__cli_setup__')
    expect(real.countCliSetupInUse()).toBe(1)
  })
})
