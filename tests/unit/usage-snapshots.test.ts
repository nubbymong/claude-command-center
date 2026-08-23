/**
 * Persisted last-known-good usage.
 *
 * The map behind `resolveUsageOutcome`'s "stale" branch used to be memory-only
 * and cleared on restart, which meant the case it was most wanted in -- reopen
 * the app, pick an account before any session has run -- was the one case it
 * could not serve. These tests pin the disk half.
 *
 * A snapshot is a convenience, never a source of truth, so the rule everything
 * here checks is: anything that does not fully typecheck is DROPPED, entry by
 * entry. Falling back to a live fetch costs nothing; trusting a half-parsed
 * record paints wrong numbers over a real account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const store: Record<string, unknown> = {}
let readThrows = false
let writeThrows = false
/** #371: the file is THERE and cannot be read — distinct from "not there". */
let readFails = false

vi.mock('../../src/main/config-manager', () => ({
  readConfig: (key: string) => {
    if (readThrows) throw new Error('unreadable')
    return store[key] ?? null
  },
  readConfigChecked: (key: string) => {
    if (readThrows) throw new Error('unreadable')
    if (readFails) return { value: null, outcome: 'failed' }
    return key in store ? { value: store[key], outcome: 'ok' } : { value: null, outcome: 'absent' }
  },
  writeConfig: (key: string, data: unknown) => {
    if (writeThrows) throw new Error('read-only volume')
    store[key] = data
    return true
  },
}))

const { parseSnapshots, loadSnapshots, saveSnapshots, _resetSnapshotsLatchForTest } = await import('../../src/main/usage/usage-snapshots')
import type { UsageSnapshot } from '../../src/main/usage/usage-snapshots'

const bucket = (over: Record<string, unknown> = {}) => ({
  key: 'session:', label: '5h', group: 'session', percent: 41, resetsAt: '', severity: 'normal', ...over,
})

const good = (over: Record<string, unknown> = {}) => ({
  buckets: [bucket()], fetchedAt: 1_000, ...over,
})

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k]
  readThrows = false
  writeThrows = false
  readFails = false
  _resetSnapshotsLatchForTest()
})

/**
 * #371 — an unreadable file is NOT "no snapshots".
 *
 * The old comment on `loadSnapshots` said it was, and every caller rebuilds the
 * whole map and saves it back, so one EBUSY read at the wrong moment dropped
 * every OTHER profile's snapshot too.
 */
describe('a read failure is not an absence', () => {
  it('refuses to save over a file it could not read', () => {
    store.usageSnapshots = { p1: good(), p2: good({ fetchedAt: 2_000 }) }
    readFails = true

    // The caller sees an empty map and does the ordinary thing with it.
    expect(loadSnapshots().size).toBe(0)
    expect(saveSnapshots(new Map())).toBe(false)

    // Both profiles are still on disk.
    readFails = false
    const back = loadSnapshots()
    expect(back.size).toBe(2)
    expect(back.get('p2')!.fetchedAt).toBe(2_000)
  })

  it('resumes saving once a load succeeds', () => {
    store.usageSnapshots = { p1: good() }
    readFails = true
    loadSnapshots()
    expect(saveSnapshots(new Map())).toBe(false)

    readFails = false
    expect(loadSnapshots().size).toBe(1)
    expect(saveSnapshots(new Map([['p9', good({ fetchedAt: 9_000 }) as UsageSnapshot]]))).toBe(true)
    expect(loadSnapshots().get('p9')!.fetchedAt).toBe(9_000)
  })

  it('an ABSENT file still saves — a fresh install must be able to write its first snapshot', () => {
    expect(loadSnapshots().size).toBe(0)
    expect(saveSnapshots(new Map([['p1', good() as UsageSnapshot]]))).toBe(true)
  })
})

describe('parseSnapshots -- what it accepts', () => {
  it('round-trips a well-formed entry', () => {
    const m = parseSnapshots({ p1: good() })
    expect(m.get('p1')!.fetchedAt).toBe(1_000)
    expect(m.get('p1')!.buckets).toHaveLength(1)
    expect(m.get('p1')!.buckets[0].label).toBe('5h')
  })

  it('keeps credits when they are an object, and drops them when they are not', () => {
    expect(parseSnapshots({ p1: good({ credits: { currency: 'GBP' } }) }).get('p1')!.credits)
      .toEqual({ currency: 'GBP' })
    expect(parseSnapshots({ p1: good({ credits: 'nope' }) }).get('p1')!.credits).toBeUndefined()
  })
})

describe('parseSnapshots -- what it drops, and why', () => {
  const rejected: Array<[string, unknown]> = [
    ['a non-object blob', 'hello'],
    ['null', null],
    // An array's numeric indices would become profile ids.
    ['an array', [good()]],
  ]
  for (const [what, raw] of rejected) {
    it(`returns nothing for ${what}`, () => {
      expect(parseSnapshots(raw).size).toBe(0)
    })
  }

  const badEntries: Array<[string, unknown]> = [
    ['a missing buckets array', { fetchedAt: 1 }],
    ['a bucket with a NaN percent', { buckets: [bucket({ percent: NaN })], fetchedAt: 1 }],
    ['a bucket with a numeric label', { buckets: [bucket({ label: 5 })], fetchedAt: 1 }],
    ['a bucket missing resetsAt', { buckets: [{ key: 'k', label: '5h', group: 'session', percent: 1 }], fetchedAt: 1 }],
    ['a missing fetchedAt', { buckets: [bucket()] }],
    ['a non-numeric fetchedAt', { buckets: [bucket()], fetchedAt: 'yesterday' }],
  ]
  for (const [what, entry] of badEntries) {
    it(`drops an entry with ${what}`, () => {
      expect(parseSnapshots({ p1: entry }).has('p1')).toBe(false)
    })
  }

  it('drops a fetchedAt in the future, which would render as a negative age', () => {
    expect(parseSnapshots({ p1: good({ fetchedAt: Date.now() + 3_600_000 }) }).has('p1')).toBe(false)
  })

  it('drops only the bad entry, never the whole file', () => {
    const m = parseSnapshots({ bad: { buckets: 'no' }, good: good() })
    expect(m.has('bad')).toBe(false)
    expect(m.has('good')).toBe(true)
  })
})

describe('load / save', () => {
  it('survives a restart: what is saved is what comes back', () => {
    const snaps = new Map<string, UsageSnapshot>([
      ['p1', { buckets: [bucket()], fetchedAt: 1_000 }],
    ])
    expect(saveSnapshots(snaps)).toBe(true)
    // Fresh process: the map is gone, only the file remains.
    const back = loadSnapshots()
    expect(back.get('p1')!.fetchedAt).toBe(1_000)
    expect(back.get('p1')!.buckets[0].percent).toBe(41)
  })

  it('reads an empty map on a fresh install, rather than throwing', () => {
    expect(loadSnapshots().size).toBe(0)
  })

  it('reads an empty map when the file cannot be read at all', () => {
    readThrows = true
    expect(loadSnapshots().size).toBe(0)
  })

  it('reports failure without throwing when the write cannot land', () => {
    writeThrows = true
    expect(saveSnapshots(new Map([['p1', { buckets: [], fetchedAt: 1 }]]))).toBe(false)
  })
})
