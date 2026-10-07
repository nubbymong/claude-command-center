// [host] An SSH session is untouched by main's answer to a Codex session's
// colour query (pty-codex-color-replies.test.ts): a colour query in its
// output reaches the renderer intact (its xterm.js answers, as always) and main
// writes no colour answer into its PTY. The real spawnPty SSH branch; node-pty
// faked as in pty-ssh-io-guard.test.ts, with its data callback kept.
import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'

const h = vi.hoisted(() => ({
  ptys: [] as Array<{ file: string; emitData: (d: string) => void; writes: string[] }>,
  sent: [] as Array<[string, unknown]>,
}))
vi.mock('node-pty', () => ({
  spawn: (file: string) => {
    const { EventEmitter } = require('events') as typeof import('events')
    const out = new EventEmitter()
    out.on('error', () => {})
    const dataCbs: Array<(d: string) => void> = []
    const rec = { file, emitData: (d: string) => { for (const cb of dataCbs) cb(d) }, writes: [] as string[] }
    h.ptys.push(rec)
    return {
      pid: 4343,
      process: file,
      onData: (cb: (d: string) => void) => { dataCbs.push(cb); return { dispose: () => {} } },
      onExit: () => ({ dispose: () => {} }),
      write: (d: string) => { rec.writes.push(String(d)) },
      resize: () => {},
      kill: vi.fn(),
      on: (ev: string, l: (...a: unknown[]) => void) => { out.on(ev, l) },
      _agent: { inSocket: new EventEmitter() },
    }
  },
}))
vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), on: () => {}, quit: () => {}, isPackaged: false },
  ipcMain: { handle: () => {}, on: () => {} },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: true },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { openExternal: () => {} },
}))

const { spawnPty, killPty } = await import('../../../src/main/pty-manager')
const { registerProvider } = await import('../../../src/main/providers')
const { ClaudeProvider } = await import('../../../src/main/providers/claude')

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
})
const fakeWin = { webContents: { send: (ch: string, d: unknown) => { h.sent.push([ch, d]) } }, isDestroyed: () => false } as never

const ESC = '\x1b'
const ST = `${ESC}\\`
const CODEX_QUERY = `${ESC}]10;?${ST}${ESC}]11;?${ST}`

describe('an SSH session and a colour query in its output', () => {
  it('reaches the renderer intact; main writes no colour answer into its PTY', () => {
    registerProvider(sshProvider as never)
    const SID = 'sshcolourquery00000000c1'
    spawnPty(fakeWin, SID, { ssh: { username: 'me', host: 'example.com', port: 22, remotePath: '~' }, cwd: os.homedir() } as never)
    const p = h.ptys[h.ptys.length - 1]
    expect(p.file).toMatch(/ssh/)
    p.emitData('remote ' + CODEX_QUERY + ' prompt')
    const forwarded = h.sent.filter(([ch]) => ch === `pty:data:${SID}`).map(([, d]) => String(d)).join('')
    expect(forwarded).toContain('remote ' + CODEX_QUERY + ' prompt')
    expect(p.writes.filter((w) => /\x1b\]1[01];rgb:/.test(w))).toEqual([])
    try { killPty(SID) } catch { /* gone */ }
  })
})
