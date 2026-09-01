// Lane: linuxKey host (185) — key-auth combos. See statusline-harness.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  hosts, makeWin, makeLivePort, runSession, report, killRemoteTmux, sleep,
  updates, endSshRemote, killPty, settingsState,
  startConductorMcpServer, stopConductorMcpServer,
} from './statusline-harness'

const itIf = (e: unknown) => (e ? it : it.skip)

beforeAll(async () => {
  settingsState.value = {}
  await startConductorMcpServer(makeLivePort(0))
})
afterAll(() => { try { stopConductorMcpServer() } catch { /* already down */ } })

describe('SSH statusline matrix — 185 key lane (LIVE, on-demand)', () => {
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
})
