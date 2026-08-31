/**
 * SSH Persistent — the TIER 1 ping scheduler (stores/hostReachability.ts).
 *
 * The whole point of the model is what does NOT happen, so most of these tests
 * assert a negative:
 *   - no SSH on a timer: a ping tick never calls `checkDetachedLive`;
 *   - demote-only: a reachable ping never makes anything 'live';
 *   - one ping per HOST, never per entry;
 *   - the recovery verify fires exactly once, on the demoted -> reachable
 *     transition, and not again while the host stays up;
 *   - the timer exists only between arm and disarm;
 *   - a detached entry arms NO watchdog and NO sleep/moon path.
 *
 * Fake timers throughout; both IPCs are mocked, so no network of any kind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { DetachedRemote, DetachedRemoteLiveness, HostPingResult } from '../../../src/shared/types'

const pingHost = vi.fn<[{ host: string }], Promise<HostPingResult>>()
const checkDetachedLive = vi.fn<[{ configId: string; sessionIds: string[] }], Promise<DetachedRemoteLiveness>>()
const save = vi.fn(() => Promise.resolve(true))
/** Everything else the renderer could reach. Any call here is a leak. */
const watchdogStart = vi.fn()
const watchdogStop = vi.fn()

vi.stubGlobal('window', {
  electronAPI: {
    ssh: { pingHost, checkDetachedLive },
    session: { save },
    watchdog: { start: watchdogStart, stop: watchdogStop },
  },
})

const { useDetachedRemotesStore } = await import('../../../src/renderer/stores/detachedRemotesStore')
const { useDetachedLivenessStore } = await import('../../../src/renderer/stores/livenessStore')
const { useConfigStore } = await import('../../../src/renderer/stores/configStore')
const {
  useHostReachabilityStore,
  pingAllDetachedHosts,
  armHostPings,
  disarmHostPings,
  isHostPingArmed,
  resetHostReachability,
  HOST_PING_INTERVAL_MS,
} = await import('../../../src/renderer/stores/hostReachability')

const entry = (id: string, host: string, configId = 'cfg-1'): DetachedRemote => ({
  sessionId: id,
  configId,
  host,
  username: 'mong',
  remotePath: '~/work',
  mux: 'tmux',
  label: id,
  detachedAt: 1,
})

const cfg = (id: string, host: string): any => ({
  id,
  label: id,
  sessionType: 'ssh',
  sshConfig: { host, port: 22, username: 'mong', remotePath: '~/work' },
})

const reachable = (host: string): HostPingResult => ({ host, reachable: true, via: 'icmp' })
const unreachable = (host: string): HostPingResult => ({ host, reachable: false, via: 'none', reason: 'tcp-failed' })

beforeEach(() => {
  vi.useFakeTimers()
  pingHost.mockReset()
  checkDetachedLive.mockReset()
  checkDetachedLive.mockResolvedValue({ outcome: 'verified', liveSessionIds: [] })
  save.mockClear()
  watchdogStart.mockClear()
  watchdogStop.mockClear()
  resetHostReachability()
  useDetachedRemotesStore.setState({ entries: [] })
  useDetachedLivenessStore.setState({ bySession: {} })
  useConfigStore.setState({ configs: [] } as never)
})

afterEach(() => {
  resetHostReachability()
  vi.useRealTimers()
})

describe('per-host dedupe', () => {
  it('three entries on ONE host cost exactly one ping', async () => {
    useDetachedRemotesStore.setState({
      entries: [entry('a', 'pi.local'), entry('b', 'pi.local'), entry('c', 'pi.local')],
    })
    pingHost.mockResolvedValue(reachable('pi.local'))
    await pingAllDetachedHosts()
    expect(pingHost).toHaveBeenCalledTimes(1)
    expect(pingHost).toHaveBeenCalledWith({ host: 'pi.local' })
  })

  it('entries across two hosts cost one ping each', async () => {
    useDetachedRemotesStore.setState({
      entries: [entry('a', 'pi.local'), entry('b', 'mac.local'), entry('c', 'pi.local')],
    })
    pingHost.mockImplementation(async ({ host }) => reachable(host))
    await pingAllDetachedHosts()
    expect(pingHost).toHaveBeenCalledTimes(2)
    expect(pingHost.mock.calls.map((c) => c[0].host).sort()).toEqual(['mac.local', 'pi.local'])
  })

  it('an empty registry pings nothing', async () => {
    await pingAllDetachedHosts()
    expect(pingHost).not.toHaveBeenCalled()
  })
})

describe('demote-only', () => {
  beforeEach(() => {
    useDetachedRemotesStore.setState({ entries: [entry('a', 'pi.local'), entry('b', 'pi.local')] })
    useConfigStore.setState({ configs: [cfg('cfg-1', 'pi.local')] } as never)
  })

  it('a reachable ping NEVER marks a session live and NEVER runs an SSH verify', async () => {
    pingHost.mockResolvedValue(reachable('pi.local'))
    await pingAllDetachedHosts()
    expect(useHostReachabilityStore.getState().byHost['pi.local'].reachable).toBe(true)
    // The liveness map — the only thing that can say 'live' — is untouched.
    expect(useDetachedLivenessStore.getState().bySession).toEqual({})
    expect(checkDetachedLive).not.toHaveBeenCalled()
  })

  it('ONE failed tick does nothing; the SECOND consecutive one demotes the host', async () => {
    pingHost.mockResolvedValue(unreachable('pi.local'))
    await pingAllDetachedHosts()
    expect(useHostReachabilityStore.getState().byHost['pi.local']).toMatchObject({ reachable: true, consecutiveFailures: 1 })

    await pingAllDetachedHosts()
    expect(useHostReachabilityStore.getState().byHost['pi.local']).toMatchObject({ reachable: false, consecutiveFailures: 2 })
    // Still no ssh: demotion is a local inference, not a probe.
    expect(checkDetachedLive).not.toHaveBeenCalled()
  })

  it('a success resets the counter', async () => {
    pingHost.mockResolvedValue(unreachable('pi.local'))
    await pingAllDetachedHosts()
    pingHost.mockResolvedValue(reachable('pi.local'))
    await pingAllDetachedHosts()
    expect(useHostReachabilityStore.getState().byHost['pi.local'].consecutiveFailures).toBe(0)
  })

  it('a REJECTING ping IPC counts as a failure, not a crash', async () => {
    pingHost.mockRejectedValue(new Error('ipc down'))
    await pingAllDetachedHosts()
    await pingAllDetachedHosts()
    expect(useHostReachabilityStore.getState().byHost['pi.local'].reachable).toBe(false)
  })

  it('a MISSING pingHost API records nothing — absence of evidence never demotes', async () => {
    const ssh = (window as never as { electronAPI: { ssh: Record<string, unknown> } }).electronAPI.ssh
    const saved = ssh.pingHost
    ssh.pingHost = undefined
    try {
      await pingAllDetachedHosts()
      expect(useHostReachabilityStore.getState().byHost).toEqual({})
    } finally {
      ssh.pingHost = saved
    }
  })
})

describe('recovery: the "host came back" event', () => {
  beforeEach(() => {
    useDetachedRemotesStore.setState({ entries: [entry('a', 'pi.local'), entry('b', 'pi.local'), entry('c', 'pi.local')] })
    useConfigStore.setState({ configs: [cfg('cfg-1', 'pi.local')] } as never)
  })

  const demote = async () => {
    pingHost.mockResolvedValue(unreachable('pi.local'))
    await pingAllDetachedHosts()
    await pingAllDetachedHosts()
  }

  it('fires EXACTLY ONE SSH verify per host transition — not one per entry', async () => {
    await demote()
    expect(checkDetachedLive).not.toHaveBeenCalled()

    pingHost.mockResolvedValue(reachable('pi.local'))
    await pingAllDetachedHosts()
    await vi.advanceTimersByTimeAsync(0)

    expect(checkDetachedLive).toHaveBeenCalledTimes(1)
    expect(checkDetachedLive).toHaveBeenCalledWith({ configId: 'cfg-1', sessionIds: ['a', 'b', 'c'] })
  })

  it('does NOT fire again while the host stays up', async () => {
    await demote()
    pingHost.mockResolvedValue(reachable('pi.local'))
    await pingAllDetachedHosts()
    await vi.advanceTimersByTimeAsync(0)
    checkDetachedLive.mockClear()

    await pingAllDetachedHosts()
    await pingAllDetachedHosts()
    await vi.advanceTimersByTimeAsync(0)
    expect(checkDetachedLive).not.toHaveBeenCalled()
  })

  it('a single flaky failure followed by a success fires NO verify (never demoted)', async () => {
    pingHost.mockResolvedValue(unreachable('pi.local'))
    await pingAllDetachedHosts()
    pingHost.mockResolvedValue(reachable('pi.local'))
    await pingAllDetachedHosts()
    await vi.advanceTimersByTimeAsync(0)
    expect(checkDetachedLive).not.toHaveBeenCalled()
  })

  it('only the RECOVERED host is verified when two hosts differ', async () => {
    useDetachedRemotesStore.setState({ entries: [entry('a', 'pi.local'), entry('m', 'mac.local', 'cfg-2')] })
    useConfigStore.setState({ configs: [cfg('cfg-1', 'pi.local'), cfg('cfg-2', 'mac.local')] } as never)
    pingHost.mockImplementation(async ({ host }) => (host === 'pi.local' ? unreachable(host) : reachable(host)))
    await pingAllDetachedHosts()
    await pingAllDetachedHosts()
    expect(checkDetachedLive).not.toHaveBeenCalled()

    pingHost.mockImplementation(async ({ host }) => reachable(host))
    await pingAllDetachedHosts()
    await vi.advanceTimersByTimeAsync(0)
    expect(checkDetachedLive).toHaveBeenCalledTimes(1)
    expect(checkDetachedLive.mock.calls[0][0].configId).toBe('cfg-1')
  })
})

describe('arm / disarm (the timer exists only while armed)', () => {
  beforeEach(() => {
    useDetachedRemotesStore.setState({ entries: [entry('a', 'pi.local')] })
    pingHost.mockImplementation(async ({ host }) => reachable(host))
  })

  it('nothing ticks before arming, however long time passes', async () => {
    expect(isHostPingArmed()).toBe(false)
    await vi.advanceTimersByTimeAsync(HOST_PING_INTERVAL_MS * 5)
    expect(pingHost).not.toHaveBeenCalled()
  })

  it('arming runs one pass immediately, then one per interval', async () => {
    armHostPings()
    expect(isHostPingArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(pingHost).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(HOST_PING_INTERVAL_MS)
    expect(pingHost).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(HOST_PING_INTERVAL_MS)
    expect(pingHost).toHaveBeenCalledTimes(3)
  })

  it('DISARM stops the clock', async () => {
    armHostPings()
    await vi.advanceTimersByTimeAsync(HOST_PING_INTERVAL_MS)
    const seen = pingHost.mock.calls.length
    disarmHostPings()
    expect(isHostPingArmed()).toBe(false)
    await vi.advanceTimersByTimeAsync(HOST_PING_INTERVAL_MS * 5)
    expect(pingHost).toHaveBeenCalledTimes(seen)
  })

  it('arming twice does not stack a second timer', async () => {
    armHostPings()
    armHostPings()
    await vi.advanceTimersByTimeAsync(0)
    expect(pingHost).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOST_PING_INTERVAL_MS)
    expect(pingHost).toHaveBeenCalledTimes(2)
  })

  it('the TIMER itself never runs an SSH verify', async () => {
    armHostPings()
    await vi.advanceTimersByTimeAsync(HOST_PING_INTERVAL_MS * 10)
    expect(pingHost.mock.calls.length).toBeGreaterThan(5)
    expect(checkDetachedLive).not.toHaveBeenCalled()
  })
})

describe('detached entries arm no watchdog and no sleep/moon path', () => {
  it('a full arm -> demote -> recover cycle touches no watchdog API', async () => {
    useDetachedRemotesStore.setState({ entries: [entry('a', 'pi.local'), entry('b', 'pi.local')] })
    useConfigStore.setState({ configs: [cfg('cfg-1', 'pi.local')] } as never)
    pingHost.mockResolvedValue(unreachable('pi.local'))
    armHostPings()
    await vi.advanceTimersByTimeAsync(HOST_PING_INTERVAL_MS * 2)
    pingHost.mockResolvedValue(reachable('pi.local'))
    await vi.advanceTimersByTimeAsync(HOST_PING_INTERVAL_MS)
    disarmHostPings()

    expect(watchdogStart).not.toHaveBeenCalled()
    expect(watchdogStop).not.toHaveBeenCalled()
  })

  it('a detached entry never becomes a SESSION — the watchdog and the moon only ever see sessions', async () => {
    const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
    useSessionStore.setState({ sessions: [], activeSessionId: null })
    useDetachedRemotesStore.setState({ entries: [entry('a', 'pi.local')] })
    pingHost.mockResolvedValue(reachable('pi.local'))
    await pingAllDetachedHosts()
    // The registry is a separate store by design: the watchdog (main, per PTY)
    // and the sleep/moon store (fed only by watchdog health pushes) both key off
    // live sessions, so an entry that has no PTY cannot reach either.
    expect(useSessionStore.getState().sessions).toEqual([])
  })
})
