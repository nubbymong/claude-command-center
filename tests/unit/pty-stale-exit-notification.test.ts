// rc.14 review F8 (aicc_planning): a stale exit from a REPLACED PTY must not
// reach the renderer.
//
// Restart (and Ask Conductor's respawn) spawn a new PTY under the same session
// id; node-pty's exit callback for the old process fires later, after the new
// one is registered. The main-side identity guard already skipped the CLEANUP
// for that stale exit, but still sent the id-only `pty:exit:<id>` event, so
// TerminalView marked the healthy replacement as exited (ptyExited + spawn
// tracker cleared), Ask Conductor treated it as dead and respawned again, and a
// remount spawned yet again. The event now goes only for the current process.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

type ExitCb = (e: { exitCode: number; signal?: number }) => void
// Every onExit listener is kept and fired, because pty-manager registers MORE
// than one on a process it is replacing (the main exit handler at spawn, and a
// second one from killPty on restart). Keeping only the last would fire the
// wrong one and make this test pass against the very bug it pins.
const procs: Array<{ exits: ExitCb[]; exit: (e: { exitCode: number }) => void; pid: number; killed: boolean }> = []
const spawnMock = vi.fn(() => {
  const p = {
    exits: [] as ExitCb[],
    exit(e: { exitCode: number }) { for (const cb of [...p.exits]) cb(e) },
    pid: 1000 + procs.length,
    killed: false,
  }
  procs.push(p)
  return {
    onData: () => {},
    onExit: (cb: ExitCb) => { p.exits.push(cb) },
    write: () => {},
    kill: () => { p.killed = true },
    pid: p.pid,
  }
})

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))

const { spawnPty, killPty } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const send = vi.fn()
const fakeWin = { webContents: { send }, isDestroyed: () => false } as never
const exitEvents = (id: string) => send.mock.calls.filter((c) => c[0] === `pty:exit:${id}`)

beforeEach(() => {
  procs.length = 0
  spawnMock.mockClear()
  send.mockClear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('pty:exit for a session restarted under the same id', () => {
  it('the OLD process\'s delayed exit is swallowed; the CURRENT process\'s exit still arrives', () => {
    const id = 'restart-under-same-id'
    spawnPty(fakeWin, id, { cwd: process.cwd(), cols: 80, rows: 24 })
    // Restart: spawnPty kills the first PTY and registers a second under the
    // same id before the first's exit callback has fired.
    spawnPty(fakeWin, id, { cwd: process.cwd(), cols: 80, rows: 24 })
    expect(procs).toHaveLength(2)
    expect(procs[0].killed).toBe(true)
    send.mockClear()

    // The old process's exit lands now, after the replacement is registered.
    procs[0].exit({ exitCode: 0 })
    expect(exitEvents(id)).toHaveLength(0)

    // The replacement's own exit is the real one.
    procs[1].exit({ exitCode: 3 })
    expect(exitEvents(id)).toHaveLength(1)
    expect(exitEvents(id)[0][1]).toBe(3)
    killPty(id)
  })

  it('positive control: with no replacement, an exit reaches the renderer as before', () => {
    const id = 'single-spawn'
    spawnPty(fakeWin, id, { cwd: process.cwd(), cols: 80, rows: 24 })
    expect(procs).toHaveLength(1)
    send.mockClear()
    procs[0].exit({ exitCode: 1 })
    expect(exitEvents(id)).toHaveLength(1)
    expect(exitEvents(id)[0][1]).toBe(1)
  })
})
