// Lane: linuxRocky host (RHEL-family) — password combos T9–T11, key combos
// T12–T13 (linuxRockyKey). T8 is RESERVED in the shared Master Test Process
// (aicc_planning discussion #20) for the auto-tmux-profile host scenario
// ([ -z "$TMUX" ] && exec tmux new -A), which is a different host role and
// still unfilled. See statusline-harness.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  hosts, makeWin, makeLivePort, runSession, report, killRemoteTmux, sleep,
  updates, misParsedStageFail, endSshRemote, killPty, settingsState,
  startConductorMcpServer, stopConductorMcpServer,
} from './statusline-harness'

const itIf = (e: unknown) => (e ? it : it.skip)

beforeAll(async () => {
  settingsState.value = {}
  await startConductorMcpServer(makeLivePort(4))
})
afterAll(() => { try { stopConductorMcpServer() } catch { /* already down */ } })

describe('SSH statusline matrix — rocky lane (LIVE, on-demand)', () => {
  // Rocky over PASSWORD auth with NO tmux on the host — T9 exercises the tmux
  // STAGING path (ccc stages its own tmux into ~/.claude/bin) on a distro the
  // Debian-family Pi does not cover, and holds the same password-host contract
  // as T4 (product End answers the prompt and completes; no mis-parsed stage
  // sentinel).
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

  // CSV coverage slots (2026-08-31): the matrix has keyless rows against the
  // RHEL host; prove the key-auth shape on the same box.
  itIf(hosts.linuxRockyKey)('rocky key + tmux (staged): statusline updates', async () => {
    const e = hosts.linuxRockyKey!
    const sid = `lv12${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T12 rocky key+tmux', w, sid)
    await endSshRemote(sid)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(misParsedStageFail(w.events, sid)).toEqual([])
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)

  itIf(hosts.linuxRockyKey)('rocky key + NO tmux: statusline updates', async () => {
    const e = hosts.linuxRockyKey!
    const sid = `lv13${Date.now().toString(36)}`
    const w = await runSession(sid, e, { detachable: false })
    report('T13 rocky key no-tmux', w, sid)
    await endSshRemote(sid)
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)
})
