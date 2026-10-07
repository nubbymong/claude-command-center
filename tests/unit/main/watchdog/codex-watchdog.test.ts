// P3.10 (row 43): the Session Watchdog for a local Codex session, with Codex's
// own patterns (aicc_planning#72: never Claude Code's; a check Codex has no
// patterns for, the safeguard, is unavailable). Still opt-in and off by
// default (the settings gate is the manager's, unchanged). The screens are
// shaped as the real TUIs draw them (the P3.8 and P3.10 VM probes of 0.153.4
// and 0.155.1): an error is its own cell from column 0 with a black square;
// Codex's own retry reads "Reconnecting... 2/5 (4s . esc to interrupt)"; the
// composer is a prompt-glyph row with the footer under it. A retry is typed
// only into Codex's ready, empty composer, and its Enter pressed only once the
// screen shows exactly it typed (Codex takes a burst ending in Enter as a paste).
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  codexIsRateLimited,
  codexFindRateLimitMessage,
  codexResumedAfterLimit,
  codexDetectOverload,
  codexDetectSafeguard,
  codexIsWorking,
  codexIsInternalRetry,
  parseCodexResetTime,
  codexCanSendNow,
} from '../../../../src/main/watchdog/codex-patterns'
import { isRateLimited, detectOverload } from '../../../../src/main/watchdog/patterns'
import { SessionWatchdog } from '../../../../src/main/watchdog/session-watchdog'
import type { WatchdogAdapter, WatchdogPublicState } from '../../../../src/main/watchdog/session-watchdog'
import { CODEX_DETECTORS, CLAUDE_DETECTORS } from '../../../../src/main/watchdog/detectors'
import type { ScreenLine } from '../../../../src/shared/codex-screen'

const SQ = '\u25a0'
const P = '\u203a'
const DOT = '\u00b7'
const BOX = '\u2502'
const FOOTER = `  gpt-6-astra low ${DOT} C:\\Users\\alex\\projects\\demo`
const BANNER = [`\u256d${'\u2500'.repeat(40)}\u256e`, `${BOX} >_ OpenAI Codex (v0.155.1)             ${BOX}`, `\u2570${'\u2500'.repeat(40)}\u256f`, '', '  Tip: New Build faster with Codex.', '']
const LIMIT = [
  `${SQ} You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to`,
  '  purchase more credits or try again at 3:05 PM.',
]
/** Rows to ScreenLine; `placeholderAt` rows have their text after the glyph dim. */
function screen(rows: string[], placeholderAt: number[] = []): ScreenLine[] {
  return rows.map((text, i) => ({ text, typed: placeholderAt.includes(i) ? text.slice(0, 1) : text }))
}
function pane(body: string[], composer = `${P} Ask Codex to do anything`, placeholder = true): { text: string; lines: ScreenLine[] } {
  const rows = [...BANNER, ...body, '', composer, '', FOOTER]
  const idx = rows.length - 3
  return { text: rows.join('\n'), lines: screen(rows, placeholder ? [idx] : []) }
}

describe('Codex\'s own patterns', () => {
  it('a usage-limit error cell in the live region is a rate limit; its reset time is read', () => {
    const { text } = pane([`${P} hello`, '', ...LIMIT])
    expect(codexIsRateLimited(text)).toBe(true)
    expect(codexFindRateLimitMessage(text)).toContain('try again at 3:05 PM')
    expect(codexResumedAfterLimit(text)).toBe(false)
  })

  it('never Claude Code\'s: Claude\'s limit banner on a Codex pane is nothing, and a Codex limit is not Claude\'s', () => {
    const claudeBanner = pane(["  \u26a0 You've hit your limit", '  \u00b7 resets 3pm (UTC)']).text
    expect(codexIsRateLimited(claudeBanner)).toBe(false)
    const codexLimit = pane([...LIMIT]).text
    expect(CLAUDE_DETECTORS.isRateLimited(codexLimit, 12)).toBe(isRateLimited(codexLimit, [], 12))
  })

  it('the same words in a message (no error square), or a limit cell far above the live region, are not a limit', () => {
    expect(codexIsRateLimited(pane([`${P} why did I get "You've hit your usage limit" yesterday?`]).text)).toBe(false)
    const old = pane([...LIMIT, ...Array.from({ length: 20 }, (_, i) => `  line ${i} of an answer`)]).text
    expect(codexIsRateLimited(old)).toBe(false)
  })

  it('a message sent after the limit (below it), or a turn running, is the session moving on', () => {
    expect(codexResumedAfterLimit(pane([...LIMIT, '', `${P} continue`]).text)).toBe(true)
    expect(codexResumedAfterLimit(pane([...LIMIT, '', `\u2022 Working (2s ${DOT} esc to interrupt)`]).text)).toBe(true)
  })

  it('a sustained server error cell is an overload; Codex\'s own retry is not recovery; no safeguard', () => {
    const over = pane([`${SQ} We're currently experiencing high demand, which may cause temporary errors.`]).text
    expect(codexDetectOverload(over)).toBe(true)
    expect(CODEX_DETECTORS.detectOverload(over, ['anything'])).toBe(true)
    expect(detectOverload(over, [/overloaded/i])).toBe(false)
    const retrying = pane([`\u2022 Reconnecting... 2/5 (4s ${DOT} esc to interrupt)`, '  \u2514 Stream disconnected before completion: No connection could be made (os error 10061)']).text
    expect(codexDetectOverload(retrying)).toBe(false)
    expect(codexIsInternalRetry(retrying)).toBe(true)
    expect(codexIsWorking(retrying)).toBe(true)
    for (const msg of ['Selected model is at capacity. Please try a different model.', 'exceeded retry limit, last status: 503 Service Unavailable', 'stream disconnected before completion: error sending request']) {
      expect(codexDetectOverload(pane([`${SQ} ${msg}`]).text), msg).toBe(true)
    }
    expect(codexDetectOverload(pane([`${SQ} Conversation interrupted - tell the model what to do differently.`]).text)).toBe(false)
    expect(codexDetectSafeguard()).toBe(false)
    expect(CODEX_DETECTORS.available).toEqual({ rateLimit: true, overload: true, safeguard: false })
  })

  it('reads a reset time today, a reset on another day, and none', () => {
    const now = new Date(2026, 8, 29, 14, 0, 0)
    expect(parseCodexResetTime('or try again at 3:05 PM.', now)).toEqual({ hour: 15, minute: 5, timezone: null, ambiguous: false })
    expect(parseCodexResetTime('or try again at 12:10 AM.', now)).toEqual({ hour: 0, minute: 10, timezone: null, ambiguous: false })
    const later = parseCodexResetTime('or try again at Oct 1st, 2026 3:05 PM.', now) as { relative: true; waitMs: number }
    expect(later.relative).toBe(true)
    expect(later.waitMs).toBe(new Date(2026, 9, 1, 15, 5).getTime() - now.getTime())
    expect(parseCodexResetTime('or try again later.', now)).toBeNull()
    expect(parseCodexResetTime('try again at 13:05 PM', now)).toBeNull()
  })

  it('send gate: only Codex\'s ready, EMPTY composer; a draft, a prompt, a turn, or no screen defers', () => {
    expect(codexCanSendNow('', undefined, pane([...LIMIT]).lines)).toEqual({ ok: true })
    expect(codexCanSendNow('', undefined, pane([...LIMIT], `${P} my half-typed draft`, false).lines)).toEqual({ ok: false, reason: 'draft' })
    const approval = screen([...BANNER, '  Would you like to run the following command?', `${P} 1. Yes, proceed`, '  2. No', '  Press enter to confirm or esc to go back'])
    expect(codexCanSendNow('', undefined, approval).ok).toBe(false)
    const review = screen([...BANNER, '  Hooks need review', '  6 hooks are new or changed.', `${P} 1. Review hooks`, '  2. Trust all and continue'])
    expect(codexCanSendNow('', undefined, review)).toEqual({ ok: false, reason: 'menu' })
    expect(codexCanSendNow('', undefined, pane([`\u2022 Working (2s ${DOT} esc to interrupt)`]).lines).ok).toBe(false)
    expect(codexCanSendNow('', undefined, null)).toEqual({ ok: false, reason: 'menu' })
    expect(codexCanSendNow('', undefined, [])).toEqual({ ok: false, reason: 'menu' })
  })
})

describe('SessionWatchdog with Codex\'s detectors', () => {
  function adapterFor(p: { text: string; lines: ScreenLine[] }, clock: { now: number }) {
    const sent: string[] = []
    const states: WatchdogPublicState[] = []
    let current = p
    const adapter: WatchdogAdapter = {
      getTail: () => current.text,
      getScreen: () => current.lines,
      isSessionAlive: () => true,
      send: (t) => { sent.push(t) },
      now: () => clock.now,
      log: () => {},
      onStateChange: (s) => { states.push(s) },
      detectors: CODEX_DETECTORS,
    }
    return { adapter, sent, states, set: (next: { text: string; lines: ScreenLine[] }) => { current = next } }
  }
  afterEach(() => { vi.useRealTimers() })

  it('waits out a Codex usage limit to its reset, then types the retry into the ready, empty composer', () => {
    const clock = { now: new Date(2026, 8, 29, 14, 0, 0).getTime() }
    const a = adapterFor(pane([...LIMIT]), clock)
    const wd = new SessionWatchdog('cx', a.adapter, { rateLimitEnabled: true, retryMessage: 'continue', marginSeconds: 60 })
    wd.feed()
    const st = wd.getState()
    expect(st.status).toBe('waiting')
    expect(st.waitUntil).toBe(new Date(2026, 8, 29, 15, 6, 0).getTime())
    clock.now = st.waitUntil! - 1
    wd.tick()
    expect(a.sent).toEqual([])
    clock.now = st.waitUntil! + 1
    wd.tick()
    expect(a.sent).toEqual(['continue'])
  })

  it('a draft in the composer defers the retry without spending an attempt', () => {
    const clock = { now: new Date(2026, 8, 29, 14, 0, 0).getTime() }
    const a = adapterFor(pane([...LIMIT], `${P} my draft`, false), clock)
    const wd = new SessionWatchdog('cx', a.adapter, { rateLimitEnabled: true, retryMessage: 'continue' })
    wd.feed()
    clock.now = wd.getState().waitUntil! + 1
    wd.tick()
    expect(a.sent).toEqual([])
    expect(wd.getState().attempts).toBe(0)
  })

  it('the safeguard check is unavailable for Codex: off whatever the settings, never switched on, and said so', () => {
    const clock = { now: Date.now() }
    const a = adapterFor(pane([]), clock)
    const wd = new SessionWatchdog('cx', a.adapter, { safeguard: { enabled: true } } as never)
    expect(wd.getState().checks.safeguard).toBe(false)
    expect(wd.getState().unavailable).toEqual(['safeguard'])
    wd.setChecks({ safeguard: true })
    expect(wd.getState().checks.safeguard).toBe(false)
    // Claude's session keeps all three, and says nothing of availability.
    const c = new SessionWatchdog('cl', { ...a.adapter, detectors: undefined }, { safeguard: { enabled: true } } as never)
    expect(c.getState().checks.safeguard).toBe(true)
    expect(c.getState().unavailable).toBeUndefined()
  })
})

// P3.10 round 2 (R2): Codex leaves an error cell on screen after the turn that
// follows it succeeds. An error cell above a newer user message (the retry the
// Watchdog typed, or the user's own) is an earlier turn's, not the current
// state: one overload is retried once (the VM run saw a second retry a minute
// after the first had succeeded), and a new error after that is a new incident.
describe('a stale error cell above a newer turn (round 2, R2)', () => {
  const ERR = `${SQ} We're currently experiencing high demand, which may cause temporary errors.`
  it('the patterns: an overload or a limit cell above a newer user message is not live; the limit one still reads as moved on', () => {
    expect(codexDetectOverload(pane([`${P} P310-ERR-32`, '', ERR]).text)).toBe(true)
    expect(codexDetectOverload(pane([`${P} P310-ERR-32`, '', ERR, '', `${P} continue`, '', '\u2022 ok']).text)).toBe(false)
    const staleLimit = pane([...LIMIT, '', `${P} continue`, '', '\u2022 ok']).text
    expect(codexIsRateLimited(staleLimit)).toBe(false)
    expect(codexResumedAfterLimit(staleLimit)).toBe(true)
    // A new error below the newer message is live again.
    expect(codexDetectOverload(pane([ERR, '', `${P} continue`, '', '\u2022 ok', '', `${P} next`, '', ERR]).text)).toBe(true)
  })

  function run() {
    const clock = { now: new Date(2026, 8, 30, 2, 23, 0).getTime() }
    const holder: { set?: (p: { text: string; lines: ScreenLine[] }) => void } = {}
    const sent: string[] = []
    let current = pane([`${P} P310-ERR-32`, '', ERR])
    const adapter: WatchdogAdapter = {
      getTail: () => current.text,
      getScreen: () => current.lines,
      isSessionAlive: () => true,
      send: (t) => { sent.push(t) },
      now: () => clock.now,
      log: () => {},
      onStateChange: () => {},
      detectors: CODEX_DETECTORS,
    }
    holder.set = (p) => { current = p }
    const wd = new SessionWatchdog('cx', adapter, { overload: { enabled: true, retryMessage: 'continue' } } as never, () => 0.5)
    return { wd, sent, clock, set: holder.set }
  }

  it('one overload, a retry that succeeds, the old cell still on screen: one retry only', () => {
    const r = run()
    r.wd.feed()
    expect(r.wd.getState().status).toBe('overload')
    r.clock.now = r.wd.getState().waitUntil! + 1
    r.wd.tick()
    expect(r.sent).toEqual(['continue'])
    // Codex answered the retry; the old error cell is still above it.
    r.set(pane([`${P} P310-ERR-32`, '', ERR, '', `${P} continue`, '', '\u2022 ok (p310 fake model)']))
    r.wd.feed()
    expect(r.wd.getState().status).toBe('monitoring')
    for (let i = 0; i < 10; i++) {
      r.clock.now += 60_000
      r.wd.feed()
      r.wd.tick()
    }
    expect(r.sent).toEqual(['continue'])
  })

  it('a new error after that success is a new incident: retried again', () => {
    const r = run()
    r.wd.feed()
    r.clock.now = r.wd.getState().waitUntil! + 1
    r.wd.tick()
    r.set(pane([`${P} P310-ERR-32`, '', ERR, '', `${P} continue`, '', '\u2022 ok (p310 fake model)']))
    r.wd.feed()
    r.set(pane([ERR, '', `${P} continue`, '', '\u2022 ok (p310 fake model)', '', `${P} next`, '', ERR]))
    r.wd.feed()
    expect(r.wd.getState().status).toBe('overload')
    r.clock.now = r.wd.getState().waitUntil! + 1
    r.wd.tick()
    expect(r.sent).toEqual(['continue', 'continue'])
  })
})
