import { describe, it, expect } from 'vitest'
import { liveAccountUsage } from '../../../src/renderer/components/MultiAccountStatusline'
import type { Session } from '../../../src/renderer/stores/sessionStore'
import type { AccountProfile } from '../../../src/shared/account-types'

function sess(p: Partial<Session>): Session {
  return { id: 'x', label: 'x', status: 'idle', ...p } as Session
}

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
    expect(out[0].pct5h).toBe(30)
    expect(out[1].pct7d).toBe(5)
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
    expect(alpha.pct5h).toBe(55)
    expect(alpha.pct7d).toBe(8)
    expect(alpha.count).toBe(2)
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
    expect(out[0].pct5h).toBe(40)
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

  it('leaves usage null when no rate-limit ticks have arrived yet', () => {
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
    expect(out[0].pct5h).toBeNull()
    expect(out[0].pct7d).toBeNull()
  })
})
