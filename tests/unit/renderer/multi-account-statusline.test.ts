import { describe, it, expect } from 'vitest'
import {
  liveAccountUsage,
  layoutFooterRows,
  reconcileFooterMetrics,
  FOOTER_MAX_ROWS,
  FOOTER_PILL_GAP_PX,
  FOOTER_OVERFLOW_RESERVE_PX,
  type LiveAccount,
} from '../../../src/renderer/components/MultiAccountStatusline'
import type { Session } from '../../../src/renderer/stores/sessionStore'
import type { AccountProfile } from '../../../src/shared/account-types'
import type { UsageBucket } from '../../../src/shared/usage-types'

function sess(p: Partial<Session>): Session {
  return { id: 'x', label: 'x', status: 'idle', ...p } as Session
}

function bucket(label: string, percent: number, extra?: Partial<UsageBucket>): UsageBucket {
  return { key: label.toLowerCase(), label, group: 'session', percent, resetsAt: '', severity: 'normal', ...extra }
}

// The footer now models usage as a per-label bucket list (dynamic: 5h, Weekly,
// Fable, ...), so tests read percent by label rather than the old pct5h/pct7d.
const pctOf = (a: LiveAccount, label: string): number | null =>
  a.buckets.find((b) => b.label === label)?.percent ?? null

const profiles: AccountProfile[] = [
  { id: 'p1', accountEmail: 'a@x.com', name: '', isPrimary: true, createdAt: 0 },
  { id: 'p2', accountEmail: 'b@x.com', name: '', createdAt: 0 },
]
const aliases = { 'a@x.com': 'Alpha', 'b@x.com': 'Bravo' }

describe('liveAccountUsage', () => {
  it('groups running sessions by account, primary first', () => {
    const out = liveAccountUsage(
      [
        sess({ id: '1', accountEmail: 'b@x.com', status: 'working', rateLimitCurrent: 10, rateLimitWeekly: 5 }),
        sess({ id: '2', accountEmail: 'a@x.com', status: 'idle', rateLimitCurrent: 30, rateLimitWeekly: 12 }),
      ],
      profiles,
      aliases,
      undefined,
    )
    expect(out.map((a) => a.name)).toEqual(['Alpha', 'Bravo']) // primary (a) first
    expect(pctOf(out[0], '5h')).toBe(30)
    expect(pctOf(out[1], 'Weekly')).toBe(5)
    expect(out[0].isPrimary).toBe(true)
  })

  it('takes worst-case (max) utilisation across an account\'s sessions', () => {
    const out = liveAccountUsage(
      [
        sess({ id: '1', accountEmail: 'a@x.com', status: 'working', rateLimitCurrent: 20, rateLimitWeekly: 8 }),
        sess({ id: '2', accountEmail: 'a@x.com', status: 'idle', rateLimitCurrent: 55, rateLimitWeekly: 4 }),
        sess({ id: '3', accountEmail: 'b@x.com', status: 'idle', rateLimitCurrent: 1, rateLimitWeekly: 1 }),
      ],
      profiles,
      aliases,
      undefined,
    )
    const alpha = out.find((a) => a.email === 'a@x.com')!
    expect(pctOf(alpha, '5h')).toBe(55)
    expect(pctOf(alpha, 'Weekly')).toBe(8)
    expect(alpha.count).toBe(2)
  })

  it('aggregates dynamic usageBuckets (e.g. Fable) worst-case per label, API order', () => {
    const out = liveAccountUsage(
      [
        sess({ id: '1', accountEmail: 'a@x.com', status: 'working', usageBuckets: [bucket('5h', 20), bucket('Weekly', 30), bucket('Fable', 90)] }),
        sess({ id: '2', accountEmail: 'a@x.com', status: 'idle', usageBuckets: [bucket('5h', 55), bucket('Weekly', 12), bucket('Fable', 40)] }),
        sess({ id: '3', accountEmail: 'b@x.com', status: 'working', rateLimitCurrent: 5 }),
      ],
      profiles,
      aliases,
      undefined,
    )
    const alpha = out.find((a) => a.email === 'a@x.com')!
    expect(alpha.buckets.map((b) => b.label)).toEqual(['5h', 'Weekly', 'Fable']) // first-seen order preserved
    expect(pctOf(alpha, '5h')).toBe(55)
    expect(pctOf(alpha, 'Fable')).toBe(90)
  })

  it('excludes disconnected sessions and those without an account', () => {
    const out = liveAccountUsage(
      [
        sess({ id: '1', accountEmail: 'a@x.com', status: 'disconnected' }),
        sess({ id: '2', accountEmail: undefined, status: 'working' }),
        sess({ id: '3', accountEmail: 'b@x.com', status: 'working', rateLimitCurrent: 9, rateLimitWeekly: 3 }),
      ],
      profiles,
      aliases,
      undefined,
    )
    expect(out).toHaveLength(1)
    expect(out[0].email).toBe('b@x.com')
  })

  it('matches accounts case-insensitively (one entry per distinct account)', () => {
    const out = liveAccountUsage(
      [
        sess({ id: '1', accountEmail: 'A@X.com', status: 'working', rateLimitCurrent: 9 }),
        sess({ id: '2', accountEmail: 'a@x.com', status: 'idle', rateLimitCurrent: 40 }),
      ],
      profiles,
      aliases,
      undefined,
    )
    expect(out).toHaveLength(1)
    expect(pctOf(out[0], '5h')).toBe(40)
    expect(out[0].count).toBe(2)
  })

  it('returns a single entry when only one account is live (component gates on >=2)', () => {
    const out = liveAccountUsage(
      [
        sess({ id: '1', accountEmail: 'a@x.com', status: 'working', rateLimitCurrent: 9, rateLimitWeekly: 3 }),
        sess({ id: '2', accountEmail: 'a@x.com', status: 'idle', rateLimitCurrent: 9, rateLimitWeekly: 3 }),
      ],
      profiles,
      aliases,
      undefined,
    )
    expect(out).toHaveLength(1)
  })

  it('leaves buckets empty when no rate-limit ticks have arrived yet', () => {
    const out = liveAccountUsage(
      [
        sess({ id: '1', accountEmail: 'a@x.com', status: 'working' }),
        sess({ id: '2', accountEmail: 'b@x.com', status: 'working' }),
      ],
      profiles,
      aliases,
      undefined,
    )
    expect(out).toHaveLength(2)
    expect(out[0].buckets).toHaveLength(0)
    expect(pctOf(out[0], '5h')).toBeNull()
  })

  // #571: an SSH session carries the remote signed-in email in sshRemoteAccount
  // (no local accountEmail). It must join the matching account row so the strip
  // shows the account name — and, when a local session on the same account
  // supplies the per-model buckets (Fable), the SSH session shares that row
  // instead of being invisible.
  it('attributes an SSH session to its account row via sshRemoteAccount (#571)', () => {
    const out = liveAccountUsage(
      [
        sess({ id: '1', accountEmail: 'a@x.com', status: 'working', usageBuckets: [bucket('5h', 20), bucket('Fable', 90)] }),
        sess({ id: '2', sshRemoteAccount: 'A@X.com', status: 'idle', rateLimitCurrent: 55 }),
      ],
      profiles,
      aliases,
      undefined,
    )
    expect(out).toHaveLength(1) // canonicalised email joins the same row
    expect(out[0].count).toBe(2)
    expect(pctOf(out[0], '5h')).toBe(55) // worst case includes the SSH session
    expect(pctOf(out[0], 'Fable')).toBe(90) // local session's bucket still shown
  })

  it('creates a row for an SSH-only account and prefers accountEmail when both exist', () => {
    const out = liveAccountUsage(
      [
        sess({ id: '1', sshRemoteAccount: 'c@x.com', status: 'working', rateLimitCurrent: 10, rateLimitWeekly: 78 }),
        // Both fields set: the LOCAL identity wins (sshRemoteAccount ignored).
        sess({ id: '2', accountEmail: 'a@x.com', sshRemoteAccount: 'c@x.com', status: 'idle', rateLimitCurrent: 5 }),
      ],
      profiles,
      aliases,
      undefined,
    )
    expect(out.map((a) => a.email).sort()).toEqual(['a@x.com', 'c@x.com'])
    const c = out.find((a) => a.email === 'c@x.com')!
    expect(c.count).toBe(1)
    expect(pctOf(c, 'Weekly')).toBe(78)
  })

  it('still skips sessions with neither accountEmail nor sshRemoteAccount', () => {
    const out = liveAccountUsage([sess({ id: '1', status: 'working', rateLimitCurrent: 99 })], profiles, aliases, undefined)
    expect(out).toHaveLength(0)
  })
})

// Footer row layout (#378). The old split was by COUNT (<=3 one row, 4..6 two
// rows, >6 overflow) and put four accounts on two rows at 1900px with empty
// footer either side. Rows now come from MEASURED widths: one row whenever
// everything fits the free width; wrap only when it truly does not, filling
// each row before the next; at most FOOTER_MAX_ROWS rows, the rest behind "+N".
// Generic + pure, so the fit boundaries are tested here without a DOM (the
// rendered counterpart lives in multi-account-statusline-render.test.tsx).
describe('layoutFooterRows -- measured footer rows (#378)', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `a${i + 1}`)
  const same = (n: number, w: number) => Array.from({ length: n }, () => w)
  const gap = FOOTER_PILL_GAP_PX

  it('exposes the layout constants the footer is built around', () => {
    expect(FOOTER_MAX_ROWS).toBe(2)
    expect(FOOTER_PILL_GAP_PX).toBe(12)
    expect(FOOTER_OVERFLOW_RESERVE_PX).toBe(40)
  })

  it('four pills of known width in a 1400px free span render on ONE row (the owner\'s case)', () => {
    // 4 x 300 + 3 gaps of 12 = 1236 <= 1400. The count-based split said 2+2.
    const out = layoutFooterRows(list(4), same(4, 300), { available: 1400 })
    expect(out).toEqual({ rows: [['a1', 'a2', 'a3', 'a4']], overflow: [] })
  })

  it('keeps everything on one row right up to the exact free width', () => {
    const exact = 4 * 300 + 3 * gap
    expect(layoutFooterRows(list(4), same(4, 300), { available: exact }).rows).toHaveLength(1)
    // Half a pixel of measurement noise does not wrap a row.
    expect(layoutFooterRows(list(4), same(4, 300), { available: exact - 0.4 }).rows).toHaveLength(1)
    // A whole pixel short does.
    expect(layoutFooterRows(list(4), same(4, 300), { available: exact - 1 }).rows).toHaveLength(2)
  })

  it('wraps FILL-FIRST, not balanced: 4 pills that do not fit go 3+1, never 2+2', () => {
    // 3 x 300 + 2 x 12 = 924 fits in 1200; the fourth (1236) does not.
    const out = layoutFooterRows(list(4), same(4, 300), { available: 1200 })
    expect(out.rows).toEqual([['a1', 'a2', 'a3'], ['a4']])
    expect(out.overflow).toEqual([])
  })

  it('more than three fit on a row when the width is there (no per-row cap)', () => {
    const out = layoutFooterRows(list(6), same(6, 200), { available: 1400 })
    // 6 x 200 + 5 x 12 = 1260 <= 1400: six on one row.
    expect(out.rows).toEqual([list(6)])
  })

  it('uses the real per-pill widths, not an average', () => {
    // 500 + 12 + 500 = 1012 > 1000, so a2 wraps; then 500 + 12 + 100 fits.
    const out = layoutFooterRows(list(3), [500, 500, 100], { available: 1000 })
    expect(out.rows).toEqual([['a1'], ['a2', 'a3']])
  })

  it('never renders more than FOOTER_MAX_ROWS rows: the tail goes to the overflow', () => {
    // 3 per row at 1000px (924); 7 pills -> 3 + 3 + 1, and the third row is
    // not allowed, so a7 overflows. The last row then has to make room for
    // the "+N" control: 924 + 12 + 40 = 976 <= 1000, so it keeps all three.
    const out = layoutFooterRows(list(7), same(7, 300), { available: 1000 })
    expect(out.rows).toEqual([['a1', 'a2', 'a3'], ['a4', 'a5', 'a6']])
    expect(out.overflow).toEqual(['a7'])
  })

  it('makes room for the "+N" control on the last row, moving pills into the overflow if it must', () => {
    // 3 x 300 + 2 x 12 = 924 fits in 940, but 924 + 12 + 40 = 976 does not:
    // the last row gives up a pill so the control fits beside the rest.
    const out = layoutFooterRows(list(7), same(7, 300), { available: 940 })
    expect(out.rows).toEqual([['a1', 'a2', 'a3'], ['a4', 'a5']])
    expect(out.overflow).toEqual(['a6', 'a7'])
  })

  it('never empties the last row to fit the control', () => {
    // One pill per row; the control does not fit beside it either, but the
    // row keeps its pill -- a row of nothing but "+N" would be worse.
    const out = layoutFooterRows(list(4), same(4, 300), { available: 310 })
    expect(out.rows).toEqual([['a1'], ['a2']])
    expect(out.overflow).toEqual(['a3', 'a4'])
  })

  it('a pill wider than the whole zone sits alone on a row rather than vanishing', () => {
    const out = layoutFooterRows(list(2), [900, 100], { available: 500 })
    expect(out.rows).toEqual([['a1'], ['a2']])
    expect(out.overflow).toEqual([])
  })

  it('estimates an unmeasured pill at the WIDEST measured one (wraps early, never spills)', () => {
    // a3 has never been painted. Estimated at 400: 400 + 12 + 400 = 812 fits
    // 1000, + 12 + 400 = 1224 does not -> 2 + 1, NOT 3 on one row.
    const out = layoutFooterRows(list(3), [400, 200, undefined], { available: 1000 })
    expect(out.rows).toEqual([['a1', 'a2'], ['a3']])
  })

  it('with no measured free width, everything is one row (first paint / jsdom) and nothing overflows', () => {
    expect(layoutFooterRows(list(9), same(9, 300), { available: 0 })).toEqual({ rows: [list(9)], overflow: [] })
    expect(layoutFooterRows(list(9), same(9, 300), { available: NaN })).toEqual({ rows: [list(9)], overflow: [] })
    // ...and likewise when not a single pill has been measured yet.
    expect(layoutFooterRows(list(9), same(9, undefined as unknown as number), { available: 1400 })).toEqual({ rows: [list(9)], overflow: [] })
  })

  it('drops nothing and duplicates nothing: rows + overflow is the input, in order, never more than 2 rows', () => {
    for (let n = 1; n <= 25; n++) {
      for (const available of [310, 700, 1000, 1400, 3000]) {
        const out = layoutFooterRows(list(n), same(n, 300), { available })
        expect(out.rows.length).toBeLessThanOrEqual(FOOTER_MAX_ROWS)
        expect([...out.rows.flat(), ...out.overflow]).toEqual(list(n))
        for (const row of out.rows) expect(row.length).toBeGreaterThan(0)
      }
    }
  })

  it('returns no rows for an empty list', () => {
    expect(layoutFooterRows([], [], { available: 1400 })).toEqual({ rows: [], overflow: [] })
  })
})

// The measurement cache behind the layout: the same object back when nothing
// moved is what ends the measure -> set -> render -> measure cycle.
describe('reconcileFooterMetrics -- measurement cache', () => {
  const live = (...k: string[]) => new Set(k)

  it('returns the SAME object when nothing moved by more than the fit epsilon', () => {
    const prev = { available: 1400, widths: { a: 300, b: 301 } }
    expect(reconcileFooterMetrics(prev, 1400.3, { a: 300.2, b: 300.8 }, live('a', 'b'))).toBe(prev)
  })

  it('returns a new object when the free width or a pill width changes', () => {
    const prev = { available: 1400, widths: { a: 300 } }
    expect(reconcileFooterMetrics(prev, 1200, { a: 300 }, live('a'))).toEqual({ available: 1200, widths: { a: 300 } })
    expect(reconcileFooterMetrics(prev, 1400, { a: 320 }, live('a'))).toEqual({ available: 1400, widths: { a: 320 } })
  })

  it('keeps the last width of a live pill that is not painted right now (behind "+N")', () => {
    const prev = { available: 1400, widths: { a: 300, b: 280 } }
    // b is live but not in the fresh sweep: its cached width survives.
    const out = reconcileFooterMetrics(prev, 1400, { a: 300 }, live('a', 'b'))
    expect(out).toBe(prev)
    expect(out.widths.b).toBe(280)
  })

  it('forgets an account that is no longer live', () => {
    const prev = { available: 1400, widths: { a: 300, gone: 280 } }
    const out = reconcileFooterMetrics(prev, 1400, { a: 300 }, live('a'))
    expect(out).not.toBe(prev)
    expect(out.widths).toEqual({ a: 300 })
  })
})
