// Lane: mac host — key-auth combo. See statusline-harness.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  hosts, makeLivePort, runSession, report, killRemoteTmux,
  updates, endSshRemote, killPty, settingsState,
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
    await endSshRemote(sid) // #572: product End path first (see T1)
    killPty(sid)
    killRemoteTmux(e, sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)
})
