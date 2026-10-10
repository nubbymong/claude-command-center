// [host] WP2 PR 4, P4.7 (row 68): `insights:run` and `insights:runAll` at the
// IPC boundary. A run starts only for the app's own window (its top frame),
// and a request is held to a strict check: the provider, and an account of
// that provider's class -- a Claude Code run names a profile (never a
// registry id), a Codex run a registry account (`acct-`), and a per-run
// confirmation only with the Codex account it names. The refusals the plan
// lists: an unknown provider, a wrong id class, a mismatched provider.
// Electron and the runner are fakes; nothing runs.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { notAppMainFrameEvents } from '../../helpers/app-window-events'

const h = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  calls: [] as Array<[string, unknown]>,
  logs: [] as string[],
}))
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { h.logs.push(a.map(String).join(' ')) },
  logWarn: (...a: unknown[]) => { h.logs.push(a.map(String).join(' ')) },
  logError: (...a: unknown[]) => { h.logs.push(a.map(String).join(' ')) },
  logDebug: () => {}, logTrace: () => {}, setVerboseMode: () => {}, isVerboseMode: () => false, setVerboseBaseline: () => {},
  setTraceMode: () => {}, isTraceMode: () => false, installGlobalErrorHandlers: () => {}, closeDebugLogger: () => {},
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (event: unknown, ...args: unknown[]) => unknown) => { h.handlers.set(ch, fn) } },
  BrowserWindow: class {},
}))
vi.mock('../../../src/main/insights-runner', () => ({
  runInsights: async (_w: unknown, opts: unknown) => { h.calls.push(['claude', opts]); return 'run-claude' },
  runCodexInsights: async (_w: unknown, opts: unknown) => { h.calls.push(['codex', opts]); return 'run-codex' },
  runCrossAccountInsights: async (_w: unknown, opts: unknown) => { h.calls.push(['all', opts]); return 'run-all' },
  // The reads answer something other than their empty value, so an answered
  // read and a refused one can be told apart.
  getCatalogue: () => { h.calls.push(['getCatalogue', undefined]); return { runs: [{ id: 'run-1' }] } },
  getInsightsReport: (id: unknown) => { h.calls.push(['getReport', id]); return '<html>report</html>' },
  getInsightsKpis: (id: unknown) => { h.calls.push(['getKpis', id]); return { kpis: [] } },
  getLatestRun: () => { h.calls.push(['getLatest', undefined]); return { id: 'run-1' } },
  isRunning: () => { h.calls.push(['isRunning', undefined]); return true },
  isValidRunId: (id: unknown) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id),
  cleanupStuckRuns: () => {},
}))

const { registerInsightsHandlers, checkInsightsRunRequest, checkInsightsRunAllRequest, INSIGHTS_REJECTED_INVALID, INSIGHTS_REJECTED_UNTRUSTED } =
  await import('../../../src/main/ipc/insights-handlers')

const ACCT = `acct-${'0123456789abcdef'}`
const mainFrame = {}
const webContents = { mainFrame }
let destroyed = false
const win = { isDestroyed: () => destroyed, webContents }
/** Read by main's getter at call time: null is "no window" (none yet, or a closed one not re-created). */
let current: typeof win | null = win
const appEvent = { sender: webContents, senderFrame: mainFrame }
const subFrameEvent = { sender: webContents, senderFrame: {} }
const otherEvent = { sender: {}, senderFrame: {} }

beforeEach(() => {
  h.handlers.clear()
  h.calls = []
  h.logs.length = 0
  destroyed = false
  current = win
  registerInsightsHandlers(() => current as never)
})
const run = (event: unknown, opts?: unknown) => h.handlers.get('insights:run')!(event, opts)
const runAll = (event: unknown, opts?: unknown) => h.handlers.get('insights:runAll')!(event, opts)

describe('insights:run', () => {
  it('a Claude Code run as before: no options, a profile, or provider claude [host]', async () => {
    expect(await run(appEvent)).toBe('run-claude')
    expect(await run(appEvent, { profileId: 'profile-abc' })).toBe('run-claude')
    expect(await run(appEvent, { profileId: 'profile-abc', provider: 'claude' })).toBe('run-claude')
    expect(h.calls).toEqual([['claude', undefined], ['claude', { profileId: 'profile-abc' }], ['claude', { profileId: 'profile-abc' }]])
  })

  it('a Claude Code profile id that is not valid is dropped, as before (the runner uses the primary) [host]', async () => {
    await run(appEvent, { profileId: '../../x' })
    expect(h.calls).toEqual([['claude', undefined]])
  })

  it('a Codex run names a Codex account; its confirmation travels only with that account [host]', async () => {
    expect(await run(appEvent, { profileId: ACCT, provider: 'codex' })).toBe('run-codex')
    expect(await run(appEvent, { profileId: ACCT, provider: 'codex', acknowledgeRealmOnly: true })).toBe('run-codex')
    expect(h.calls).toEqual([['codex', { accountId: ACCT }], ['codex', { accountId: ACCT, acknowledgeRealmOnly: true }]])
  })

  it('refused, answered and never run: an unknown provider [host]', async () => {
    for (const provider of ['gemini', '', 1, null, { toString: () => 'codex' }]) {
      expect(await run(appEvent, { profileId: ACCT, provider })).toEqual(INSIGHTS_REJECTED_INVALID)
      // Not read as a Claude Code run either, with a valid profile or with none.
      expect(await run(appEvent, { profileId: 'profile-abc', provider })).toEqual(INSIGHTS_REJECTED_INVALID)
      expect(await run(appEvent, { provider })).toEqual(INSIGHTS_REJECTED_INVALID)
    }
    expect(h.calls).toEqual([])
  })

  it('refused: a wrong id class on a Codex run (a profile, a malformed or another registry kind) [host]', async () => {
    for (const profileId of ['profile-abc', 'acct-xyz', `acct-${'A'.repeat(16)}`, `idn-${'a'.repeat(16)}`, undefined, 42, `acct-${'a'.repeat(200)}`]) {
      expect(await run(appEvent, { profileId, provider: 'codex' })).toEqual(INSIGHTS_REJECTED_INVALID)
    }
    expect(h.calls).toEqual([])
  })

  it('refused: a mismatched provider (a registry id on a Claude Code run) [host]', async () => {
    expect(await run(appEvent, { profileId: ACCT })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(await run(appEvent, { profileId: ACCT, provider: 'claude' })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(h.calls).toEqual([])
  })

  it('refused: a confirmation that is not exactly true, on a Claude Code run, and any key outside the shape [host]', async () => {
    expect(await run(appEvent, { profileId: ACCT, provider: 'codex', acknowledgeRealmOnly: 'yes' })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(await run(appEvent, { profileId: 'profile-abc', acknowledgeRealmOnly: true })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(await run(appEvent, { profileId: ACCT, provider: 'codex', home: 'C:/x' })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(await run(appEvent, 'profile-abc')).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(await run(appEvent, [ACCT])).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(h.calls).toEqual([])
  })

  it('refused for anything but the app window\'s own top frame [host]', async () => {
    expect(await run(otherEvent, { profileId: ACCT, provider: 'codex' })).toEqual(INSIGHTS_REJECTED_UNTRUSTED)
    expect(await run(subFrameEvent)).toEqual(INSIGHTS_REJECTED_UNTRUSTED)
    expect(h.calls).toEqual([])
  })
})

describe('insights:runAll', () => {
  it('takes profiles and Codex accounts; refuses anything else, and an untrusted sender [host]', async () => {
    expect(await runAll(appEvent)).toBe('run-all')
    expect(await runAll(appEvent, { profileIds: ['profile-a', ACCT] })).toBe('run-all')
    expect(h.calls).toEqual([['all', undefined], ['all', { profileIds: ['profile-a', ACCT] }]])
    expect(await runAll(appEvent, { profileIds: ['../x'] })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(await runAll(appEvent, { profileIds: 'profile-a' })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(await runAll(appEvent, { profileIds: Array.from({ length: 65 }, (_, i) => `profile-${i}`) })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(await runAll(appEvent, { profileIds: [], extra: 1 })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(await runAll(otherEvent)).toEqual(INSIGHTS_REJECTED_UNTRUSTED)
    expect(h.calls).toHaveLength(2)
  })

  it('refuses a list with holes in it (a sparse array), and anything list-like that is not a list [host]', async () => {
    const sparse: string[] = ['profile-a', ACCT]
    sparse.length = 4
    // eslint-disable-next-line no-sparse-arrays
    expect(await runAll(appEvent, { profileIds: ['profile-a', , ACCT] })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(await runAll(appEvent, { profileIds: sparse })).toEqual(INSIGHTS_REJECTED_INVALID)
    expect(checkInsightsRunAllRequest({ profileIds: { 0: 'profile-a', length: 1 } })).toBeNull()
    expect(h.calls).toEqual([])
  })
})

describe('insights:runAll from a sub-frame', () => {
  it('refused: the app window\'s own webContents, but not its top frame [host]', async () => {
    expect(await runAll(subFrameEvent)).toEqual(INSIGHTS_REJECTED_UNTRUSTED)
    expect(await runAll({ sender: webContents, senderFrame: null })).toEqual(INSIGHTS_REJECTED_UNTRUSTED)
    expect(await runAll(subFrameEvent, { profileIds: ['profile-a'] })).toEqual(INSIGHTS_REJECTED_UNTRUSTED)
    expect(h.calls).toEqual([])
  })
})

// A refused run is logged like a refused read: one line per refusal, which
// carries no part of the request. A run the app window asks for, or one refused
// for its content, writes no such line.
describe('a refused run or runAll is logged [host]', () => {
  it('one log line per refused run, without the request', async () => {
    for (const [ch, send] of [['run', run], ['runAll', runAll]] as const) {
      for (const event of [otherEvent, subFrameEvent]) {
        h.logs.length = 0
        expect(await send(event, ch === 'run' ? { profileId: 'profile-abc' } : { profileIds: ['profile-abc'] })).toEqual(INSIGHTS_REJECTED_UNTRUSTED)
        expect(h.logs.length, ch).toBe(1)
        expect(h.logs[0], ch).toMatch(new RegExp(`\\b${ch} refused: not the app window`))
        expect(h.logs[0], ch).not.toContain('profile-abc')
      }
    }
    expect(h.calls).toEqual([])
  })

  it('an answered run, or one refused for its content, writes no refusal line', async () => {
    await run(appEvent)
    await runAll(appEvent)
    await run(appEvent, { provider: 'gemini' })
    await runAll(appEvent, { profileIds: 'profile-a' })
    expect(h.logs.filter((l) => l.includes('not the app window'))).toEqual([])
  })
})

// The Insights reads answer only the app window's own top frame, as run and
// runAll do. A refused read answers the channel's empty value, so the
// renderer's types hold, and reads nothing.
describe('the Insights reads answer only the app window [host]', () => {
  /** One row per read: its arguments, its empty value, and the read it makes. */
  const READS: Record<string, { args: unknown[]; empty: unknown; reads: string }> = {
    'insights:getCatalogue': { args: [], empty: { runs: [] }, reads: 'getCatalogue' },
    'insights:getReport': { args: ['run-1'], empty: null, reads: 'getReport' },
    'insights:getKpis': { args: ['run-1'], empty: null, reads: 'getKpis' },
    'insights:getLatest': { args: [], empty: null, reads: 'getLatest' },
    'insights:isRunning': { args: [], empty: false, reads: 'isRunning' },
  }
  const RUNS = ['insights:run', 'insights:runAll']
  const FOREIGN = notAppMainFrameEvents(webContents)
  const read = (ch: string, event: unknown) => h.handlers.get(ch)!(event, ...READS[ch].args)

  it('every registered channel is a run or a read listed here (a new channel cannot go unchecked)', () => {
    expect([...h.handlers.keys()].sort()).toEqual([...RUNS, ...Object.keys(READS)].sort())
  })

  it('the app window top frame is answered with the read', async () => {
    for (const ch of Object.keys(READS)) {
      h.calls = []
      const res = await read(ch, appEvent)
      expect(res, ch).not.toEqual(READS[ch].empty)
      expect(h.calls.map(([k]) => k), ch).toEqual([READS[ch].reads])
    }
    expect(h.logs).toEqual([])
  })

  it('any other sender or frame is answered the empty value, and nothing is read', async () => {
    for (const ch of Object.keys(READS)) {
      for (const [shape, event] of FOREIGN) {
        expect(await read(ch, event), `${ch} from ${shape}`).toEqual(READS[ch].empty)
      }
    }
    expect(h.calls).toEqual([])
  })

  it('a destroyed window, or no window at all, is answered the empty value, and nothing is read', async () => {
    for (const ch of Object.keys(READS)) {
      destroyed = true
      expect(await read(ch, appEvent), `${ch} with the window destroyed`).toEqual(READS[ch].empty)
      destroyed = false
      current = null
      expect(await read(ch, appEvent), `${ch} while there is no window`).toEqual(READS[ch].empty)
      current = win
    }
    expect(h.calls).toEqual([])
  })

  it('a refused read writes one log line, which carries no part of the request', async () => {
    for (const ch of Object.keys(READS)) {
      h.logs.length = 0
      await read(ch, otherEvent)
      expect(h.logs.length, ch).toBe(1)
      expect(h.logs[0], ch).toMatch(/not the app window/)
      expect(h.logs[0], ch).not.toContain('run-1')
    }
  })
})

describe('the checks themselves', () => {
  it('never throw, and read nothing inherited [host]', () => {
    const polluted = Object.create({ provider: 'codex', profileId: ACCT })
    expect(checkInsightsRunRequest(polluted)).toBeNull()
    expect(checkInsightsRunRequest(new Proxy({}, { ownKeys: () => { throw new Error('x') } }))).toBeNull()
    expect(checkInsightsRunAllRequest(polluted)).toBeNull()
  })
})
