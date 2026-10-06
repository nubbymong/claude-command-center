// Lane: mac host — key-auth combo. See statusline-harness.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  hosts, makeLivePort, runSession, report, killRemoteTmux,
  claudeRan, endSshRemote, killPty, settingsState,
  startConductorMcpServer, stopConductorMcpServer,
} from './statusline-harness'

const itIf = (e: unknown) => (e ? it : it.skip)

beforeAll(async () => {
  settingsState.value = {}
  await startConductorMcpServer(makeLivePort(2))
})
afterAll(() => { try { stopConductorMcpServer() } catch { /* already down */ } })

describe('SSH statusline matrix — mac lane (LIVE, on-demand)', () => {
  itIf(hosts.mac)('mac key: statusline updates (tmux as detected)', async () => {
    const e = hosts.mac!
    const sid = `lv6${Date.now().toString(36)}`
    const w = await runSession(sid, e)
    report('T6 mac', w, sid)
    const ended = await endSshRemote(sid) // #572: product End path first (see T1)
    killPty(sid)
    killRemoteTmux(e, sid)
    // The macOS login shell is zsh. Before the tmux targets were quoted, zsh
    // aborted both the tmux launch line and the End command on the bare
    // `=ccc-<sid>` word: claude never started (the setup handshake's
    // account-only updates were all that arrived) and End exited non-zero.
    // Both are asserted here, on the lane whose host has zsh as its default.
    expect(ended).toBe('completed')
    expect(claudeRan(w.events, sid)).toBe(true)
  }, 240_000)
})
