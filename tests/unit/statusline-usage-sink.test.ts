// Plan P2: the account-usage page reuses an OPEN account's live figure. That
// figure is harvested at the statusline fan-out through setStatuslineUsageSink,
// so a live session's delivered usageBuckets reach the account cache. These tests
// drive the REAL fan-out via the exported dispatcher and assert what the sink
// receives -- they cannot pass by mocking the fan-out away.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({ BrowserWindow: class {} }))
// A REAL temp resources dir: startStatuslineWatcher mkdirs <resourcesDir>/status
// at module load, and an unwritable '/res' throws there (see the sibling
// sanitiser test's note).
vi.mock('../../src/main/ipc/setup-handlers', () => {
  const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-usage-sink-'))
  return { getResourcesDirectory: () => dir, registerSetupHandlers: () => {} }
})
vi.mock('../../src/main/account-color', () => ({ decorateStatuslineWithColour: (d: unknown) => d }))
vi.mock('../../src/main/providers/claude/telemetry', () => ({ notifyClaudeTelemetry: () => {} }))
vi.mock('../../src/main/sentinel/index', () => ({ sentinelObserve: () => {} }))
vi.mock('../../src/main/background-context', () => ({ isBackgroundContext: () => false }))
vi.mock('../../src/main/debug-logger', () => ({ logWarn: () => {}, logInfo: () => {}, logError: () => {}, logDebug: () => {} }))

const { dispatchSSHStatuslineUpdate, setStatuslineUsageSink, startStatuslineWatcher } = await import('../../src/main/statusline-watcher')

type SinkCall = { sessionId: string; buckets: unknown; hasCredits: boolean }
let calls: SinkCall[] = []
// The string-dispatch path no-ops until a window is registered (sshDispatchWindow),
// which only startStatuslineWatcher sets. A fake window is enough; the fan-out just
// calls webContents.send on it.
const fakeWin = { isDestroyed: () => false, webContents: { send: () => {} } }
let stopWatcher: (() => void) | null = null

beforeEach(() => {
  calls = []
  stopWatcher = startStatuslineWatcher(() => fakeWin as never)
  setStatuslineUsageSink((sessionId, buckets, hasCredits) => calls.push({ sessionId, buckets, hasCredits }))
})
afterEach(() => { stopWatcher?.(); stopWatcher = null })

const dispatch = (payload: Record<string, unknown>) => dispatchSSHStatuslineUpdate(JSON.stringify({ sessionId: 'sess-1', ...payload }))

describe('the statusline fan-out harvests delivered usage to the sink', () => {
  it('forwards the sessionId and the buckets when a payload carries usageBuckets', () => {
    const buckets = [{ key: 'session:', label: '5h', group: 'session', percent: 33, resetsAt: '', severity: 'normal' }]
    dispatch({ usageBuckets: buckets })
    expect(calls).toHaveLength(1)
    expect(calls[0].sessionId).toBe('sess-1')
    expect(calls[0].buckets).toEqual(buckets)
    expect(calls[0].hasCredits).toBe(false)
  })

  it('reports hasCredits when the payload also carries rateLimitExtra (paid credit enabled)', () => {
    dispatch({
      usageBuckets: [{ key: 'session:', label: '5h', group: 'session', percent: 5, resetsAt: '', severity: 'normal' }],
      rateLimitExtra: { enabled: true, utilization: 10, usedUsd: 1, limitUsd: 5 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].hasCredits).toBe(true)
  })

  it('does not call the sink for a payload with no usageBuckets', () => {
    dispatch({ model: 'sonnet', contextUsedPercent: 40 })
    expect(calls).toEqual([])
  })

  it('does not call the sink for an EMPTY usageBuckets array (nothing to serve)', () => {
    dispatch({ usageBuckets: [] })
    expect(calls).toEqual([])
  })

  it('a sink that throws never breaks the fan-out', () => {
    setStatuslineUsageSink(() => { throw new Error('sink boom') })
    expect(() => dispatch({ usageBuckets: [{ key: 'session:', label: '5h', group: 'session', percent: 1, resetsAt: '', severity: 'normal' }] })).not.toThrow()
  })
})
