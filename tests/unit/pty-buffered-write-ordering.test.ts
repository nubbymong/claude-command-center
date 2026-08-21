// A PTY exists ~300ms before its launch line is written, so for that window the
// terminal is a bare interactive shell that has not yet become Claude. A write
// landing there went straight to that shell, and its trailing `\r` submitted it
// as a SHELL COMMAND -- an Ask Conductor question typed at a session that was
// still starting got executed by PowerShell instead of asked of Claude.
//
// Note the window that matters is AFTER spawn, not before it: spawnPty calls
// killPty(sessionId) on entry, which drops any pre-spawn `pendingWrites`, so a
// write buffered before the spawn is discarded rather than replayed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const writeMock = vi.fn()
const spawnMock = vi.fn(() => ({
  onData: () => {},
  onExit: () => {},
  write: writeMock,
  kill: () => {},
  pid: 4321,
}))

vi.mock('node-pty', () => ({ spawn: spawnMock }))
vi.mock('electron', () => ({
  // getAllWindows is a STATIC, and pushAccountIdentity calls it during spawn --
  // a bare `class {}` throws there and the spawn never reaches its launch timer.
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => '/tmp' },
}))

const { spawnPty, writePty, killPty } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

const fakeWin = { webContents: { send: () => {} }, isDestroyed: () => false } as never

/** Index of the first write containing `needle`, or -1. */
function indexOfWrite(needle: string): number {
  return writeMock.mock.calls.findIndex(
    (c) => typeof c[0] === 'string' && c[0].includes(needle),
  )
}

beforeEach(() => {
  writeMock.mockClear()
  spawnMock.mockClear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a write that lands while the launch line is still queued', () => {
  it('is held until claude owns the terminal, not given to the bare shell', () => {
    const id = 'ask-window-1'
    spawnPty(fakeWin, id, { cwd: process.cwd(), cols: 80, rows: 24 })

    // Mid-window: the PTY is registered, the launch line has NOT been written.
    vi.advanceTimersByTime(100)
    expect(indexOfWrite('claude')).toBe(-1)

    writePty(id, 'what is the canvas for?\r')
    // Nothing may reach the shell yet -- this is the whole defect.
    expect(indexOfWrite('what is the canvas for?')).toBe(-1)

    vi.advanceTimersByTime(400)

    const launch = indexOfWrite('claude')
    const question = indexOfWrite('what is the canvas for?')
    expect(launch).toBeGreaterThanOrEqual(0)
    expect(question).toBeGreaterThanOrEqual(0) // delivered, not dropped
    expect(question).toBeGreaterThan(launch) // and only once claude is running

    killPty(id)
  })

  it('writes straight through once the launch line has been written', () => {
    const id = 'ask-window-2'
    spawnPty(fakeWin, id, { cwd: process.cwd(), cols: 80, rows: 24 })
    vi.advanceTimersByTime(400) // launch line written, hold released

    const before = writeMock.mock.calls.length
    writePty(id, 'a later question\r')
    // No buffering after the window: the write is immediate.
    expect(writeMock.mock.calls.length).toBe(before + 1)
    expect(indexOfWrite('a later question')).toBeGreaterThanOrEqual(0)

    killPty(id)
  })

  it('holds for a shell-only session too, until its launcher command is written', () => {
    const id = 'ask-window-shellonly'
    spawnPty(fakeWin, id, {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      shellOnly: true,
      terminalOptions: { command: 'my-launcher' },
    })

    vi.advanceTimersByTime(100)
    writePty(id, 'typed too early\r')
    expect(indexOfWrite('typed too early')).toBe(-1)

    vi.advanceTimersByTime(400)
    const launcher = indexOfWrite('my-launcher')
    const typed = indexOfWrite('typed too early')
    expect(launcher).toBeGreaterThanOrEqual(0)
    expect(typed).toBeGreaterThan(launcher)

    killPty(id)
  })

  it('replays a large held paste in chunks, not as one oversized write', () => {
    const id = 'ask-window-chunked'
    spawnPty(fakeWin, id, { cwd: process.cwd(), cols: 80, rows: 24 })
    vi.advanceTimersByTime(100)

    // Well over WRITE_CHUNK_SIZE (256B). Written in one go this overflows or
    // truncates ConPTY's input buffer -- the reason writePty chunks at all.
    const big = 'X'.repeat(4096)
    writePty(id, big)

    vi.advanceTimersByTime(400) // launch line lands, hold releases
    vi.advanceTimersByTime(5000) // let the chunked writer drain its interval

    const payloads = writeMock.mock.calls
      .map((c) => (typeof c[0] === 'string' ? c[0] : ''))
      .filter((s) => s.includes('X'))
    expect(payloads.length).toBeGreaterThan(1) // chunked, not one write
    expect(Math.max(...payloads.map((p) => p.length))).toBeLessThanOrEqual(256)
    expect(payloads.join('').length).toBe(big.length) // and nothing lost

    killPty(id)
  })

  it('releases the hold when the session dies inside the window', () => {
    const id = 'ask-window-3'
    spawnPty(fakeWin, id, { cwd: process.cwd(), cols: 80, rows: 24 })
    vi.advanceTimersByTime(100)
    writePty(id, 'never delivered\r')

    killPty(id) // PTY gone; the launch timer's liveness guard will bail
    vi.advanceTimersByTime(400)

    // The point is that nothing is stuck holding writes for a dead session, and
    // the text was never handed to the shell that briefly existed.
    expect(indexOfWrite('never delivered')).toBe(-1)
  })
})
