// rc.15 review R9 (Codex, 2026-09-06; aicc_planning#52 adjacent): the
// reviewer's characterization (evidence/lifecycle-source-callbacks.review.test.ts,
// "stale local onData delivery") flipped into the desired behaviour, credit
// Codex rc.15 stability review; RED against 7ef62a2e before this change.
//
// A restart replaces a local PTY under the same session id synchronously, and
// node-pty still delivers the OLD process's late output afterwards. The stale
// EXIT was already suppressed by a process-identity check (rc.14 F8); the data
// callback only checked the window, so old output reached the new terminal and
// the session-id-keyed watchdog. The data callback now carries the same guard.
//
// Real spawnPty shell-only branch with node-pty mocked to fake PTYs whose data
// callbacks the test fires by hand.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'

class FakePty {
  pid = 4242
  cols = 80
  rows = 24
  process = 'sh'
  handleFlowControl = false
  dataCbs: Array<(d: string) => void> = []
  exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null
  onData(cb: (d: string) => void) { this.dataCbs.push(cb); return { dispose() {} } }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void) { this.exitCb = cb; return { dispose() {} } }
  write = vi.fn()
  resize = vi.fn()
  kill = vi.fn()
  pause() {}
  resume() {}
  clear() {}
  feed(d: string) { for (const cb of this.dataCbs) cb(d) }
}
const ptys: FakePty[] = []
vi.mock('electron', () => ({
  BrowserWindow: Object.assign(class {}, { getAllWindows: () => [] }),
  nativeTheme: { shouldUseDarkColors: false, on: () => {} },
  app: { getPath: () => process.env.TEMP ?? '/tmp' },
}))
vi.mock('node-pty', () => ({ spawn: () => { const p = new FakePty(); ptys.push(p); return p } }))

const { _setRootsForTest } = await import('../../src/main/account-profiles')
const { spawnPty, killPty } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
type SessionProvider = import('../../src/main/providers/types').SessionProvider

const fakeProvider = {
  id: 'claude', displayName: 'Claude', resolveBinary: () => null,
  buildSpawnCommand: () => ({ cmd: '', args: [], env: {} }), detectUiRunning: () => false,
  ingestSessionTelemetry: () => ({ stop() {} }), listHistorySessions: async () => [],
  resumeCommand: () => ({ cmd: '', args: [] }), configureMcpServer: async () => {},
  getSshSettingsPath: () => '', getSshMcpConfigPath: () => '', configureRemoteSettings: () => '',
} as unknown as SessionProvider

const sent: Array<[string, unknown]> = []
const win = { webContents: { send: (ch: string, payload: unknown) => { sent.push([ch, payload]) } }, isDestroyed: () => false } as never
let sandbox = ''
const SID = 'sid-r9-restart'

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'ccc-vitest-r9-'))
  _setRootsForTest({ resourcesDir: sandbox, sharedRoot: join(sandbox, '.claude') })
  registerProvider(fakeProvider)
  ptys.length = 0
  sent.length = 0
})
afterEach(() => {
  try { killPty(SID) } catch { /* already gone */ }
  _setRootsForTest(null)
  try { rmSync(sandbox, { recursive: true, force: true }) } catch { /* best-effort */ }
})

const dataFor = (sid: string) => sent.filter(([ch]) => ch === `pty:data:${sid}`).map(([, d]) => String(d))

describe('late output from a replaced PTY (R9)', () => {
  it('Codex: a restart replaces the PTY; the OLD process\'s late output never reaches the renderer, the NEW one\'s does', () => {
    spawnPty(win, SID, { shellOnly: true, cwd: homedir() })
    spawnPty(win, SID, { shellOnly: true, cwd: homedir() }) // the renderer's restart: same id, new PTY
    expect(ptys).toHaveLength(2)
    const [old, current] = ptys
    old.feed('late output from the old PTY')
    expect(dataFor(SID)).toEqual([]) // 7ef62a2e: delivered
    current.feed('prompt from the new PTY')
    expect(dataFor(SID)).toEqual(['prompt from the new PTY'])
    // ...and the old exit is still suppressed, as before (rc.14 F8).
    old.exitCb?.({ exitCode: 0 })
    expect(sent.some(([ch]) => ch === `pty:exit:${SID}`)).toBe(false)
  })

  it('positive control: a single PTY delivers its own output as before', () => {
    spawnPty(win, SID, { shellOnly: true, cwd: homedir() })
    ptys[0].feed('hello')
    expect(dataFor(SID)).toEqual(['hello'])
  })

  it('output after the session was killed (no replacement) is dropped too', () => {
    spawnPty(win, SID, { shellOnly: true, cwd: homedir() })
    const p = ptys[0]
    killPty(SID)
    p.feed('after kill')
    expect(dataFor(SID)).toEqual([])
  })
})
