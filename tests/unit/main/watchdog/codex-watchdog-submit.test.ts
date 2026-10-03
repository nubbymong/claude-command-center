// P3.10 (row 43): the manager types a Codex session's retry the way the app's
// own Codex commands are typed (P3.8): the text first, its Enter only after the
// burst window (Codex's composer takes a faster burst ending in Enter as a
// paste), and only when the rendered pane then shows exactly the retry typed at
// the composer with nothing in the way; otherwise nothing is submitted (the
// app's own characters are erased only while the composer holds exactly them
// and no prompt is up). The real SessionWatchdog and the headless pane; the
// settings say the feature is on (it is off by default).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => ({ watchdog: { enabled: true, retryMessage: 'continue', marginSeconds: 1 } })),
}))
vi.mock('../../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../../src/main/hooks/index', () => ({ getGateway: () => null }))

const { WatchdogManager, CODEX_SUBMIT_DELAY_MS } = await import('../../../../src/main/watchdog/watchdog-manager')

const SQ = '\u25a0'
const P = '\u203a'
const DOT = '\u00b7'
const CLEAR = '\x1b[2J\x1b[H'
const ENTER = '\r'
const FOOTER = `  gpt-6-astra low ${DOT} C:\\Users\\alex\\projects\\demo`
const render = (rows: string[]): string => CLEAR + rows.join('\r\n')
const DIM = (s: string) => `\x1b[2m${s}\x1b[22m`
/** A limit cell whose reset has passed (a later day's format, in the past). */
const LIMIT = [`${SQ} You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try`, '  again at Jan 1st, 2026 3:05 PM.']
const limitScreen = (composer: string) => render(['', ...LIMIT, '', composer, '', FOOTER])
const EMPTY_COMPOSER = `${P} ${DIM('Ask Codex to do anything')}`

describe('WatchdogManager: a Codex session\'s retry', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(Date.parse('2026-09-29T12:00:00Z')) })
  afterEach(() => { vi.useRealTimers() })

  function setup(onWrite: (mgr: InstanceType<typeof WatchdogManager>, data: string) => void) {
    const writes: string[] = []
    const send = vi.fn()
    const holder: { mgr?: InstanceType<typeof WatchdogManager> } = {}
    const mgr = new WatchdogManager({
      getWindow: () => null,
      isSessionAlive: () => true,
      send,
      write: (_sid, data) => { writes.push(data); onWrite(holder.mgr!, data) },
      now: () => Date.now(),
      getStalls: () => 0,
    })
    holder.mgr = mgr
    mgr.startWatchdog('cx', { provider: 'codex', ssh: false, shellOnly: false, cols: 140, rows: 20 })
    return { mgr, writes, send }
  }
  const run = (ms: number) => vi.advanceTimersByTimeAsync(ms)
  /** Until the shared tick (every 5 s) has typed the retry, and not its Enter. */
  const untilTyped = async () => { await run(300); await run(4_800) }

  it('types the retry, then presses Enter once the pane shows it typed at the composer', async () => {
    const { mgr, writes, send } = setup((m, data) => { if (data === 'continue') m.feedData('cx', limitScreen(`${P} continue`)) })
    mgr.feedData('cx', limitScreen(EMPTY_COMPOSER))
    await run(300)
    expect(mgr.getStates()[0].status).toBe('waiting')
    await run(4_800)
    expect(writes).toEqual(['continue'])
    expect(send).not.toHaveBeenCalled()
    await run(CODEX_SUBMIT_DELAY_MS + 10)
    expect(writes).toEqual(['continue', ENTER])
  })

  it('no Enter when the screen changed before it (a prompt came up): nothing erased under a prompt', async () => {
    const { mgr, writes } = setup((m, data) => { if (data === 'continue') m.feedData('cx', render(['', '  Would you like to run the following command?', `${P} 1. Yes, proceed`, '  2. No', '  Press enter to confirm or esc to go back'])) })
    mgr.feedData('cx', limitScreen(EMPTY_COMPOSER))
    await untilTyped()
    await run(CODEX_SUBMIT_DELAY_MS + 10)
    expect(writes).toEqual(['continue'])
  })

  it('a prompt up above a composer that still holds the retry: neither Enter nor erase (keys into a prompt could choose in it)', async () => {
    const { mgr, writes } = setup((m, data) => { if (data === 'continue') m.feedData('cx', render(['', '  Would you like to run the following command?', '  $ npm test', '', `${P} continue`, '', FOOTER])) })
    mgr.feedData('cx', limitScreen(EMPTY_COMPOSER))
    await untilTyped()
    await run(CODEX_SUBMIT_DELAY_MS + 10)
    expect(writes).toEqual(['continue'])
  })

  it('when the composer holds exactly the retry but a turn started meanwhile, only the retry\'s own characters are erased', async () => {
    const { mgr, writes } = setup((m, data) => { if (data === 'continue') m.feedData('cx', render(['', ...LIMIT, '', `\u2022 Working (1s ${DOT} esc to interrupt)`, `${P} continue`, '', FOOTER])) })
    mgr.feedData('cx', limitScreen(EMPTY_COMPOSER))
    await untilTyped()
    await run(CODEX_SUBMIT_DELAY_MS + 10)
    expect(writes).toEqual(['continue', '\x7f'.repeat('continue'.length)])
  })

  it('the user\'s own typing beside it: neither Enter nor erase', async () => {
    const { mgr, writes } = setup((m, data) => { if (data === 'continue') m.feedData('cx', limitScreen(`${P} my words continue`)) })
    mgr.feedData('cx', limitScreen(EMPTY_COMPOSER))
    await untilTyped()
    await run(CODEX_SUBMIT_DELAY_MS + 10)
    expect(writes).toEqual(['continue'])
  })

  it('a teardown between the typing and its Enter types nothing more', async () => {
    const { mgr, writes } = setup((m, data) => { if (data === 'continue') { m.feedData('cx', limitScreen(`${P} continue`)); m.stopWatchdog('cx') } })
    mgr.feedData('cx', limitScreen(EMPTY_COMPOSER))
    await untilTyped()
    await run(CODEX_SUBMIT_DELAY_MS + 10)
    expect(writes).toEqual(['continue'])
  })

  it('a respawn between the typing and its Enter (the same session id, alive) presses nothing into the new process', async () => {
    const { mgr, writes } = setup((m, data) => {
      if (data !== 'continue') return
      m.feedData('cx', limitScreen(`${P} continue`))
      setTimeout(() => m.startWatchdog('cx', { provider: 'codex', ssh: false, shellOnly: false, cols: 140, rows: 20 }), CODEX_SUBMIT_DELAY_MS / 2)
    })
    mgr.feedData('cx', limitScreen(EMPTY_COMPOSER))
    await untilTyped()
    await run(CODEX_SUBMIT_DELAY_MS + 10)
    expect(writes).toEqual(['continue'])
  })

  it('without a raw writer, a Codex session\'s retry is never typed (never the Claude submit path)', async () => {
    const send = vi.fn()
    const mgr = new WatchdogManager({ getWindow: () => null, isSessionAlive: () => true, send, now: () => Date.now(), getStalls: () => 0 })
    mgr.startWatchdog('cx', { provider: 'codex', ssh: false, shellOnly: false, cols: 140, rows: 20 })
    mgr.feedData('cx', limitScreen(EMPTY_COMPOSER))
    await untilTyped()
    await run(CODEX_SUBMIT_DELAY_MS + 10)
    expect(send).not.toHaveBeenCalled()
  })
})
