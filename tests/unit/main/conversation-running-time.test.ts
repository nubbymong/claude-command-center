// P3.7 (row 36): how long each provider conversation the app has run has
// been running, kept by main across launches and relaunches, so a Codex
// session's Duration is the conversation's running time, as Claude Code's is
// (its CLI restores it from the transcript when it resumes). Main writes it
// into the saved session state and reads it back at load, schema-checked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  conversationRunningTime,
  noteConversationRunningTime,
  conversationRunningTimesForSave,
  rememberConversationRunningTimesFrom,
  CONVERSATION_RUNNING_TIMES_KEPT,
  CONVERSATION_GAPS_KEPT,
  __resetConversationRunningTimesForTests,
} from '../../../src/main/conversation-running-time'

const A = '019dd000-0001-7000-8000-0000000000a1'
const B = '019dd000-0001-7000-8000-0000000000b2'
const NOW = Date.parse('2026-09-29T12:00:00.000Z')
const idOf = (n: number) => `019dd000-0001-7000-8000-${String(n).padStart(12, '0')}`

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  __resetConversationRunningTimesForTests()
})
afterEach(() => { vi.useRealTimers() })

describe('a conversation\'s running time, as main keeps it', () => {
  it('is kept by conversation id, whatever its case, and read back as a copy', () => {
    expect(conversationRunningTime(A)).toBeNull()
    noteConversationRunningTime(A.toUpperCase(), 90_000, NOW - 1_000)
    expect(conversationRunningTime(A)).toEqual({ ms: 90_000, until: NOW - 1_000, gaps: [] })
    const got = conversationRunningTime(A)!
    got.ms = 1
    expect(conversationRunningTime(A)).toEqual({ ms: 90_000, until: NOW - 1_000, gaps: [] })
    noteConversationRunningTime(A, 120_000, NOW)
    expect(conversationRunningTime(A)).toEqual({ ms: 120_000, until: NOW, gaps: [] })
  })

  it('refuses what is not a conversation id or not a time', () => {
    for (const [id, ms, until] of [
      ['not-an-id', 1, NOW], ['', 1, NOW], [A, -1, NOW], [A, Number.NaN, NOW], [A, Number.POSITIVE_INFINITY, NOW],
      [A, 11 * 365 * 24 * 3600 * 1000, NOW], [A, 1, -1], [A, 1, Number.NaN], [A, 1, NOW + 2 * 24 * 3600 * 1000],
    ] as Array<[string, number, number]>) {
      noteConversationRunningTime(id, ms, until)
    }
    expect(conversationRunningTimesForSave()).toEqual([])
  })

  it('keeps the most recent ones only: past the limit, the one counted up to the earliest goes, whenever it was noted', () => {
    // The first noted is recent; the earliest counted is the second noted.
    noteConversationRunningTime(idOf(1), 1_000, NOW - 10)
    for (let i = 1; i < CONVERSATION_RUNNING_TIMES_KEPT; i++) noteConversationRunningTime(idOf(i + 1), 1_000, NOW - 1_000_000 + i)
    noteConversationRunningTime(A, 5_000, NOW)
    expect(conversationRunningTimesForSave()).toHaveLength(CONVERSATION_RUNNING_TIMES_KEPT)
    expect(conversationRunningTime(idOf(2))).toBeNull()
    expect(conversationRunningTime(idOf(1))).not.toBeNull()
    expect(conversationRunningTime(idOf(3))).not.toBeNull()
    expect(conversationRunningTime(A)).toEqual({ ms: 5_000, until: NOW, gaps: [] })
  })

  it('is written for the saved state as a list of id, time and until', () => {
    noteConversationRunningTime(A, 1_000, NOW - 5)
    noteConversationRunningTime(B, 2_000, NOW)
    expect(conversationRunningTimesForSave()).toEqual([{ id: A, ms: 1_000, until: NOW - 5 }, { id: B, ms: 2_000, until: NOW }])
  })
})

describe('read back from the saved state at load', () => {
  it('takes each well-formed entry; anything else in the state is ignored', () => {
    rememberConversationRunningTimesFrom({ sessions: [], conversationRunningTimes: [
      { id: A, ms: 1_000, until: NOW - 10 },
      { id: 'x', ms: 1, until: NOW }, { id: B, ms: '5', until: NOW }, { id: B, ms: 5, until: NOW + 2 * 24 * 3600 * 1000 },
      { id: B, ms: -5, until: NOW }, null, 7, 'text', { id: B },
    ] })
    expect(conversationRunningTimesForSave()).toEqual([{ id: A, ms: 1_000, until: NOW - 10 }])
    for (const state of [null, undefined, 7, 'x', {}, { conversationRunningTimes: 'x' }, { conversationRunningTimes: { id: A } }]) {
      rememberConversationRunningTimesFrom(state)
    }
    expect(conversationRunningTimesForSave()).toEqual([{ id: A, ms: 1_000, until: NOW - 10 }])
  })

  it('an entry main already has counted further is kept as main has it', () => {
    noteConversationRunningTime(A, 9_000, NOW)
    rememberConversationRunningTimesFrom({ conversationRunningTimes: [{ id: A.toUpperCase(), ms: 1_000, until: NOW - 60_000 }, { id: B, ms: 3_000, until: NOW - 1 }] })
    expect(conversationRunningTime(A)).toEqual({ ms: 9_000, until: NOW, gaps: [] })
    rememberConversationRunningTimesFrom({ conversationRunningTimes: [{ id: B, ms: 4_000, until: NOW }] })
    expect(conversationRunningTime(B)).toEqual({ ms: 4_000, until: NOW, gaps: [] })
  })

  it('reads no more entries than it keeps', () => {
    const list = Array.from({ length: CONVERSATION_RUNNING_TIMES_KEPT + 50 }, (_, i) => ({ id: idOf(i + 1), ms: 1, until: NOW - 5_000 + i }))
    rememberConversationRunningTimesFrom({ conversationRunningTimes: list })
    expect(conversationRunningTimesForSave()).toHaveLength(CONVERSATION_RUNNING_TIMES_KEPT)
    expect(conversationRunningTime(idOf(CONVERSATION_RUNNING_TIMES_KEPT + 1))).toBeNull()
  })
})


// CI at 427807fb: a run that ends before its count of a large rollout is
// done is kept at once, and the spans whose completed turns it had not
// counted are kept as gaps for the next run to count.
describe('the gaps kept with a conversation\'s time', () => {
  it('are kept with it, handed out as a copy, and saved only where there are some', () => {
    noteConversationRunningTime(A, 1_000, NOW, [{ from: 0, to: NOW - 5_000 }])
    noteConversationRunningTime(B, 2_000, NOW)
    const got = conversationRunningTime(A)!
    expect(got).toEqual({ ms: 1_000, until: NOW, gaps: [{ from: 0, to: NOW - 5_000 }] })
    got.gaps[0].to = 1
    expect(conversationRunningTime(A)!.gaps).toEqual([{ from: 0, to: NOW - 5_000 }])
    expect(conversationRunningTimesForSave()).toEqual([{ id: A, ms: 1_000, until: NOW, gaps: [{ from: 0, to: NOW - 5_000 }] }, { id: B, ms: 2_000, until: NOW }])
  })

  it('only spans before the time counted up to; at most CONVERSATION_GAPS_KEPT, of spans alike the latest', () => {
    const many = Array.from({ length: CONVERSATION_GAPS_KEPT + 3 }, (_, i) => ({ from: 1_000 * i + 1, to: 1_000 * i + 500 }))
    // Given newest first, with some that are not spans before NOW among them.
    noteConversationRunningTime(A, 1_000, NOW, [{ from: 5, to: 5 }, { from: 9, to: 3 }, { from: -1, to: 4 }, { from: 1, to: NOW + 1 }, { from: '10', to: 20 } as never, ...[...many].reverse()])
    expect(conversationRunningTime(A)!.gaps).toEqual(many.slice(-CONVERSATION_GAPS_KEPT))
  })

  // P3.16 (M4): each Restart while a large rollout's count is incomplete adds
  // one gap, the few seconds the session was not running. Past the cap the
  // shortest go, never the conversation's history before the app first ran it.
  it('past CONVERSATION_GAPS_KEPT the shortest spans go, never the long span of the history before them', () => {
    const history = { from: 0, to: NOW - 100_000 }
    const pauses = Array.from({ length: CONVERSATION_GAPS_KEPT + 2 }, (_, i) => ({ from: NOW - 90_000 + i * 5_000, to: NOW - 90_000 + i * 5_000 + 1_000 + (i % 3) * 100 }))
    noteConversationRunningTime(A, 1_000, NOW, [history, ...pauses])
    const gaps = conversationRunningTime(A)!.gaps
    expect(gaps).toHaveLength(CONVERSATION_GAPS_KEPT)
    expect(gaps[0]).toEqual(history)
    // The three shortest pauses (1000 ms each, the earliest of them first) went.
    const shortest = pauses.filter((_, i) => i % 3 === 0).slice(0, 3)
    for (const p of shortest) expect(gaps).not.toContainEqual(p)
    expect(gaps.map((g) => g.from)).toEqual([...gaps.map((g) => g.from)].sort((a, b) => a - b))
  })

  it('spans that touch or overlap are one span', () => {
    noteConversationRunningTime(A, 1_000, NOW, [{ from: 40, to: 50 }, { from: 10, to: 20 }, { from: 20, to: 30 }, { from: 25, to: 35 }, { from: 60, to: 70 }, { from: 61, to: 65 }])
    expect(conversationRunningTime(A)!.gaps).toEqual([{ from: 10, to: 35 }, { from: 40, to: 50 }, { from: 60, to: 70 }])
  })

  it('the turns of the gaps a run had counted are kept with them, as a figure never below them, and saved and read back', () => {
    noteConversationRunningTime(A, 1_000, NOW, [{ from: 0, to: NOW - 5_000 }], 500)
    expect(conversationRunningTime(A)).toEqual({ ms: 1_000, until: NOW, gaps: [{ from: 0, to: NOW - 5_000 }], gapMs: 500 })
    expect(conversationRunningTimesForSave()).toEqual([{ id: A, ms: 1_000, until: NOW, gaps: [{ from: 0, to: NOW - 5_000 }], gapMs: 500 }])
    __resetConversationRunningTimesForTests()
    rememberConversationRunningTimesFrom({ conversationRunningTimes: [{ id: A, ms: 1_000, until: NOW, gaps: [{ from: 0, to: NOW - 5_000 }], gapMs: 500 }] })
    expect(conversationRunningTime(A)!.gapMs).toBe(500)
    // Without gaps there is nothing it is a part of: none kept.
    noteConversationRunningTime(B, 2_000, NOW, [], 700)
    expect(conversationRunningTime(B)).toEqual({ ms: 2_000, until: NOW, gaps: [] })
    // Not a time: none kept.
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5' as never]) {
      noteConversationRunningTime(A, 1_000, NOW, [{ from: 0, to: NOW - 5_000 }], bad)
      expect(conversationRunningTime(A)!.gapMs).toBeUndefined()
    }
  })

  it('a gap that is not a span of numbers from 0 on, ending by its until, is passed over whatever else is kept', () => {
    noteConversationRunningTime(A, 1_000, NOW, [{ from: 5, to: 5 }, { from: 9, to: 3 }, { from: -1, to: 4 }, { from: '10', to: 20 } as never, { from: 1, to: 2 }])
    expect(conversationRunningTime(A)!.gaps).toEqual([{ from: 1, to: 2 }])
  })

  it('reads no more than four times as many gaps as it keeps', () => {
    const junk = Array.from({ length: CONVERSATION_GAPS_KEPT * 4 }, () => ({ from: 'x', to: 0 }))
    noteConversationRunningTime(A, 1_000, NOW, [...junk, { from: 1, to: 2 }] as never)
    expect(conversationRunningTime(A)!.gaps).toEqual([])
  })

  it('read back from the saved state schema-checked: a gap that is not a span before its time is passed over', () => {
    rememberConversationRunningTimesFrom({ conversationRunningTimes: [
      { id: A, ms: 1_000, until: NOW, gaps: [{ from: 0, to: NOW - 1 }, { from: 'x', to: 5 }, null, { from: 10, to: NOW + 5 }, 7] },
      { id: B, ms: 2_000, until: NOW, gaps: 'not a list' },
    ] })
    expect(conversationRunningTime(A)!.gaps).toEqual([{ from: 0, to: NOW - 1 }])
    expect(conversationRunningTime(B)).toEqual({ ms: 2_000, until: NOW, gaps: [] })
  })
})
