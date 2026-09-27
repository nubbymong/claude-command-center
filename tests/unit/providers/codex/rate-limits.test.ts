// Codex allowance normaliser (usage track MP2): one reading shape from a
// rollout's `rate_limits` (snake_case) and from the app-server's
// `account/rateLimits/read` result (camelCase), validated field by field, and
// the usage buckets the page, footer and strip draw from it. Pure: no files,
// no processes.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  normaliseCodexRateLimits,
  mergeAllowanceReadings,
  readingToBuckets,
  CODEX_DEFAULT_LIMIT_ID,
} from '../../../../src/main/providers/codex/rate-limits'
import { planLabelFor } from '../../../../src/shared/usage-types'
import { withAllowance } from '../../../../src/main/providers/codex/telemetry'

const FIXTURE_LINES = readFileSync(join(__dirname, '../../../fixtures/codex/rollout-sample.jsonl'), 'utf-8').split('\n')
const line = (n: number) => JSON.parse(FIXTURE_LINES[n - 1]) as { timestamp: string; payload: { info: unknown; rate_limits: unknown } }
const schema = (v: string) =>
  JSON.parse(readFileSync(join(__dirname, `../../../fixtures/codex/app-server/${v}/usage-schema.json`), 'utf-8'))

// The default limit id, named so the fixtures below read as data.
const DEFAULT_ID = CODEX_DEFAULT_LIMIT_ID
const AT = Date.parse('2026-04-30T05:13:52.611Z')
const S = (iso: string) => Math.floor(Date.parse(iso) / 1000)

describe('normaliseCodexRateLimits from a rollout', () => {
  it('reads the pre-response token_count (fixture line 8, info null) the same as a later one', () => {
    const l8 = line(8)
    expect(l8.payload.info).toBeNull()
    const r = normaliseCodexRateLimits(l8.payload.rate_limits, 'rollout', Date.parse(l8.timestamp))!
    expect(r).not.toBeNull()
    expect(r.planType).toBe('plus')
    expect(r.readingAt).toBe(Date.parse('2026-04-30T05:13:52.611Z'))
    expect(r.limits).toEqual([
      {
        limitId: 'codex',
        limitName: null,
        readingAt: Date.parse('2026-04-30T05:13:52.611Z'),
        primary: { windowMinutes: 300, usedPercent: 1, resetsAt: 1777544035 * 1000 },
        secondary: { windowMinutes: 10080, usedPercent: 13, resetsAt: 1777959356 * 1000 },
      },
    ])
  })

  it('reads fixture line 11 (a token_count with usage) to the same windows', () => {
    const l11 = line(11)
    const r = normaliseCodexRateLimits(l11.payload.rate_limits, 'rollout', Date.parse(l11.timestamp))!
    const r8 = normaliseCodexRateLimits(line(8).payload.rate_limits, 'rollout', AT)!
    const windows = (x: typeof r) => x.limits.map((l) => ({ ...l, readingAt: 0 }))
    expect(windows(r)).toEqual(windows(r8))
    expect(r.limits[0].readingAt).toBe(Date.parse(l11.timestamp))
    expect(r.planType).toBe('plus')
  })

  it('treats a snapshot with no limit id (older CLIs) as the default limit', () => {
    const r = normaliseCodexRateLimits({ primary: { used_percent: 5, window_minutes: 300, resets_at: S('2026-04-30T09:00:00Z') } }, 'rollout', AT)!
    expect(r.limits[0].limitId).toBe(CODEX_DEFAULT_LIMIT_ID)
    expect(r.limits[0].secondary).toBeNull()
  })

  it('reads plan_type where the CLI writes it, on the snapshot, never under primary', () => {
    const underPrimary = normaliseCodexRateLimits({ limit_id: DEFAULT_ID, primary: { used_percent: 5, window_minutes: 300, plan_type: 'pro' } }, 'rollout', AT)!
    expect(underPrimary.planType).toBeNull()
    const onSnapshot = normaliseCodexRateLimits({ limit_id: DEFAULT_ID, plan_type: 'pro', primary: { used_percent: 5, window_minutes: 300 } }, 'rollout', AT)!
    expect(onSnapshot.planType).toBe('pro')
  })
})

describe('normaliseCodexRateLimits from the app-server read (camelCase)', () => {
  const NOW = Date.parse('2026-09-27T12:00:00Z')
  const window = (usedPercent: number, windowDurationMins: number, resets: string) =>
    ({ usedPercent, windowDurationMins, resetsAt: S(resets) })
  // Shaped as 0.155.1 answers: the fields added after 0.153.4 are present and ignored.
  const result = {
    rateLimits: {
      limitId: 'codex', limitName: null, normalModelSlug: null,
      primary: window(22, 300, '2026-09-27T14:10:00Z'),
      secondary: window(61, 10080, '2026-10-01T09:00:00Z'),
      credits: { hasCredits: false, unlimited: false, balance: null },
      individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {
      [DEFAULT_ID]: {
        limitId: 'codex', limitName: null, normalModelSlug: null,
        primary: window(22, 300, '2026-09-27T14:10:00Z'),
        secondary: window(61, 10080, '2026-10-01T09:00:00Z'),
        credits: null, individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null,
      },
      codex_spark: {
        limitId: 'codex_spark', limitName: 'GPT-5.3-Codex-Spark', normalModelSlug: 'gpt-5.3-codex',
        primary: window(4, 300, '2026-09-27T15:00:00Z'),
        secondary: null,
        credits: null, individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null,
      },
    },
    rateLimitResetCredits: null, accountId: 'acct-anon', rateLimitUpsell: null, ordinaryUsageAllowed: true,
  }

  it('reads every limit once, the default first, with the read time as the reading time', () => {
    const r = normaliseCodexRateLimits(result, 'app-server', NOW, NOW)!
    expect(r.readingAt).toBe(NOW)
    expect(r.planType).toBe('pro')
    expect(r.limits.map((l) => l.limitId)).toEqual(['codex', 'codex_spark'])
    expect(r.limits[0].primary).toEqual({ windowMinutes: 300, usedPercent: 22, resetsAt: Date.parse('2026-09-27T14:10:00Z') })
    expect(r.limits[1]).toEqual({
      limitId: 'codex_spark', limitName: 'GPT-5.3-Codex-Spark', readingAt: NOW,
      primary: { windowMinutes: 300, usedPercent: 4, resetsAt: Date.parse('2026-09-27T15:00:00Z') },
      secondary: null,
    })
  })

  it('keeps nothing it was not asked for (account id, credits, upsell, the added fields)', () => {
    const r = normaliseCodexRateLimits(result, 'app-server', NOW, NOW)!
    const text = JSON.stringify(r)
    for (const dropped of ['acct-anon', 'hasCredits', 'normalModelSlug', 'ordinaryUsageAllowed', 'gpt-5.3-codex"']) {
      expect(text).not.toContain(dropped)
    }
  })

  it('reads the single snapshot when the per-limit map is null (0.153.4 allows it)', () => {
    const r = normaliseCodexRateLimits({ ...result, rateLimitsByLimitId: null }, 'app-server', NOW, NOW)!
    expect(r.limits.map((l) => l.limitId)).toEqual(['codex'])
  })

  // Review Q1: a per-limit entry never stands in for the default limit.
  const main = { limitId: 'codex', primary: window(22, 300, '2026-09-27T14:10:00Z'), planType: 'pro' }
  const shown = (r: ReturnType<typeof normaliseCodexRateLimits>) => r!.limits.map((l) => [l.limitId, l.primary?.usedPercent])

  it('a per-limit entry with no id of its own takes its key, never the default limit\'s', () => {
    const r = normaliseCodexRateLimits({ rateLimits: main, rateLimitsByLimitId: { codex_spark: { limitId: null, primary: window(90, 300, '2026-09-27T15:00:00Z') } } }, 'app-server', NOW, NOW)
    expect(shown(r)).toEqual([['codex', 22], ['codex_spark', 90]])
    expect(readingToBuckets(r).find((b) => b.label === '5h')!.percent).toBe(22)
    expect(withAllowance({ sessionId: 's' }, r).rateLimitCurrent).toBe(22)
  })

  it('a per-limit entry whose own id is not its key is dropped', () => {
    const r = normaliseCodexRateLimits({ rateLimits: main, rateLimitsByLimitId: { codex_spark: { limitId: 'codex', primary: window(90, 300, '2026-09-27T15:00:00Z'), planType: 'free' } } }, 'app-server', NOW, NOW)
    expect(shown(r)).toEqual([['codex', 22]])
    expect(r!.planType).toBe('pro')
  })

  it('a "__proto__" key in the per-limit map is dropped', () => {
    const raw = JSON.parse(`{"rateLimits":${JSON.stringify(main)},"rateLimitsByLimitId":{"__proto__":{"primary":{"usedPercent":90,"windowDurationMins":300}}}}`)
    expect(Object.keys(raw.rateLimitsByLimitId)).toEqual(['__proto__'])
    expect(shown(normaliseCodexRateLimits(raw, 'app-server', NOW, NOW))).toEqual([['codex', 22]])
    const named = JSON.parse(`{"rateLimits":${JSON.stringify(main)},"rateLimitsByLimitId":{"__proto__":{"limitId":"__proto__","primary":{"usedPercent":90,"windowDurationMins":300}}}}`)
    expect(shown(normaliseCodexRateLimits(named, 'app-server', NOW, NOW))).toEqual([['codex', 22]])
  })

  it('is null for an answer without rateLimits', () => {
    expect(normaliseCodexRateLimits({ rateLimitsByLimitId: null }, 'app-server', NOW, NOW)).toBeNull()
    expect(normaliseCodexRateLimits(null, 'app-server', NOW, NOW)).toBeNull()
  })

  // The normaliser reads exactly these protocol names. Each must exist in the
  // committed schema of every checked CLI, so a rename there fails here first.
  it.each(['0.153.4', '0.155.1', '0.157.1'])('reads only fields the %s schema defines', (v) => {
    const s = schema(v)
    const d = s.rateLimitsReadResponse.definitions
    expect(Object.keys(s.rateLimitsReadResponse.message.properties)).toEqual(expect.arrayContaining(['rateLimits', 'rateLimitsByLimitId']))
    expect(Object.keys(d.RateLimitSnapshot.properties)).toEqual(expect.arrayContaining(['limitId', 'limitName', 'primary', 'secondary', 'planType']))
    expect(Object.keys(d.RateLimitWindow.properties).sort()).toEqual(['resetsAt', 'usedPercent', 'windowDurationMins'])
    // Every plan the CLI can report is either named or deliberately unknown.
    for (const p of d.PlanType.enum as string[]) {
      if (p === 'unknown') expect(planLabelFor(p)).toBeNull()
      else expect(planLabelFor(p)).toEqual(expect.any(String))
    }
  })
})

describe('normaliseCodexRateLimits rejects hostile or broken input', () => {
  const base = (over: Record<string, unknown>) => ({ limit_id: DEFAULT_ID, plan_type: 'plus', primary: { used_percent: 10, window_minutes: 300, resets_at: S('2026-04-30T09:00:00Z') }, ...over })

  it('is null for anything that is not a plain snapshot object', () => {
    for (const bad of [null, undefined, 'x', 3, [], [base({})], true]) {
      expect(normaliseCodexRateLimits(bad, 'rollout', AT)).toBeNull()
    }
  })

  it('clamps percentages to 0-100 and drops a window without a finite percentage', () => {
    const hi = normaliseCodexRateLimits(base({ primary: { used_percent: 250, window_minutes: 300 } }), 'rollout', AT)!
    expect(hi.limits[0].primary!.usedPercent).toBe(100)
    const lo = normaliseCodexRateLimits(base({ primary: { used_percent: -4, window_minutes: 300 } }), 'rollout', AT)!
    expect(lo.limits[0].primary!.usedPercent).toBe(0)
    for (const bad of ['50', null, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      const r = normaliseCodexRateLimits(base({ primary: { used_percent: bad, window_minutes: 300 } }), 'rollout', AT)
      expect(r?.limits ?? []).toEqual([])
    }
  })

  it('keeps a window length only when it is a positive whole number of minutes', () => {
    for (const bad of [0, -300, 1.5, '300', null, 10_000_000]) {
      const r = normaliseCodexRateLimits(base({ primary: { used_percent: 10, window_minutes: bad } }), 'rollout', AT)!
      expect(r.limits[0].primary!.windowMinutes).toBeNull()
    }
  })

  it('keeps a reset time only within 60 days of the reading, in either direction', () => {
    const at = (iso: string) => normaliseCodexRateLimits(base({ primary: { used_percent: 10, window_minutes: 300, resets_at: S(iso) } }), 'rollout', AT)!.limits[0].primary!.resetsAt
    expect(at('2026-06-28T05:00:00Z')).toBe(Date.parse('2026-06-28T05:00:00Z'))
    expect(at('2026-03-02T06:00:00Z')).toBe(Date.parse('2026-03-02T06:00:00Z'))
    expect(at('2026-07-01T06:00:00Z')).toBeNull()
    expect(at('2026-02-27T06:00:00Z')).toBeNull()
    for (const bad of ['1777544035', Number.NaN, null, 1e30]) {
      const r = normaliseCodexRateLimits(base({ primary: { used_percent: 10, window_minutes: 300, resets_at: bad } }), 'rollout', AT)!
      expect(r.limits[0].primary!.resetsAt).toBeNull()
    }
  })

  it('bounds reset times by the time of reading, not by today, so an old reading keeps its resets', () => {
    const old = normaliseCodexRateLimits(line(8).payload.rate_limits, 'rollout', AT, Date.parse('2026-09-27T12:00:00Z'))!
    expect(old.limits[0].primary!.resetsAt).toBe(1777544035 * 1000)
  })

  it('keeps a plan only from the known list (unknown stays unknown)', () => {
    for (const bad of ['unknown', 'platinum', 7, null, '__proto__']) {
      expect(normaliseCodexRateLimits(base({ plan_type: bad }), 'rollout', AT)!.planType).toBeNull()
    }
  })

  it('drops a snapshot whose limit id is not a short plain identifier', () => {
    for (const bad of [7, '', 'a:b', 'a/b', 'x'.repeat(65), 'bad id', 'id\u0000']) {
      expect(normaliseCodexRateLimits(base({ limit_id: bad }), 'rollout', AT)?.limits ?? []).toEqual([])
    }
  })

  it('keeps a limit name only when printable and at most 40 characters', () => {
    const name = (n: unknown) => normaliseCodexRateLimits(base({ limit_id: 'other', limit_name: n }), 'rollout', AT)!.limits[0].limitName
    expect(name('  Spark  ')).toBe('Spark')
    expect(name('x'.repeat(40))).toBe('x'.repeat(40))
    for (const bad of ['x'.repeat(41), 'a\u0007b', 'a' + String.fromCharCode(0x202e) + 'b', '   ', 5, null]) {
      expect(name(bad)).toBeNull()
    }
  })

  it('reads own properties only, never inherited ones', () => {
    const proto = { limit_id: DEFAULT_ID, plan_type: 'pro', primary: { used_percent: 10, window_minutes: 300 } }
    const inherited = Object.create(proto) as Record<string, unknown>
    expect(normaliseCodexRateLimits(inherited, 'rollout', AT)).toBeNull()
    // A polluted Object.prototype must not supply a field either.
    Object.defineProperty(Object.prototype, 'plan_type', { value: 'pro', configurable: true, enumerable: false })
    try {
      expect(normaliseCodexRateLimits({ primary: { used_percent: 10, window_minutes: 300 } }, 'rollout', AT)!.planType).toBeNull()
    } finally {
      delete (Object.prototype as Record<string, unknown>).plan_type
    }
  })

  // Review Q5: the classic JSON "__proto__" attack. A payload's "__proto__"
  // key, copied by a naive merge elsewhere in the process, lands on
  // Object.prototype itself; only own-property reads keep it out of a reading.
  it('a JSON "__proto__" payload merged naively elsewhere never supplies a field', () => {
    const payload = JSON.parse('{"__proto__":{"plan_type":"pro","limit_id":"codex_polluted"}}') as Record<string, Record<string, unknown>>
    const naive: Record<string, Record<string, unknown>> = {}
    try {
      for (const k of Object.keys(payload)) for (const [kk, v] of Object.entries(payload[k])) naive[k][kk] = v
      expect(({} as Record<string, unknown>).plan_type).toBe('pro')
      const r = normaliseCodexRateLimits({ primary: { used_percent: 10, window_minutes: 300 } }, 'rollout', AT)!
      expect(r.planType).toBeNull()
      expect(r.limits[0].limitId).toBe(CODEX_DEFAULT_LIMIT_ID)
    } finally {
      delete (Object.prototype as Record<string, unknown>).plan_type
      delete (Object.prototype as Record<string, unknown>).limit_id
    }
  })

  // Review Q2: a reading time at the very edge of the Date range must not let
  // a reset time past it through (toISOString would throw on it).
  it('keeps a reset time only inside the Date range, whatever the reading time', () => {
    const edge = 8.64e15
    const r = normaliseCodexRateLimits({ limit_id: 'codex_x', primary: { used_percent: 5, window_minutes: 300, resets_at: edge / 1000 + 3600 } }, 'rollout', edge)!
    expect(r.limits[0].primary!.resetsAt).toBeNull()
    expect(() => readingToBuckets(r)).not.toThrow()
    expect(() => withAllowance({ sessionId: 's' }, r)).not.toThrow()
    const beyond = normaliseCodexRateLimits({ limit_id: DEFAULT_ID, primary: { used_percent: 5, window_minutes: 300 } }, 'rollout', edge + 1)!
    expect(beyond.readingAt).toBeNull()
  })

  // MP3 review M6: a reading time from the far future is held to now plus a
  // small skew, so it can neither look fresh for ever nor pin the live figure
  // against every later reading.
  it('holds a reading time from the future to now plus five minutes', () => {
    const now = Date.parse('2026-09-27T12:00:00Z')
    const r = normaliseCodexRateLimits(base({}), 'rollout', now + 10 * 86_400_000, now)!
    expect(r.readingAt).toBe(now + 5 * 60_000)
    expect(r.limits[0].readingAt).toBe(now + 5 * 60_000)
    const near = normaliseCodexRateLimits(base({}), 'rollout', now + 60_000, now)!
    expect(near.readingAt).toBe(now + 60_000)
  })

  it('reads plain objects only: an array carrying snapshot fields is refused', () => {
    const arr = Object.assign([], { limit_id: DEFAULT_ID, primary: { used_percent: 10, window_minutes: 300 } })
    expect(normaliseCodexRateLimits(arr, 'rollout', AT)).toBeNull()
    const win = Object.assign([], { used_percent: 10, window_minutes: 300 })
    expect(normaliseCodexRateLimits({ limit_id: DEFAULT_ID, primary: win }, 'rollout', AT)).toBeNull()
  })

  it('takes at most eight limits from the per-limit map', () => {
    const many: Record<string, unknown> = {}
    for (let i = 0; i < 20; i++) many[`l${String(i).padStart(2, '0')}`] = { limitId: `l${String(i).padStart(2, '0')}`, primary: { usedPercent: i, windowDurationMins: 300, resetsAt: null } }
    const r = normaliseCodexRateLimits({ rateLimits: { limitId: 'codex', primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null } }, rateLimitsByLimitId: many }, 'app-server', AT, AT)!
    expect(r.limits.length).toBe(8)
    expect(r.limits[0].limitId).toBe('codex')
  })
})

describe('mergeAllowanceReadings (the latest snapshot per limit)', () => {
  const snap = (id: string, pct: number, plan: string | null = 'plus') => ({ limit_id: id, plan_type: plan, primary: { used_percent: pct, window_minutes: 300 } })

  it('keeps the newest reading of each limit, each with its own time; the reading as a whole is as old as its oldest limit', () => {
    const a = normaliseCodexRateLimits(snap('codex', 10), 'rollout', AT)
    const b = normaliseCodexRateLimits(snap('codex_spark', 3), 'rollout', AT + 1000)
    const c = normaliseCodexRateLimits(snap('codex', 12, null), 'rollout', AT + 2000)
    const m = mergeAllowanceReadings([a, b, c])!
    expect(m.limits.map((l) => [l.limitId, l.primary!.usedPercent, l.readingAt])).toEqual([['codex', 12, AT + 2000], ['codex_spark', 3, AT + 1000]])
    expect(m.readingAt).toBe(AT + 1000)
    expect(m.planType).toBe('plus')
  })

  // Review Q3: after a switch to another model's limit, the default figure
  // does not borrow the newer limit's time.
  it('a default figure left behind by a switch to another limit keeps its own, older time', () => {
    const before = normaliseCodexRateLimits(snap('codex', 40), 'rollout', AT)
    const after = normaliseCodexRateLimits(snap('codex_spark', 2), 'rollout', AT + 3 * 3_600_000)
    const m = mergeAllowanceReadings([before, after])!
    expect(m.limits.find((l) => l.limitId === 'codex')!.readingAt).toBe(AT)
    expect(m.readingAt).toBe(AT)
    expect(withAllowance({ sessionId: 's' }, m).rateLimitsAt).toBe(AT)
  })

  it('is null when there is nothing to merge', () => {
    expect(mergeAllowanceReadings([])).toBeNull()
    expect(mergeAllowanceReadings([null, null])).toBeNull()
  })
})

describe('readingToBuckets', () => {
  it('gives the default limit time-window buckets labelled from the window length', () => {
    const r = normaliseCodexRateLimits(line(8).payload.rate_limits, 'rollout', AT)!
    expect(readingToBuckets(r)).toEqual([
      { key: 'codex/300:', label: '5h', group: 'session', percent: 1, resetsAt: new Date(1777544035 * 1000).toISOString(), severity: 'normal' },
      { key: 'codex/10080:', label: 'Weekly', group: 'weekly', percent: 13, resetsAt: new Date(1777959356 * 1000).toISOString(), severity: 'normal' },
    ])
  })

  it('gives any other limit per-limit buckets, keyed like per-model buckets', () => {
    const r = normaliseCodexRateLimits({ limit_id: 'codex_spark', limit_name: 'Spark', primary: { used_percent: 4.6, window_minutes: 300 }, secondary: { used_percent: 0, window_minutes: 10080 } }, 'rollout', AT)!
    const b = readingToBuckets(r)
    expect(b.map((x) => [x.key, x.label, x.percent, x.resetsAt])).toEqual([
      ['codex_spark/300:Spark', 'Spark 5h', 5, ''],
      ['codex_spark/10080:Spark', 'Spark Weekly', 0, ''],
    ])
    // isModelBucket reads the segment after the first colon: non-empty here, empty for the default limit.
    for (const x of b) expect(x.key.slice(x.key.indexOf(':') + 1)).not.toBe('')
  })

  it('names a per-limit bucket by its id when the limit has no name', () => {
    const r = normaliseCodexRateLimits({ limit_id: 'codex_other', primary: { used_percent: 1, window_minutes: 1440 } }, 'rollout', AT)!
    expect(readingToBuckets(r).map((x) => [x.key, x.label])).toEqual([['codex_other/1440:codex_other', 'codex_other 1d']])
  })

  it('labels a window with no length by its position, as the legacy fields did', () => {
    const r = normaliseCodexRateLimits({ limit_id: DEFAULT_ID, primary: { used_percent: 1 }, secondary: { used_percent: 2 } }, 'rollout', AT)!
    expect(readingToBuckets(r).map((x) => [x.key, x.label, x.group])).toEqual([
      ['codex/primary:', '5h', 'session'],
      ['codex/secondary:', 'Weekly', 'weekly'],
    ])
  })

  it('never repeats a key', () => {
    const r = normaliseCodexRateLimits({ limit_id: DEFAULT_ID, primary: { used_percent: 1, window_minutes: 300 }, secondary: { used_percent: 2, window_minutes: 300 } }, 'rollout', AT)!
    const keys = readingToBuckets(r).map((x) => x.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('is empty for no reading', () => {
    expect(readingToBuckets(null)).toEqual([])
  })
})
