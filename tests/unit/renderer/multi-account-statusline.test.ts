import { describe, it, expect } from 'vitest'
import {
  liveAccountUsage,
  splitAccountRows,
  FOOTER_MAX_PER_ROW,
  FOOTER_MAX_ROWS,
  FOOTER_MAX_VISIBLE,
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
})

// Footer row splitting (owner request): <=3 accounts stay on ONE row exactly as
// before; 4-6 stretch the footer to two rows of at most 3; past 6 the tail goes
// behind a "+N" overflow control. Generic + pure, so the boundaries are tested
// here without a DOM (the rendered counterpart lives in
// multi-account-statusline-render.test.tsx).
describe('splitAccountRows -- footer row/overflow boundaries', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => `a${i + 1}`)

  it('exposes the layout caps the footer is built around', () => {
    expect(FOOTER_MAX_PER_ROW).toBe(3)
    expect(FOOTER_MAX_ROWS).toBe(2)
    expect(FOOTER_MAX_VISIBLE).toBe(6)
  })

  it('keeps 1-3 accounts on a single row (no layout change from before)', () => {
    expect(splitAccountRows(list(1))).toEqual({ rows: [['a1']], overflow: [] })
    expect(splitAccountRows(list(2))).toEqual({ rows: [['a1', 'a2']], overflow: [] })
    expect(splitAccountRows(list(3))).toEqual({ rows: [['a1', 'a2', 'a3']], overflow: [] })
  })

  it('stretches to TWO rows at 4 accounts, balanced 2+2', () => {
    const out = splitAccountRows(list(4))
    expect(out.rows).toHaveLength(2)
    expect(out.rows.map((r) => r.length)).toEqual([2, 2])
    expect(out.rows).toEqual([['a1', 'a2'], ['a3', 'a4']])
    expect(out.overflow).toEqual([])
  })

  it('splits 5 accounts 3+2 (never more than 3 on a row)', () => {
    const out = splitAccountRows(list(5))
    expect(out.rows.map((r) => r.length)).toEqual([3, 2])
    expect(out.overflow).toEqual([])
  })

  it('fills two rows of 3 at 6 accounts with NO overflow', () => {
    const out = splitAccountRows(list(6))
    expect(out.rows).toEqual([['a1', 'a2', 'a3'], ['a4', 'a5', 'a6']])
    expect(out.overflow).toEqual([])
  })

  it('shows 6 and overflows the rest at 7 accounts', () => {
    const out = splitAccountRows(list(7))
    expect(out.rows).toEqual([['a1', 'a2', 'a3'], ['a4', 'a5', 'a6']])
    expect(out.overflow).toEqual(['a7'])
  })

  it('overflows everything past 6, preserving order', () => {
    const out = splitAccountRows(list(10))
    expect(out.rows.flat()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'])
    expect(out.overflow).toEqual(['a7', 'a8', 'a9', 'a10'])
  })

  it('never puts more than 3 on a row and never renders more than 2 rows', () => {
    for (let n = 1; n <= 25; n++) {
      const out = splitAccountRows(list(n))
      expect(out.rows.length).toBeLessThanOrEqual(FOOTER_MAX_ROWS)
      for (const row of out.rows) expect(row.length).toBeLessThanOrEqual(FOOTER_MAX_PER_ROW)
      // Nothing is dropped or duplicated: rows + overflow == the input, in order.
      expect([...out.rows.flat(), ...out.overflow]).toEqual(list(n))
    }
  })

  it('returns no rows for an empty list', () => {
    expect(splitAccountRows([])).toEqual({ rows: [], overflow: [] })
  })
})
