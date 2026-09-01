/**
 * ssh:pingHost — SCOPE and CAP (adversarial review, 2026-09-01).
 *
 * The tier-1 reachability channel used to take a host straight off the renderer
 * and hand it to `pingHost`, which spawns a real `ping` process. Two things were
 * missing, and the charset gate inside host-ping.ts answers neither:
 *
 *   SCOPE — "is this string safe in an argv?" is not "may this app dial it".
 *           Without a scope the channel is an unauthenticated outbound probe
 *           primitive (ICMP echo + a TCP:22 knock at any charset-valid address)
 *           running from the user's machine and network position: an internal
 *           port scanner and a beacon, driven by a compromised renderer. Both
 *           SSH siblings on this surface (`ssh:endRemote`,
 *           `ssh:checkDetachedLive`) already resolve their destination from the
 *           SAVED configs and never from the payload; this matches that rule.
 *
 *   CAP   — one process per call and no bound: a renderer loop was thousands of
 *           live subprocesses, a local DoS on the user's own machine.
 *
 * Driven through the REAL handler on a fake ipcMain with pty-manager, the
 * configs file and host-ping all mocked, so no host is ever dialled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HostPingResult } from '../../../src/shared/types'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
}))
vi.mock('../../../src/main/pty-manager', () => ({
  spawnPty: vi.fn(), writePty: vi.fn(), resizePty: vi.fn(), killPty: vi.fn(), getSshFlow: vi.fn(),
  endSshRemote: vi.fn(), probeTmuxLive: vi.fn(),
}))
vi.mock('../../../src/main/debug-capture', () => ({ logUserInput: vi.fn(), isDebugModeEnabled: () => false }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/legacy-version-manager', () => ({ isVersionInstalled: () => true, installVersion: vi.fn() }))
vi.mock('../../../src/main/services/pty-integrity-monitor', () => ({ getPtyIntegrityMonitor: () => ({ record: vi.fn(), report: vi.fn() }) }))
vi.mock('../../../src/main/canvas/canvas-session-link', () => ({ noteSessionSpawnForCanvas: vi.fn() }))
vi.mock('../../../src/main/credential-store', () => ({ loadCredential: () => null }))

let configsOnDisk: unknown = null
vi.mock('../../../src/main/config-manager', () => ({
  readConfig: (key: string) => (key === 'configs' ? configsOnDisk : null),
}))

/**
 * The SPAWN oracle. `pingHost` is the only thing in this channel that creates a
 * process, so "was it called" is exactly "was a process spawned" — asserted at
 * the seam rather than by counting `ping.exe`s.
 */
const pingHost = vi.fn<(host: string) => Promise<HostPingResult>>()
vi.mock('../../../src/main/host-ping', () => ({ pingHost: (h: string) => pingHost(h) }))

const { registerPtyHandlers, _resetPingInFlightForTest } = await import('../../../src/main/ipc/pty-handlers')
registerPtyHandlers(() => ({} as never))
const ping = handlers.get('ssh:pingHost')!

const SSH = { port: 22, username: 'mong', remotePath: '~/work' }
const sshCfg = (id: string, host: string) => ({ id, sessionType: 'ssh', sshConfig: { ...SSH, host } })

/** Resolve every probe immediately, reachable. */
const answerFast = (): void => {
  pingHost.mockImplementation(async (host) => ({ host, reachable: true, via: 'icmp' }))
}

/** Park every probe until `release()` — the shape a real slow/timing-out ping has. */
function parkProbes(): { release: () => void } {
  const gates: Array<() => void> = []
  pingHost.mockImplementation((host) => new Promise<HostPingResult>((resolve) => {
    gates.push(() => resolve({ host, reachable: false, via: 'none', reason: 'tcp-failed' }))
  }))
  return { release: () => { for (const g of gates) g() } }
}

beforeEach(() => {
  pingHost.mockReset()
  _resetPingInFlightForTest()
  configsOnDisk = null
  answerFast()
})

describe('ssh:pingHost — SCOPE: only a host some SAVED SSH config names', () => {
  it('probes a host that a saved SSH config names', async () => {
    configsOnDisk = [sshCfg('cfgA', 'pi.local')]
    const r = (await ping({}, { host: 'pi.local' })) as HostPingResult
    expect(pingHost).toHaveBeenCalledWith('pi.local')
    expect(r.reachable).toBe(true)
  })

  // Mutation to prove this can fail: drop the savedSshPingHosts() check from the
  // SSH_PING_HOST handler (pty-handlers.ts) — the probe then spawns for anything
  // that passes the charset.
  it('an UNLISTED host is refused and NEVER spawns a probe', async () => {
    configsOnDisk = [sshCfg('cfgA', 'pi.local')]
    for (const host of ['169.254.169.254', 'attacker.example', '10.0.0.7', 'localhost']) {
      const r = (await ping({}, { host })) as HostPingResult
      expect(r).toEqual({ host, reachable: false, via: 'none', reason: 'host-not-in-configs' })
    }
    expect(pingHost).not.toHaveBeenCalled()
  })

  it('answers the unlisted host rather than throwing — the caller is a 90s timer', async () => {
    // A throw here is an unhandled rejection on every tick of the reachability
    // scheduler, which is why this refusal is a RESULT and not an exception.
    configsOnDisk = []
    await expect(ping({}, { host: 'pi.local' })).resolves.toMatchObject({ reachable: false })
  })

  it('matches case-insensitively, because DNS is', async () => {
    configsOnDisk = [sshCfg('cfgA', 'Pi.Local')]
    const r = (await ping({}, { host: 'pi.local' })) as HostPingResult
    expect(pingHost).toHaveBeenCalledWith('pi.local')
    expect(r.reachable).toBe(true)
  })

  it('a NON-SSH config contributes no host', async () => {
    configsOnDisk = [{ id: 'cfgL', sessionType: 'local', sshConfig: { ...SSH, host: 'pi.local' } }]
    const r = (await ping({}, { host: 'pi.local' })) as HostPingResult
    expect(r.reason).toBe('host-not-in-configs')
    expect(pingHost).not.toHaveBeenCalled()
  })

  it('fails CLOSED on a missing or malformed configs file', async () => {
    for (const disk of [null, undefined, {}, 'not-an-array', [null, 42], [{ id: 'x', sessionType: 'ssh' }]]) {
      configsOnDisk = disk
      const r = (await ping({}, { host: 'pi.local' })) as HostPingResult
      expect(r.reason).toBe('host-not-in-configs')
    }
    expect(pingHost).not.toHaveBeenCalled()
  })

  it('still rejects a payload the schema refuses, before any config is read', async () => {
    configsOnDisk = [sshCfg('cfgA', 'pi.local')]
    for (const bad of [null, undefined, 'pi.local', { host: '' }, { host: 'x'.repeat(256) }, { host: 42 }]) {
      await expect(ping({}, bad)).rejects.toThrow()
    }
    expect(pingHost).not.toHaveBeenCalled()
  })
})

describe('ssh:pingHost — CAP: a renderer loop cannot spawn an unbounded process fleet', () => {
  it('DEDUPES concurrent probes of one host into a single spawn', async () => {
    configsOnDisk = [sshCfg('cfgA', 'pi.local')]
    const parked = parkProbes()
    const calls = Array.from({ length: 50 }, () => ping({}, { host: 'pi.local' }))
    // Mutation to prove this can fail: call `pingHost(host)` directly in the
    // handler with no in-flight map — this becomes 50.
    expect(pingHost).toHaveBeenCalledTimes(1)
    parked.release()
    const results = (await Promise.all(calls)) as HostPingResult[]
    for (const r of results) expect(r.reason).toBe('tcp-failed')
  })

  it('caps DISTINCT hosts in flight at 8; the rest are answered busy and never spawn', async () => {
    configsOnDisk = Array.from({ length: 40 }, (_, i) => sshCfg(`cfg${i}`, `h${i}.local`))
    const parked = parkProbes()

    const calls = Array.from({ length: 40 }, (_, i) => ping({}, { host: `h${i}.local` }))
    // Mutation to prove this can fail: remove the PING_MAX_IN_FLIGHT guard —
    // this becomes 40 concurrent `ping` processes.
    expect(pingHost).toHaveBeenCalledTimes(8)

    parked.release()
    const results = (await Promise.all(calls)) as HostPingResult[]
    expect(results.filter((r) => r.reason === 'busy')).toHaveLength(32)
    // A refusal is a NOT-REACHABLE answer, which the scheduler folds as a failed
    // probe. Demote-only means that costs a pill and never data.
    for (const r of results) expect(r.reachable).toBe(false)
  })

  it('releases the slot when a probe settles, so the cap is a ceiling and not a quota', async () => {
    configsOnDisk = Array.from({ length: 12 }, (_, i) => sshCfg(`cfg${i}`, `h${i}.local`))
    const parked = parkProbes()
    const first = Array.from({ length: 8 }, (_, i) => ping({}, { host: `h${i}.local` }))
    expect(await ping({}, { host: 'h9.local' })).toMatchObject({ reason: 'busy' })

    parked.release()
    await Promise.all(first)
    expect(pingHost).toHaveBeenCalledTimes(8)

    answerFast()
    expect(await ping({}, { host: 'h9.local' })).toMatchObject({ reachable: true })
    expect(pingHost).toHaveBeenCalledTimes(9)
  })
})
