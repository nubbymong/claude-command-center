// LIVE repro (#25 / #24 app-flow): two CONCURRENT sessions to the SAME host,
// driven through the REAL pty-manager SSH flow, both should reach claude/tmux.
//
// Reproduces the reported "2nd session connects, gets a terminal, but cannot open
// claude/tmux" by running two sessions at once (distinct ids, as the app does per
// launch) and reporting, per session, whether it reached `claude-running` and
// whether its pane shows the tmux wrapper / claude UI. On-demand only.
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { readFileSync, existsSync, mkdtempSync, appendFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'ccc-repro-'))
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
vi.mock('../../src/main/ipc/setup-handlers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/ipc/setup-handlers')>()),
  getResourcesDirectory: vi.fn(() => scratch),
}))

const { spawnPty, killPty, getSshFlow, writePty } = await import('../../src/main/pty-manager')
const { registerProvider } = await import('../../src/main/providers')
const { ClaudeProvider } = await import('../../src/main/providers/claude')
registerProvider(new ClaudeProvider())

interface HostEntry { host: string; username: string; port?: number }
const hostsPath = process.env.CCC_LIVE_HOSTS ?? join(process.cwd(), 'tests', 'live', 'hosts.local.json')
const hosts: Record<string, HostEntry> = existsSync(hostsPath) ? JSON.parse(readFileSync(hostsPath, 'utf-8')) : {}
const linux = hosts.linuxKey
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Captured { channel: string; payload: unknown }
function makeWin() {
  const events: Captured[] = []
  return { events, win: { isDestroyed: () => false, webContents: { send: (channel: string, payload?: unknown) => events.push({ channel, payload }) } } as never }
}
const states = (ev: Captured[], sid: string) => ev.filter((e) => e.channel === `ssh:flowState:${sid}`).map((e) => (e.payload as { state: string }).state)
const pane = (ev: Captured[], sid: string) => ev.filter((e) => e.channel === `pty:data:${sid}`).map((e) => String(e.payload)).join('')
const flat = (p: string) => p.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '').replace(/\s/g, '')

beforeAll(() => { settingsState.value = {} })

describe('LIVE repro: two concurrent sessions to one host (#25/#24)', () => {
  const run = linux ? it : it.skip

  run('both concurrent sessions reach claude/tmux', async () => {
    const e = linux as HostEntry
    const ssh = { host: e.host, port: e.port ?? 22, username: e.username, remotePath: '~' }
    const sidA = `rpa${Date.now().toString(36)}`
    const sidB = `rpb${Date.now().toString(36)}`
    const wA = makeWin(); const wB = makeWin()
    const sids: [string, ReturnType<typeof makeWin>][] = [[sidA, wA], [sidB, wB]]

    spawnPty(wA.win, sidA, { ssh, provider: 'claude' } as never)
    await sleep(400)
    spawnPty(wB.win, sidB, { ssh, provider: 'claude' } as never)

    const launched = new Set<string>()
    const trusted = new Set<string>()
    const t0 = Date.now()
    while (Date.now() - t0 < 150_000) {
      for (const [sid, w] of sids) {
        const st = states(w.events, sid)
        if (!launched.has(sid) && st.includes('awaiting-claude')) { getSshFlow(sid)?.launchClaude(); launched.add(sid) }
        // Trust prompt default is "No, exit" — pressing Enter EXITS claude. Move
        // DOWN to "Yes, I trust this folder" first, then confirm.
        if (!trusted.has(sid) && /trustthisfolder|Doyoutrust/i.test(flat(pane(w.events, sid)))) {
          trusted.add(sid)
          writePty(sid, '\x1b[B')
          setTimeout(() => writePty(sid, '\r'), 250)
        }
      }
      const done = sids.every(([sid, w]) => states(w.events, sid).includes('claude-running'))
      if (done) break
      await sleep(500)
    }

    const EV = process.env.CCC_REPRO_EVIDENCE ?? join(tmpdir(), 'ccc-repro-evidence.txt')
    const log = (s: string) => appendFileSync(EV, s + '\n')
    log(`\n==== repro run ${new Date().toISOString()} host=${e.host} ====`)
    for (const [sid, w] of sids) {
      const p = pane(w.events, sid)
      const st = [...new Set(states(w.events, sid))]
      const claudeUi = /esctocancel|trustthisfolder|Doyoutrust|❯|Bypassing|claude\*/i.test(flat(p))
      const bareShell = /\$\s*$|]\$$/.test(p.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '').trimEnd())
      log(`${sid}: claudeUi=${claudeUi} bareShell=${bareShell} states=${JSON.stringify(st)} paneLen=${p.length}`)
      log(`${sid} tail: ${JSON.stringify(flat(p).slice(-300))}`)
      writeFileSync(`${EV}.${sid}.pane.txt`, p) // full RAW pane for offline inspection
    }
    // Remote state snapshot for root-causing.
    try {
      const out = execFileSync('ssh', [`${e.username}@${e.host}`, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
        `tmux ls 2>&1; echo '---setup files---'; ls -1 ~/.claude/settings-${sidA}.json ~/.claude/settings-${sidB}.json ~/.claude/mcp-${sidA}.json ~/.claude/mcp-${sidB}.json 2>&1`],
        { encoding: 'utf8', timeout: 15000 })
      log(`remote:\n${out}`)
    } catch (err) { log(`remote snapshot failed: ${(err as Error).message}`) }

    killPty(sidA); killPty(sidB)
    for (const sid of [sidA, sidB]) {
      try { execFileSync('ssh', [`${e.username}@${e.host}`, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `tmux kill-session -t ccc-${sid} 2>/dev/null; true`], { timeout: 12000 }) } catch { /* gone */ }
    }

    // Assert on the PANE, not the flow state: the idle-fallback can latch
    // claude-running even when claude exited to a bare shell (the #25 false
    // green), so a state-only check would pass on the very bug this guards.
    const ok = (w: ReturnType<typeof makeWin>, sid: string) => {
      const p = pane(w.events, sid)
      const clean = p.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')
      const claudeUi = /esctocancel|trustthisfolder|Doyoutrust|❯|Bypassing|claude\*/i.test(flat(p))
      const bareShell = /[$#]\s*$/.test(clean.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, '')).filter(Boolean).pop() ?? '')
      return claudeUi && !bareShell
    }
    expect(ok(wA, sidA), 'session A shows a running claude (not a bare shell)').toBe(true)
    expect(ok(wB, sidB), 'session B shows a running claude (not a bare shell)').toBe(true)
  }, 200_000)
})
