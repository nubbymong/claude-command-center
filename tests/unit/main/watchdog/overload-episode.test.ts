// P3.10 round 3 (F2): an overload episode lasts until the session has been
// quiet for two minutes after a retry. On a persistent outage each retry's own
// turn fails again within seconds; the machine used to take the retry's
// working frames (Claude Code) or the retry's new turn (Codex) as recovery and
// open a fresh episode for the next error, so every retry was attempt 1, the
// backoff never grew and the cap never tripped (VM: 8 retries in 5 min, each
// attempt 1). The shared state machine, the real detectors of both CLIs, a
// simulated clock; the screen is fed and the timer ticked every 5 s, and each
// turn works for 7 s before it ends (in an error while the API is down).
import { describe, it, expect } from 'vitest'
import { SessionWatchdog } from '../../../../src/main/watchdog/session-watchdog'
import type { WatchdogAdapter, WatchdogPublicState } from '../../../../src/main/watchdog/session-watchdog'
import { CODEX_DETECTORS, CLAUDE_DETECTORS } from '../../../../src/main/watchdog/detectors'
import type { WatchdogDetectors } from '../../../../src/main/watchdog/detectors'
import type { ScreenLine } from '../../../../src/shared/codex-screen'

const ch = (c: number): string => String.fromCharCode(c)
const DOT = ch(0xb7)

interface Cli {
  name: string
  detectors: WatchdogDetectors
  user: (text: string) => string[]
  error: string[]
  working: string[]
  internalRetry: string[]
  answer: (i: number) => string[]
  render: (rows: string[]) => { text: string; lines: ScreenLine[] }
}

// Codex as the VM draws it: an error is its own cell with a black square, the
// composer a prompt-glyph row with the footer under it (placeholder dim).
const P = ch(0x203a)
const CODEX: Cli = {
  name: 'Codex',
  detectors: CODEX_DETECTORS,
  user: (text) => ['', `${P} ${text}`],
  error: ['', `${ch(0x25a0)} We're currently experiencing high demand, which may cause temporary errors.`],
  working: ['', `${ch(0x2022)} Working (1s ${DOT} esc to interrupt)`],
  internalRetry: ['', `${ch(0x2022)} Reconnecting... 2/5 (4s ${DOT} esc to interrupt)`],
  answer: (i) => ['', `${ch(0x2022)} Done, step ${i}.`],
  render: (body) => {
    const rows = ['', ...body.slice(-11), '', `${P} Ask Codex to do anything`, '', `  gpt-6-astra low ${DOT} C:/Users/alex/projects/demo`]
    const idx = rows.length - 3
    return { text: rows.join('\n'), lines: rows.map((t, i) => ({ text: t, typed: i === idx ? t.slice(0, 1) : t })) }
  },
}

// Claude Code: the error line under the turn, the input box between two rules.
const RULE = ch(0x2500).repeat(41)
const CLAUDE: Cli = {
  name: 'Claude Code',
  detectors: CLAUDE_DETECTORS,
  user: (text) => [`> ${text}`],
  error: [`  ${ch(0x23bf)}  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`],
  working: [`${ch(0x273b)} Cogitating${ch(0x2026)} (esc to interrupt)`],
  internalRetry: [`${ch(0x273b)} Cogitating${ch(0x2026)} (esc to interrupt ${DOT} Retrying in 5s ${DOT} attempt 3/10)`],
  // A real answer: long enough to move the old error out of the live tail.
  answer: (i) => [`${ch(0x25cf)} Done, step ${i}.`, ...Array.from({ length: 13 }, (_, k) => `  line ${k} of the answer`)],
  render: (body) => ({
    text: [...body.slice(-30), RULE, `${ch(0x276f)} `, RULE, `  ${ch(0x23f5)}${ch(0x23f5)} accept edits on (shift+tab to cycle) ${DOT} ? for shortcuts`].join('\n'),
    lines: null as unknown as ScreenLine[],
  }),
}

interface Run {
  /** Seconds from the start at which each retry was typed. */
  sends: number[]
  gaveUp: boolean
  states: Array<WatchdogPublicState & { at: number }>
}

/** `down(s)`: the API fails a turn ending at s seconds. `prompts`: seconds at
 *  which the user sends a message of their own. `retrying`: the CLI shows its
 *  own retry instead of working. `turnSeconds`: how long a turn works (7). */
function simulate(cli: Cli, o: { seconds: number; down: (s: number) => boolean; prompts?: number[]; retrying?: boolean; turnSeconds?: number }): Run {
  const t0 = Date.UTC(2026, 8, 30, 3, 0, 0)
  const clock = { now: t0 }
  const sec = (): number => (clock.now - t0) / 1000
  const rows: string[] = []
  let workingUntil = 0
  let answers = 0
  const sends: number[] = []
  const states: Run['states'] = []
  const startTurn = (text: string): void => { rows.push(...cli.user(text)); workingUntil = clock.now + (o.turnSeconds ?? 7) * 1000 }
  const endTurn = (): void => { workingUntil = 0; rows.push(...(o.down(sec()) ? cli.error : cli.answer(answers++))) }
  const screen = (): { text: string; lines: ScreenLine[] } =>
    cli.render(workingUntil ? [...rows, ...(o.retrying ? cli.internalRetry : cli.working)] : rows)
  const adapter: WatchdogAdapter = {
    getTail: () => screen().text,
    getScreen: () => screen().lines,
    isSessionAlive: () => true,
    send: (t) => { sends.push(sec()); startTurn(t.trim()) },
    now: () => clock.now,
    log: () => {},
    onStateChange: (s) => { states.push({ ...s, at: sec() }) },
    detectors: cli.detectors,
  }
  const wd = new SessionWatchdog('s', adapter, { overload: { enabled: true, retryMessage: 'continue' } } as never, () => 0.5)
  const prompts = [...(o.prompts ?? [])]
  startTurn('task')
  wd.feed()
  let gaveUp = false
  while (sec() < o.seconds) {
    clock.now += 5000
    if (workingUntil && clock.now >= workingUntil) endTurn()
    if (!workingUntil && prompts.length && sec() >= prompts[0]) { prompts.shift(); startTurn('next step') }
    wd.feed()
    wd.tick()
    if (wd.getState().gaveUp) gaveUp = true
  }
  return { sends, gaveUp, states }
}

/** The wait each overload opening scheduled, in seconds, with when it opened. */
function openings(r: Run): Array<{ at: number; wait: number; again: boolean }> {
  return r.states
    .filter((s) => s.status === 'overload' && /^overload detected/.test(s.lastAction ?? '') && s.waitUntil !== null)
    .map((s) => ({ at: s.at, wait: Math.round(((s.waitUntil as number) - (Date.UTC(2026, 8, 30, 3, 0, 0) + s.at * 1000)) / 1000), again: /again/.test(s.lastAction ?? '') }))
}

for (const cli of [CODEX, CLAUDE]) {
  describe(`${cli.name}: an overload episode lasts until the session is quiet (P3.10 round 3, F2)`, () => {
    it('a persistent outage backs off (30, 60, 120, 240, then 300 s) and gives up at the cap', () => {
      const r = simulate(cli, { seconds: 4 * 3600, down: () => true })
      const gaps = r.sends.slice(1).map((t, i) => t - r.sends[i])
      // Each gap is the backoff step plus the retry turn's own 7 s or so.
      expect(gaps.slice(0, 4).map((g) => Math.round(g / 10) * 10)).toEqual([70, 130, 250, 310])
      expect(Math.min(...gaps.slice(3))).toBeGreaterThanOrEqual(300)
      expect(r.gaveUp).toBe(true)
      // The default cap is 120 min of waiting, counting only the waits the
      // episode waited (30 + 60 + 120 + 240 + 300 s each after): 26 retries
      // reach it, then none.
      expect(r.sends.length).toBe(26)
      expect(r.sends.at(-1)).toBeLessThan(2.5 * 3600)
      expect(Math.max(...r.states.map((s) => s.overloadAttempts))).toBe(r.sends.length)
    })

    it('the CLI\'s own retries in between are not quiet: a retry turn retrying for 3 min before its error still continues the episode', () => {
      const r = simulate(cli, { seconds: 1800, down: () => true, retrying: true, turnSeconds: 180 })
      expect(r.sends.length).toBeGreaterThanOrEqual(3)
      expect(Math.max(...r.states.map((s) => s.overloadAttempts))).toBe(r.sends.length)
      expect(openings(r).slice(1).every((x) => x.again)).toBe(true)
    })

    it('a real success, then a new error long after it, starts a fresh episode', () => {
      // Down for the first turn only; up again for the retry. Down again for a
      // turn the user starts 30 min later, and for its first retry.
      const down = (s: number): boolean => s < 30 || (s > 1800 && s < 1900)
      const r = simulate(cli, { seconds: 3600, down, prompts: [1800] })
      const o = openings(r)
      expect(o.map((x) => [x.wait, x.again])).toEqual([[30, false], [30, false], [60, true]])
      expect(o[1].at).toBeGreaterThan(1800)
      expect(r.sends.length).toBe(3)
      expect(r.gaveUp).toBe(false)
    })

    it('a new error within two minutes of quiet continues the episode; after two minutes it does not', () => {
      // The retry succeeds (the turn ends at about 50 s); the user's own
      // message 60 s later fails: the same episode, attempt 2's backoff.
      const soon = simulate(cli, { seconds: 600, down: (s) => s < 30 || (s > 100 && s < 130), prompts: [110] })
      expect(openings(soon).map((x) => [x.wait, x.again])).toEqual([[30, false], [60, true]])
      // The same, with the user's message 3 min after: a fresh episode.
      const late = simulate(cli, { seconds: 600, down: (s) => s < 30 || (s > 230 && s < 260), prompts: [240] })
      expect(openings(late).map((x) => [x.wait, x.again])).toEqual([[30, false], [30, false]])
    })
  })
}

/** Step by step, for orders the 5 s simulation does not make: the screen is
 *  set, then read (feed) or the timer ticked, only when the case says so. */
function manual(cli: Cli, rand: () => number = () => 0.5) {
  const clock = { now: Date.UTC(2026, 8, 30, 3, 0, 0) }
  let body: string[] = []
  const states: WatchdogPublicState[] = []
  const logs: string[] = []
  const adapter: WatchdogAdapter = {
    getTail: () => cli.render(body).text,
    getScreen: () => cli.render(body).lines,
    isSessionAlive: () => true,
    send: (t) => { body = [...body, ...cli.user(t.trim()), ...cli.working] },
    now: () => clock.now,
    log: (_level, m) => { logs.push(m) },
    onStateChange: (s) => { states.push({ ...s }) },
    detectors: cli.detectors,
  }
  const wd = new SessionWatchdog('s', adapter, { overload: { enabled: true, retryMessage: 'continue' } } as never, rand)
  return {
    wd, clock, states, logs,
    set: (b: string[]) => { body = b },
    /** The screen without the working row the last send added. */
    settled: () => body.filter((l) => l === '' || !cli.working.includes(l)),
    /** The wait the last state scheduled, in seconds. */
    wait: () => Math.round(((states.at(-1)?.waitUntil ?? clock.now) - clock.now) / 1000),
  }
}

for (const cli of [CODEX, CLAUDE]) {
  describe(`${cli.name}: the overload episode, step by step (P3.10 round 4)`, () => {
    it('P4: the recovering frame is the last output for hours: the next error starts a fresh episode', () => {
      const m = manual(cli)
      m.set([...cli.user('task'), ...cli.error])
      m.wd.feed()
      expect(m.wait()).toBe(30)
      m.clock.now += 31_000
      m.wd.tick()
      expect(m.wd.getState().overloadAttempts).toBe(1)
      // The retry works, and that frame is the last output.
      m.wd.feed()
      expect(m.wd.getState().status).toBe('monitoring')
      m.clock.now += 3 * 3600_000
      m.set([...m.settled(), ...cli.answer(1), ...cli.user('next step'), ...cli.error])
      m.wd.feed()
      const s = m.states.at(-1)!
      expect(s.status).toBe('overload')
      expect(s.lastAction).toBe('overload detected; backing off')
      expect(m.wait()).toBe(30)
    })

    it('P7: the backoff logged with a retry is the wait used when its error comes back', () => {
      // Jitter draws that differ each time: 0.85x, 1.15x, 0.85x ...
      let n = 0
      const m = manual(cli, () => (n++ % 2 === 0 ? 0 : 1))
      m.set([...cli.user('task'), ...cli.error])
      m.wd.feed()
      m.clock.now = m.states.at(-1)!.waitUntil! + 1000
      m.wd.tick()
      const sent = m.logs.find((l) => /^Sending overload retry/.test(l))!
      const logged = Number(/Next backoff (\d+)s/.exec(sent)![1])
      // The retry's turn works a few seconds, then fails again.
      m.wd.feed()
      m.clock.now += 8000
      m.set([...m.settled(), ...cli.error])
      m.wd.feed()
      expect(m.states.at(-1)!.lastAction).toBe('overload detected again; backing off')
      expect(m.wait()).toBe(logged)
      const again = m.logs.find((l) => /again before the last one settled/.test(l))!
      expect(Number(/Backing off (\d+)s/.exec(again)![1])).toBe(logged)
    })
  })
}
