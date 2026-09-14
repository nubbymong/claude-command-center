// tests/unit/main/watchdog/watchdog-e2e-detection.test.ts
//
// Adversarial FINDING 7 (coverage gap): the session-watchdog suite mocks the
// detectors, so a detector bug (e.g. the blank-line un-mask, FINDING 2) passed a
// green suite. This drives the REAL patterns.ts detector through the REAL
// SessionWatchdog to the send() boundary — no mocked detectors — covering the
// blank-line tool-echo case end to end.
import { describe, it, expect } from 'vitest'
import { SessionWatchdog } from '../../../../src/main/watchdog/session-watchdog'
import type { WatchdogAdapter } from '../../../../src/main/watchdog/session-watchdog'

// A minimal terminal-chrome footer so the chrome-aware tail keeps the live region.
const CHROME = '╭──╮\n│ > │\n╰──╯'

function makeWd(initialTail: string) {
  let now = 0
  let tail = initialTail
  const sent: string[] = []
  const adapter: WatchdogAdapter = {
    getTail: () => tail,
    isSessionAlive: () => true,
    send: (t: string) => sent.push(t),
    now: () => now,
    log: () => {},
    onStateChange: () => {},
  }
  // Default config => overload enabled with the real DEFAULT_OVERLOAD.patterns.
  // rand fixed so the backoff is deterministic (jitter factor = 1).
  const wd = new SessionWatchdog('s1', adapter, undefined, () => 0.5)
  return {
    wd, sent,
    setTail: (t: string) => { tail = t },
    setNow: (n: number) => { now = n },
    state: () => wd.getState(),
  }
}

describe('watchdog E2E — real detector to send (fix #7)', () => {
  it('does NOT fire on quoted overload text after a blank line inside a tool block', () => {
    const pane = [
      '● Bash(cat ~/logs/x.log)',
      '  ⎿  matched:',
      '',
      '     API Error: 529 overloaded_error',
      CHROME,
    ].join('\n')
    const h = makeWd(pane)
    h.wd.feed()
    expect(h.state().status).toBe('monitoring') // masked -> no incident
    h.setNow(120_000)
    h.wd.tick()
    expect(h.sent).toHaveLength(0) // never retries into a tool-quoted error
  })

  it('fires on a real live overload banner and sends the retry after the backoff', () => {
    const pane = ['building the project…done', 'API Error: 529 overloaded_error', CHROME].join('\n')
    const h = makeWd(pane)
    h.wd.feed()
    expect(h.state().status).toBe('overload')
    const waitUntil = h.state().waitUntil as number
    expect(waitUntil).toBeGreaterThan(0)
    expect(h.sent).toHaveLength(0) // scheduled, not sent yet

    h.setNow(waitUntil + 1)
    h.wd.tick() // banner still live -> real send
    expect(h.sent).toHaveLength(1)
    expect(typeof h.sent[0]).toBe('string')
  })
})
