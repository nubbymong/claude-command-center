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
//   rocky password + tmux (staged)         [linuxRocky]
//   rocky password + NO tmux               [linuxRocky]
//   rocky password + tmux — reattach       [linuxRocky]
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
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

const { spawnPty, killPty, getSshFlow, writePty, resizePty, endSshRemote } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
const { startStatuslineWatcher } = await import('../../src/main/statusline-watcher')
registerProvider(new ClaudeProvider())

interface HostEntry { host: string; username: string; password?: string; remoteOs?: 'windows' | 'unix' }
type Hosts = Partial<Record<'linuxKey' | 'linuxPassword' | 'linuxRocky' | 'mac' | 'windows', HostEntry>>
// Root-relative (vitest runs with the repo root as cwd); CCC_LIVE_HOSTS
// overrides for runners whose cwd is elsewhere. __dirname is not reliable
// under the ESM transform.
const hostsPath = process.env.CCC_LIVE_HOSTS ?? join(process.cwd(), 'tests', 'live', 'hosts.local.json')
const hosts: Hosts = existsSync(hostsPath) ? JSON.parse(readFileSync(hostsPath, 'utf-8')) : {}
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
// The 2026-08-27 Pi incident's signature: a stage sentinel that PARSED but
// with a corrupted capture (ConPTY-glued escapes -> `unsafe-path` /
// `invalid-reason`). A genuine environmental failure (download/digest/…) is
// possible on a degraded network and is not what this guards; these two
// reasons can only come from a mangled parse of a line the remote actually
// emitted, so any live run that produces one is a regression.
const misParsedStageFail = (ev: Captured[], sid: string) =>
  ev.filter((e) => e.channel === `ssh:flowState:${sid}`)
    .map((e) => (e.payload as { info?: string }).info ?? '')
    .filter((i) => /tmux-stage-fail:(unsafe-path|invalid-reason)/.test(i))
const pane = (ev: Captured[], sid: string) => ev.filter((e) => e.channel === `pty:data:${sid}`).map((e) => String(e.payload)).join('')

/** Connect, auto-launch claude at the overlay point, capture until 2 statusline
 *  updates (or the cap), return the captured window. */
async function runSession(sid: string, entry: HostEntry, opts: { detachable?: boolean; captureMs?: number; win?: ReturnType<typeof makeWin>; nudge?: boolean } = {}) {
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
  let nudged = false
  while (Date.now() - launchedAt < cap) {
    await sleep(1000)
    // Reattach (nudge): claude re-runs its statusline command on CONVERSATION
    // state changes, never on mere repaints — proven live 2026-08-27: a
    // resize made the reattached TUI redraw fully, yet 90s passed with zero
    // statusline ticks from an idle claude. So a reattached-but-idle session
    // legitimately sits at "pending" until something actually happens; what
    // the app promises is that the statusline RESUMES WITH ACTIVITY. Model
    // that the way a user would: after 15 quiet seconds, resize (what the
    // renderer's fit addon does on attach anyway) and type a line into
    // claude — the response (even "not logged in") is a state change and
    // must produce a tick through the reattached tmux client tty.
    if (opts.nudge && !nudged && Date.now() - launchedAt > 15_000 && updates(w.events).filter((u) => u.sessionId === sid).length === 0) {
      nudged = true
      resizePty(sid, 121, 30) // spawn default is 120x30 — one-column wiggle
      resizePty(sid, 120, 30)
      writePty(sid, 'hi')
      setTimeout(() => writePty(sid, '\r'), 300)
    }
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
  // Diagnostic capture (CCC_LIVE_DUMP=<dir>): the RAW pane byte stream and the
  // full captured event list, per test. This is how a sentinel mis-parse gets
  // root-caused from a live run — the pane bytes ARE the exact chunk stream
  // the pty-manager parsers saw (glued escapes included), so a failure can be
  // replayed against the parsers offline byte-for-byte.
  const dumpDir = process.env.CCC_LIVE_DUMP
  if (dumpDir) {
    const base = join(dumpDir, label.replace(/\W+/g, '_'))
    writeFileSync(`${base}.pane.bin`, p)
    writeFileSync(`${base}.events.json`, JSON.stringify(w.events.map((e) => ({ channel: e.channel, payload: e.channel.startsWith('pty:data') ? undefined : e.payload })), null, 1))
  }
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
    // #572: end through the PRODUCT path (before killPty, which clears the End
    // target) so the matrix exercises the same kill users click; the key-auth
    // exec below stays as belt-and-braces.
    await endSshRemote(sid)
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
    const w2 = await runSession(sid, e, { win: makeWin(), nudge: true })
    report('T2b reattach', w2, sid)
    await endSshRemote(sid) // #572: product End path first (see T1)
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
    // #572: THE leak this matrix used to plant on password hosts -- the old
    // key-auth-only cleanup silently no-opped here and every run left a claude
    // eating ~350MB of the host forever (the mongminer exhaustion). The product
    // End path now answers the password prompt itself; assert it worked.
    const ended = await endSshRemote(sid)
    killPty(sid)
    expect(ended).toBe('completed')
    expect(misParsedStageFail(w.events, sid)).toEqual([])
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.linuxPassword)('password + NO tmux: statusline updates', async () => {
    const e = hosts.linuxPassword!
    const sid = `lv5${Date.now().toString(36)}`
    const w = await runSession(sid, e, { detachable: false })
    report('T5 password no-tmux', w, sid)
    await endSshRemote(sid) // no tmux to kill, but this removes the remote sidecars
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.mac)('mac key: statusline updates (tmux as detected)', async () => {
    const e = hosts.mac!
    const sid = `lv6${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T6 mac', w, sid)
    await endSshRemote(sid) // #572: product End path first (see T1)
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

  // NB slot numbering: T8 is RESERVED in the shared Master Test Process
  // (aicc_planning discussion #20) for the auto-tmux-profile host scenario
  // ([ -z "$TMUX" ] && exec tmux new -A), which is a different host role and
  // still unfilled. Rocky (RHEL password host, no tmux at all) is a distinct
  // scenario, so it takes T9–T11 and leaves T8 for that slot.
  //
  // Rocky Linux (RHEL-family) over PASSWORD auth with NO tmux on the host — so
  // T9 exercises the tmux STAGING path (ccc stages its own tmux into
  // ~/.claude/bin) on a distro the Debian-family Pi does not cover, and holds
  // the same password-host contract as T4 (product End answers the prompt and
  // completes; no mis-parsed stage sentinel).
  itIf(hosts.linuxRocky)('rocky password + tmux (staged): statusline updates', async () => {
    const e = hosts.linuxRocky!
    const sid = `lv9${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T9 rocky pw+tmux', w, sid)
    const ended = await endSshRemote(sid) // #572 product End path (password prompt answered)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(ended).toBe('completed')
    expect(misParsedStageFail(w.events, sid)).toEqual([])
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.linuxRocky)('rocky password + NO tmux: statusline via /dev/tty-or-pts', async () => {
    const e = hosts.linuxRocky!
    const sid = `lv10${Date.now().toString(36)}`
    const w = await runSession(sid, e, { detachable: false })
    report('T10 rocky pw no-tmux', w, sid)
    await endSshRemote(sid) // no tmux to kill; removes the remote sidecars
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  // The ONLY password-auth reattach in the matrix (T2 is key-auth): drop the
  // local PTY, let the STAGED remote tmux survive, reconnect — which must
  // re-answer the password AND reattach to the live tmux — and prove the
  // statusline resumes with activity through the reattached client tty. Guards
  // the "SSH under user-owned tmux" reconnection path on RHEL specifically.
  itIf(hosts.linuxRocky)('rocky password + tmux reattach: statusline still updates after reconnect', async () => {
    const e = hosts.linuxRocky!
    const sid = `lv11${Date.now().toString(36)}`
    const w1 = await runSession(sid, e)
    report('T11a rocky first connect', w1, sid)
    const firstOk = updates(w1.events).some((u) => u.sessionId === sid)
    killPty(sid) // drop the local PTY; the remote staged-tmux session survives
    await sleep(3000)
    const w2 = await runSession(sid, e, { win: makeWin(), nudge: true })
    report('T11b rocky reattach', w2, sid)
    await endSshRemote(sid) // #572 product End path (password prompt answered)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(firstOk).toBe(true)
    expect(updates(w2.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 480_000)
})
