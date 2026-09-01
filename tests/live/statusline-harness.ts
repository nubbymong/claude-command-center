// Shared harness for the LIVE SSH/statusline connectivity matrix lanes.
//
// Drives the REAL pty-manager (real node-pty, real ssh) with only electron +
// config-manager mocked, against the hosts in tests/live/hosts.local.json
// (gitignored; see hosts.example.json), and asserts the REAL statusline
// pipeline (shim → OSC sentinel → extractSshOscSentinels →
// dispatchSSHStatuslineUpdate → fanOutStatusline) delivers
// `statusline:update` events for the session's own id — the exact signal the
// renderer's statusline row waits on ("pending" until the first one lands).
//
// The matrix is split into one *.live.ts file PER TARGET HOST so vitest can run
// the lanes in parallel (distinct hosts share no remote state); combos against
// the SAME host stay ordered inside their lane file. Each lane starts its own
// conductor MCP server on a distinct port (makeLivePort) so parallel workers
// never collide on the listener.
//
// vi.mock note: these mocks register at harness-import time, BEFORE the
// dynamic `await import` calls below pull in pty-manager — the same ordering
// the original single-file pack relied on.
import { vi } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'ccc-live-'))
export const settingsState: { value: Record<string, unknown> } = { value: {} }
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

export const { spawnPty, killPty, getSshFlow, writePty, resizePty, endSshRemote } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
const { startStatuslineWatcher } = await import('../../src/main/statusline-watcher')
// Tier-0 delivery (harmonise-remote): the REAL conductor MCP server, so the
// spawn path allocates the `-R` reverse tunnel and bakes the /status POST URL
// into the remote statusLine command — the matrix proves the tunnel delivery
// end-to-end, not just the legacy OSC ladders.
export const { startConductorMcpServer, stopConductorMcpServer } = await import('../../src/main/conductor-mcp-server')
registerProvider(new ClaudeProvider())

/** Per-lane MCP port: base (env CCC_LIVE_MCP_PORT or 43199) + lane offset. */
export const makeLivePort = (offset: number) => Number(process.env.CCC_LIVE_MCP_PORT ?? 43199) + offset

export interface HostEntry { host: string; username: string; password?: string; remoteOs?: 'windows' | 'unix' }
export type Hosts = Partial<Record<'linuxKey' | 'linuxPassword' | 'linuxRocky' | 'linuxRockyKey' | 'linuxPiKey' | 'mac' | 'windows', HostEntry>>
// Root-relative (vitest runs with the repo root as cwd); CCC_LIVE_HOSTS
// overrides for runners whose cwd is elsewhere. __dirname is not reliable
// under the ESM transform.
const hostsPath = process.env.CCC_LIVE_HOSTS ?? join(process.cwd(), 'tests', 'live', 'hosts.local.json')
export const hosts: Hosts = existsSync(hostsPath) ? JSON.parse(readFileSync(hostsPath, 'utf-8')) : {}
export const itIfHost = (entry: HostEntry | undefined) => Boolean(entry)

export interface Captured { channel: string; payload: unknown }
export function makeWin() {
  const events: Captured[] = []
  return {
    events,
    win: {
      isDestroyed: () => false,
      webContents: { send: (channel: string, payload?: unknown) => { events.push({ channel, payload }) } },
    } as never,
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const updates = (ev: Captured[]) => ev.filter((e) => e.channel === 'statusline:update').map((e) => e.payload as { sessionId?: string })
export const states = (ev: Captured[], sid: string) => ev.filter((e) => e.channel === `ssh:flowState:${sid}`).map((e) => (e.payload as { state: string }).state)
// The 2026-08-27 Pi incident's signature: a stage sentinel that PARSED but
// with a corrupted capture (ConPTY-glued escapes -> `unsafe-path` /
// `invalid-reason`). A genuine environmental failure (download/digest/…) is
// possible on a degraded network and is not what this guards; these two
// reasons can only come from a mangled parse of a line the remote actually
// emitted, so any live run that produces one is a regression.
export const misParsedStageFail = (ev: Captured[], sid: string) =>
  ev.filter((e) => e.channel === `ssh:flowState:${sid}`)
    .map((e) => (e.payload as { info?: string }).info ?? '')
    .filter((i) => /tmux-stage-fail:(unsafe-path|invalid-reason)/.test(i))
export const pane = (ev: Captured[], sid: string) => ev.filter((e) => e.channel === `pty:data:${sid}`).map((e) => String(e.payload)).join('')

const stripPane = (p: string) => p
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')
const TRUST_RE = /trustthisfolder|Doyoutrust/i

/** Connect, auto-launch claude at the overlay point, capture until 2 statusline
 *  updates (or the cap), return the captured window.
 *
 *  Nudge (ON by default since the lane split): claude re-runs its statusLine
 *  command on CONVERSATION state changes, never on mere repaints — proven live
 *  2026-08-27. An IDLE claude therefore ticks once at launch and never again,
 *  which used to make every fresh combo sit out the full 90s cap waiting for a
 *  second tick that could not come. Model activity the way a user would: after
 *  12 quiet seconds, resize (what the renderer's fit addon does on attach
 *  anyway) and type a line — the response (even "not logged in") is a state
 *  change and must produce a tick. This cut a fresh combo from ~93s to ~25s. */
export async function runSession(sid: string, entry: HostEntry, opts: { detachable?: boolean; captureMs?: number; win?: ReturnType<typeof makeWin>; nudge?: boolean; runtime?: import('../../src/shared/types').SshRuntime; sudoPassword?: string } = {}) {
  const w = opts.win ?? makeWin()
  try { startStatuslineWatcher(() => w.win as never) } catch { /* status-dir watch is irrelevant here */ }
  const ssh: Record<string, unknown> = { host: entry.host, port: 22, username: entry.username, remotePath: '~' }
  if (entry.password) ssh.password = entry.password
  if (entry.remoteOs) ssh.remoteOs = entry.remoteOs
  if (opts.detachable !== undefined) ssh.detachable = opts.detachable
  // Item e (docker lane): structured container runtime — the spawn composes
  // the [sudo] docker|podman exec command itself, exactly like the product.
  if (opts.runtime) ssh.runtime = opts.runtime
  if (opts.sudoPassword) ssh.sudoPassword = opts.sudoPassword
  spawnPty(w.win, sid, { ssh, provider: 'claude' } as never)
  let launched = false
  let postCmdRun = false
  const t0 = Date.now()
  while (Date.now() - t0 < 90_000) {
    const st = states(w.events, sid)
    // Container/prep flow: click "Run command" at the overlay point, the same
    // consent a user gives; the inner shell then re-raises awaiting-claude.
    if (!postCmdRun && st.includes('awaiting-postcommand')) { getSshFlow(sid)!.runPostCommand(); postCmdRun = true }
    if (!launched && st.includes('awaiting-claude')) { getSshFlow(sid)!.launchClaude(); launched = true }
    if (st.includes('claude-running')) break
    await sleep(500)
  }
  const cap = opts.captureMs ?? 90_000
  const launchedAt = Date.now()
  const nudgeOn = opts.nudge ?? true
  let trustAnswered = false
  let nudged = false
  while (Date.now() - launchedAt < cap) {
    await sleep(1000)
    // First-run gate: a host/dir this claude has not trusted yet parks at the
    // trust prompt and never ticks the statusline. Answer it once, the way a
    // user in the app terminal would (Enter on the highlighted default). The
    // TUI paints with positioning escapes, so match on a stripped, despaced
    // pane — the raw byte stream carries the words fragmented.
    const flat = stripPane(pane(w.events, sid)).replace(/\s/g, '')
    const trustPending = !trustAnswered && TRUST_RE.test(flat)
    if (trustPending) {
      trustAnswered = true
      // Newer claude (seen 2.1.251 on a Windows remote, 2026-08-30): the
      // dialog's HIGHLIGHTED DEFAULT is "No, exit" — a bare Enter EXITS
      // claude (the T7 zero-updates run: claude was gone before its first
      // statusline tick, and the nudge's "hi" landed in cmd.exe). When the
      // caret sits on the No option, step down to "Yes, I trust this
      // folder" first. Older dialogs keep the old default-Enter behaviour.
      if (flat.includes('❯No,exit')) {
        writePty(sid, '\x1b[B')
        setTimeout(() => writePty(sid, '\r'), 250)
      } else {
        writePty(sid, '\r')
      }
    }
    const ticks = updates(w.events).filter((u) => u.sessionId === sid).length
    if (nudgeOn && !nudged && !trustPending && Date.now() - launchedAt > 12_000 && ticks < 2) {
      nudged = true
      resizePty(sid, 121, 30) // spawn default is 120x30 — one-column wiggle
      resizePty(sid, 120, 30)
      writePty(sid, 'hi')
      setTimeout(() => writePty(sid, '\r'), 300)
    }
    if (ticks >= 2) break
  }
  return w
}

export function report(label: string, w: ReturnType<typeof makeWin>, sid: string): void {
  const u = updates(w.events)
  const p = pane(w.events, sid)
  // Slice-2 evidence: the harmonised fields — account + per-model buckets
  // (Fable) + windows — printed from the LAST update so a live run's output
  // shows what the renderer would actually receive.
  const last = u.filter((x) => x.sessionId === sid).slice(-1)[0] as Record<string, unknown> | undefined
  if (last) {
    const buckets = Array.isArray(last.usageBuckets)
      ? (last.usageBuckets as Array<{ label?: string; percent?: number }>).map((b) => `${b.label}:${b.percent}%`).join(',')
      : '-'
    console.log(`${label} payload: account=${last.accountEmail ?? '-'} buckets=${buckets} 5h=${last.rateLimitCurrent ?? '-'} wk=${last.rateLimitWeekly ?? '-'}`)
  }
  console.log(`${label}: updates=${u.length} sids=${JSON.stringify([...new Set(u.map((x) => x.sessionId))])} wrapped=${p.includes('has-session')} states=${JSON.stringify([...new Set(states(w.events, sid))])} paneLen=${p.length}`)
  // Stripped pane tail — where claude actually IS when the capture ends.
  const stripped = stripPane(p).replace(/\r/g, '')
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
export function killRemoteTmux(entry: HostEntry, sid: string): void {
  try {
    execFileSync('ssh', [`${entry.username}@${entry.host}`, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
      `tmux kill-session -t ccc-${sid} 2>/dev/null; "$HOME"/.claude/bin/tmux kill-session -t ccc-${sid} 2>/dev/null; true`], { timeout: 15000 })
  } catch { /* password-only host or session already gone */ }
}
