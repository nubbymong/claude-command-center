// P3.15 round 4 (P3, P4): an SSH session's PTY is guarded like every other
// session's: a failed write to its input, or an error on its output, never
// quits the app; the error is logged once, and a session that has not ended
// within the grace is ended, with a line in its terminal. Adopted from the
// P3.16a ADR-009 lens B probe (B-K-1): the real spawnPty SSH branch, node-pty
// faked with its Windows shape (the input socket on its agent, every other
// event on its output socket, and node-pty's own output error handler).
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as os from 'os'

const h = vi.hoisted(() => ({
  ptys: [] as Array<{ file: string; inSocket: import('events').EventEmitter; outSocket: import('events').EventEmitter; kill: ReturnType<typeof import('vitest').vi.fn>; exit: Array<(e: { exitCode: number }) => void> }>,
  sent: [] as Array<[string, unknown]>,
}))
vi.mock('node-pty', () => ({
  spawn: (file: string) => {
    const { EventEmitter } = require('events') as typeof import('events')
    const rec = { file, inSocket: new EventEmitter(), outSocket: new EventEmitter(), kill: vi.fn(), exit: [] as Array<(e: { exitCode: number }) => void> }
    rec.outSocket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code && (err.code.includes('errno 5') || err.code.includes('EIO'))) return
      if (rec.outSocket.listeners('error').length < 2) throw err
    })
    h.ptys.push(rec)
    return {
      pid: 4242,
      process: file,
      onData: () => ({ dispose: () => {} }),
      onExit: (cb: (e: { exitCode: number }) => void) => { rec.exit.push(cb); return { dispose: () => {} } },
      write: () => {},
      resize: () => {},
      kill: rec.kill,
      on: (ev: string, l: (...a: unknown[]) => void) => { rec.outSocket.on(ev, l) },
      _agent: { inSocket: rec.inSocket },
    }
  },
}))
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), on: () => {}, quit: () => {}, isPackaged: false },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: () => {} },
}))

const { spawnPty, killPty, PTY_IO_FAILED_GRACE_MS } = await import('../../../src/main/pty-manager')
const { registerProvider } = await import('../../../src/main/providers')

const sshProvider = {
  id: 'claude', displayName: 'Claude',
  resolveBinary: () => null,
  buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }),
  detectUiRunning: () => false,
  ingestSessionTelemetry: () => ({ stop() {} }),
  listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }),
  configureMcpServer: async () => {},
  getSshSettingsPath: () => '',
  getSshMcpConfigPath: () => '',
  configureRemoteSettings: () => '',
}
const fakeWin = { webContents: { send: (ch: string, d: unknown) => { h.sent.push([ch, d]) } }, isDestroyed: () => false } as never
const failure = (code: string) => Object.assign(new Error(`io ${code}`), { code })
let n = 0

afterEach(() => { vi.useRealTimers() })

describe('an SSH session\'s PTY (round 4, P3, P4)', () => {
  for (const side of ['input', 'output'] as const) {
    it(`an error on its ${side} is caught; after the grace the session is ended, with the line in its terminal`, () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
      registerProvider(sshProvider as never)
      const SID = `sshioguard${side}${++n}`.padEnd(24, '0')
      h.sent.length = 0
      spawnPty(fakeWin, SID, { ssh: { username: 'me', host: 'example.com', port: 22, remotePath: '~' }, cwd: os.homedir() } as never)
      const p = h.ptys[h.ptys.length - 1]
      expect(p.file).toMatch(/ssh/)
      const socket = side === 'input' ? p.inSocket : p.outSocket
      expect(() => socket.emit('error', failure('EPIPE'))).not.toThrow()
      expect(() => socket.emit('error', failure('ECONNRESET'))).not.toThrow()
      vi.advanceTimersByTime(PTY_IO_FAILED_GRACE_MS - 1)
      expect(p.kill).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(p.kill).toHaveBeenCalledTimes(1)
      expect(h.sent.some(([ch, d]) => ch === `pty:data:${SID}` && String(d).includes('stopped taking input'))).toBe(true)
      try { killPty(SID) } catch { /* gone */ }
    })
  }
})
