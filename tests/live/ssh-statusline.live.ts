// LIVE SSH/statusline connectivity matrix.
//
// Drives the REAL pty-manager (real node-pty, real ssh) with only electron +
// config-manager mocked, against the hosts in tests/live/hosts.local.json
// (gitignored; see hosts.example.json), and asserts the REAL statusline
// pipeline (shim → OSC sentinel → extractSshOscSentinels →
// dispatchSSHStatuslineUpdate → fanOutStatusline) delivers
// `statusline:update` events for the session's own id — the exact signal the
// renderer's statusline row waits on ("pending" until the first one lands).
//
// Combos (each skipped when its host entry is absent):
//   key + tmux wrap (fresh create)         [linuxKey]
//   key + tmux — reconnect/reattach        [linuxKey]
//   key + NO tmux (detachable:false)       [linuxKey]
//   password + tmux (staged or PATH)       [linuxPassword]
//   password + NO tmux                     [linuxPassword]
//   mac key + tmux-or-bare (as detected)   [mac]
//   windows remote (CONOUT$ shim, no tmux) [windows]
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'ccc-live-'))
const settingsState: { value: Record<string, unknown> } = { value: {} }
vi.mock('electron', () => ({
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: true, on: () => {} },
  app: { getPath: () => scratch },
}))
vi.mock('../../src/main/config-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/config-manager')>()),
  readConfig: vi.fn((name: string) => (name === 'settings' ? settingsState.value : null)),
  getConfigDir: vi.fn(() => scratch),
}))
// Isolate the LOCAL statusline file-watcher from the machine's real app data:
// without this, startStatuslineWatcher watches the registry-resolved
// ResourcesDirectory/status and the matrix ingests the OWNER'S live sessions'
// updates (wrong-sid pollution in the captured events).
vi.mock('../../src/main/ipc/setup-handlers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/setup-handlers')>()),
  getResourcesDirectory: vi.fn(() => scratch),
}))

const { spawnPty, killPty, getSshFlow, writePty } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
const { startStatuslineWatcher } = await import('../../src/main/statusline-watcher')
registerProvider(new ClaudeProvider())

interface HostEntry { host: string; username: string; password?: string; remoteOs?: 'windows' | 'unix' }
type Hosts = Partial<Record<'linuxKey' | 'linuxPassword' | 'mac' | 'windows', HostEntry>>
// Root-relative (vitest runs with the repo root as cwd); CCC_LIVE_HOSTS
// overrides for runners whose cwd is elsewhere. __dirname is not reliable
// under the ESM transform.
const hostsPath = process.env.CCC_LIVE_HOSTS ?? join(process.cwd(), 'tests', 'live', 'hosts.local.json')
const hosts: Hosts = existsSync(hostsPath) ? JSON.parse(readFileSync(hostsPath, 'utf-8')) : {}
console.log('LIVE-HOSTS path=', hostsPath, 'exists=', existsSync(hostsPath), 'keys=', Object.keys(hosts))
const itIf = (entry: HostEntry | undefined) => (entry ? it : it.skip)

interface Captured { channel: string; payload: unknown }
function makeWin() {
  const events: Captured[] = []
  return {
    events,
    win: {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload?: unknown) => { events.push({ channel, payload }) } },
    } as never,
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const updates = (ev: Captured[]) => ev.filter((e) => e.channel === 'statusline:update').map((e) => e.payload as { sessionId?: string })
const states = (ev: Captured[], sid: string) => ev.filter((e) => e.channel === `ssh:flowState:${sid}`).map((e) => (e.payload as { state: string }).state)
const pane = (ev: Captured[], sid: string) => ev.filter((e) => e.channel === `pty:data:${sid}`).map((e) => String(e.payload)).join('')

/** Connect, auto-launch claude at the overlay point, capture until 2 statusline
 *  updates (or the cap), return the captured window. */
async function runSession(sid: string, entry: HostEntry, opts: { detachable?: boolean; captureMs?: number; win?: ReturnType<typeof makeWin> } = {}) {
  const w = opts.win ?? makeWin()
  try { startStatuslineWatcher(() => w.win as never) } catch { /* status-dir watch is irrelevant here */ }
  const ssh: Record<string, unknown> = { host: entry.host, port: 22, username: entry.username, remotePath: '~' }
  if (entry.password) ssh.password = entry.password
  if (entry.remoteOs) ssh.remoteOs = entry.remoteOs
  if (opts.detachable !== undefined) ssh.detachable = opts.detachable
  spawnPty(w.win, sid, { ssh, provider: 'claude' } as never)
  let launched = false
  const t0 = Date.now()
  while (Date.now() - t0 < 90_000) {
    const st = states(w.events, sid)
    if (!launched && st.includes('awaiting-claude')) { getSshFlow(sid)!.launchClaude(); launched = true }
    if (st.includes('claude-running')) break
    await sleep(500)
  }
  const cap = opts.captureMs ?? 90_000
  const launchedAt = Date.now()
  let trustAnswered = false
  while (Date.now() - launchedAt < cap) {
    await sleep(1000)
    // First-run gate: a host/dir this claude has not trusted yet parks at the
    // trust prompt and never ticks the statusline. Answer it once, the way a
    // user in the app terminal would (Enter on the highlighted default). The
    // TUI paints with positioning escapes, so match on a stripped, despaced
    // pane — the raw byte stream carries the words fragmented.
    if (!trustAnswered) {
      const flat = pane(w.events, sid)
        .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')
        .replace(/\s/g, '')
      if (/trustthisfolder|Doyoutrust/i.test(flat)) {
        trustAnswered = true
        writePty(sid, '\r')
      }
    }
    if (updates(w.events).filter((u) => u.sessionId === sid).length >= 2) break
  }
  return w
}

function report(label: string, w: ReturnType<typeof makeWin>, sid: string): void {
  const u = updates(w.events)
  const p = pane(w.events, sid)
  console.log(`${label}: updates=${u.length} sids=${JSON.stringify([...new Set(u.map((x) => x.sessionId))])} wrapped=${p.includes('has-session')} states=${JSON.stringify([...new Set(states(w.events, sid))])} paneLen=${p.length}`)
  // Stripped pane tail — where claude actually IS when the capture ends.
  const stripped = p.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '').replace(/\r/g, '')
  console.log(`${label} pane-tail: ${JSON.stringify(stripped.slice(-350))}`)
}

/** Kill the remote tmux probe session over a separate key-auth exec (password
 *  hosts fall through — their probe sids are unique so nothing collides). */
function killRemoteTmux(entry: HostEntry, sid: string): void {
  try {
    execFileSync('ssh', [`${entry.username}@${entry.host}`, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      `tmux kill-session -t ccc-${sid} 2>/dev/null; "$HOME"/.claude/bin/tmux kill-session -t ccc-${sid} 2>/dev/null; true`], { timeout: 15000 })
  } catch { /* password-only host or session already gone */ }
}

beforeAll(() => { settingsState.value = {} })

describe('SSH statusline matrix (LIVE, on-demand)', () => {
  itIf(hosts.linuxKey)('key + tmux wrap (fresh): statusline updates arrive for the session id', async () => {
    const e = hosts.linuxKey!
    const sid = `lv1${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T1 key+tmux fresh', w, sid)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.linuxKey)('key + tmux reattach: statusline still updates after reconnect', async () => {
    const e = hosts.linuxKey!
    const sid = `lv2${Date.now().toString(36)}`
    const w1 = await runSession(sid, e)
    report('T2a first connect', w1, sid)
    const firstOk = updates(w1.events).some((u) => u.sessionId === sid)
    killPty(sid) // drop the local PTY; the remote tmux session survives
    await sleep(3000)
    const w2 = await runSession(sid, e, { win: makeWin() })
    report('T2b reattach', w2, sid)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(firstOk).toBe(true)
    expect(updates(w2.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 480_000)

  itIf(hosts.linuxKey)('key + NO tmux (detachable off): statusline via /dev/tty-or-pts', async () => {
    const e = hosts.linuxKey!
    const sid = `lv3${Date.now().toString(36)}`
    const w = await runSession(sid, e, { detachable: false })
    report('T3 key no-tmux', w, sid)
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.linuxPassword)('password + tmux: password auto-types and statusline updates', async () => {
    const e = hosts.linuxPassword!
    const sid = `lv4${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T4 password+tmux', w, sid)
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.linuxPassword)('password + NO tmux: statusline updates', async () => {
    const e = hosts.linuxPassword!
    const sid = `lv5${Date.now().toString(36)}`
    const w = await runSession(sid, e, { detachable: false })
    report('T5 password no-tmux', w, sid)
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.mac)('mac key: statusline updates (tmux as detected)', async () => {
    const e = hosts.mac!
    const sid = `lv6${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T6 mac', w, sid)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.windows)('windows remote (CONOUT$ shim): statusline updates', async () => {
    const e = hosts.windows!
    const sid = `lv7${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T7 windows', w, sid)
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)
})
