// Lane: linuxPassword host (Pi) — password combos + key combos (linuxPiKey).
// See statusline-harness.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  hosts, makeLivePort, runSession, report, killRemoteTmux,
  updates, misParsedStageFail, endSshRemote, killPty, settingsState,
  startConductorMcpServer, stopConductorMcpServer,
} from './statusline-harness'

const itIf = (e: unknown) => (e ? it : it.skip)

beforeAll(async () => {
  settingsState.value = {}
  await startConductorMcpServer(makeLivePort(1))
})
afterAll(() => { try { stopConductorMcpServer() } catch { /* already down */ } })

describe('SSH statusline matrix — Pi lane (LIVE, on-demand)', () => {
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

  // CSV coverage slots (2026-08-31): the matrix has keyless rows against the
  // Debian-family password host; prove the key-auth shape on the same box.
  itIf(hosts.linuxPiKey)('pi key + tmux: statusline updates', async () => {
    const e = hosts.linuxPiKey!
    const sid = `lv14${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T14 pi key+tmux', w, sid)
    await endSshRemote(sid)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.linuxPiKey)('pi key + NO tmux: statusline updates', async () => {
    const e = hosts.linuxPiKey!
    const sid = `lv15${Date.now().toString(36)}`
    const w = await runSession(sid, e, { detachable: false })
    report('T15 pi key no-tmux', w, sid)
    await endSshRemote(sid)
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)
})
