// Lane: windows host (WINDOWS_2) — CONOUT$ shim, tunnel POST, no tmux.
// See statusline-harness.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import {
  hosts, makeLivePort, runSession, report,
  updates, killPty, settingsState,
  startConductorMcpServer, stopConductorMcpServer,
} from './statusline-harness'

const itIf = (e: unknown) => (e ? it : it.skip)

beforeAll(async () => {
  settingsState.value = {}
  await startConductorMcpServer(makeLivePort(3))
})
afterAll(() => { try { stopConductorMcpServer() } catch { /* already down */ } })

describe('SSH statusline matrix — windows lane (LIVE, on-demand)', () => {
  itIf(hosts.windows)('windows remote (tunnel POST): statusline updates', async () => {
    const e = hosts.windows!
    const sid = `lv7${Date.now().toString(36)}`
    const w = await runSession(sid, e, { nudge: true })
    report('T7 windows', w, sid)
    killPty(sid)
    expect(updates(w.events).some((u) => u.sessionId === sid)).toBe(true)
  }, 240_000)
})
