import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  normalizeAiUsage,
  fetchAiUsage,
  fetchAiUsageWithStatus,
  aiUsageReportSchema,
  AiUsageScheduler,
  __resetUsageLogGuard,
} from '../../../src/main/github/copilot-usage'

// --- Fixtures modeled on the REAL endpoint response shape ------------------

// A new-plan account that IS being billed beyond its included allowance:
// netAmount > 0 on the chat-completions row.
const AI_CREDIT_BILLED = {
  timePeriod: { year: 2026, month: 6 },
  user: 'octocat',
  usageItems: [
    {
      product: 'copilot',
      sku: 'copilot_premium_request',
      model: 'gpt-4o',
      unitType: 'request',
      pricePerUnit: 0.04,
      grossQuantity: 500,
      grossAmount: 20,
      discountQuantity: 300,
      discountAmount: 12,
      netQuantity: 200,
      netAmount: 8,
    },
    {
      product: 'copilot',
      sku: 'copilot_premium_request',
      model: 'claude-sonnet',
      unitType: 'request',
      pricePerUnit: 0.04,
      grossQuantity: 100,
      grossAmount: 4,
      discountQuantity: 100,
      discountAmount: 4,
      netQuantity: 0,
      netAmount: 0,
    },
  ],
}

// A new-plan account fully WITHIN its allowance (nothing billed).
const AI_CREDIT_COVERED = {
  timePeriod: { year: 2026, month: 6 },
  user: 'octocat',
  usageItems: [
    {
      product: 'copilot',
      sku: 'copilot_premium_request',
      model: 'gpt-4o',
      unitType: 'request',
      pricePerUnit: 0.04,
      grossQuantity: 50,
      grossAmount: 2,
      discountQuantity: 50,
      discountAmount: 2,
      netQuantity: 0,
      netAmount: 0,
    },
  ],
}

// Old-plan account: primary returns empty, fallback returns rows.
const PREMIUM_REQUEST_BILLED = {
  timePeriod: { year: 2026, month: 6 },
  user: 'octocat',
  usageItems: [
    {
      product: 'copilot',
      sku: 'premium_request',
      model: 'gpt-4o',
      unitType: 'request',
      grossQuantity: 1000,
      grossAmount: 40,
      discountQuantity: 600,
      discountAmount: 24,
      netQuantity: 400,
      netAmount: 16,
    },
  ],
}

const EMPTY_RESPONSE = { timePeriod: { year: 2026, month: 6 }, user: 'octocat', usageItems: [] }

function makeResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const tokenFn = async () => 'ghp_aaaaaaaaaaaaaaaaaaaaaaaa'

beforeEach(() => {
  __resetUsageLogGuard()
})

// --- normalizer -------------------------------------------------------------

describe('normalizeAiUsage', () => {
  it('renames discount->covered and net->billed, computes totals, stamps fetchedAt', () => {
    const report = normalizeAiUsage(AI_CREDIT_BILLED, 'ai_credit', 1_700_000_000_000)
    expect(report).not.toBeNull()
    expect(report!.source).toBe('ai_credit')
    expect(report!.fetchedAt).toBe(1_700_000_000_000)
    expect(report!.timePeriod).toEqual({ year: 2026, month: 6 })
    expect(report!.items).toHaveLength(2)

    const first = report!.items[0]
    expect(first.coveredQuantity).toBe(300)
    expect(first.coveredAmount).toBe(12)
    expect(first.billedQuantity).toBe(200)
    expect(first.billedAmount).toBe(8)
    // raw discount*/net* names are gone from the normalized item
    expect((first as Record<string, unknown>).discountAmount).toBeUndefined()
    expect((first as Record<string, unknown>).netAmount).toBeUndefined()
  })

  it('sums totals across rows; billedAmount>0 is the headline signal', () => {
    const report = normalizeAiUsage(AI_CREDIT_BILLED, 'ai_credit')!
    expect(report.totals.grossAmount).toBe(24) // 20 + 4
    expect(report.totals.coveredAmount).toBe(16) // 12 + 4
    expect(report.totals.billedAmount).toBe(8) // 8 + 0
    expect(report.totals.billedAmount).toBeGreaterThan(0)
  })

  it('reports zero billed when fully covered', () => {
    const report = normalizeAiUsage(AI_CREDIT_COVERED, 'ai_credit')!
    expect(report.totals.billedAmount).toBe(0)
  })

  it('defaults timePeriod to current month when absent', () => {
    const now = Date.UTC(2026, 5, 15) // month index 5 = June
    const report = normalizeAiUsage({ usageItems: [] }, 'ai_credit', now)!
    expect(report.timePeriod).toEqual({ year: 2026, month: 6 })
    expect(report.items).toEqual([])
    expect(report.totals).toEqual({ grossAmount: 0, coveredAmount: 0, billedAmount: 0 })
  })

  it('returns null for an unparseable body', () => {
    expect(normalizeAiUsage(42, 'ai_credit')).toBeNull()
    expect(normalizeAiUsage({ usageItems: 'nope' }, 'ai_credit')).toBeNull()
  })
})

// --- zod schema -------------------------------------------------------------

describe('aiUsageReportSchema', () => {
  it('accepts a normalized report', () => {
    const report = normalizeAiUsage(AI_CREDIT_BILLED, 'ai_credit')!
    expect(aiUsageReportSchema.safeParse(report).success).toBe(true)
  })

  it('rejects an unknown source', () => {
    const report = normalizeAiUsage(AI_CREDIT_BILLED, 'ai_credit')!
    const bad = { ...report, source: 'mystery' }
    expect(aiUsageReportSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects a report missing totals', () => {
    const report = normalizeAiUsage(AI_CREDIT_BILLED, 'ai_credit')! as Record<string, unknown>
    const { totals: _omit, ...bad } = report
    expect(aiUsageReportSchema.safeParse(bad).success).toBe(false)
  })
})

// --- fetchAiUsage (endpoint selection + fallback + 404) ---------------------

describe('fetchAiUsage', () => {
  it('uses the primary ai_credit endpoint when it returns rows', async () => {
    const fetchImpl = vi.fn(async () => makeResp(AI_CREDIT_BILLED)) as unknown as typeof fetch
    const report = await fetchAiUsage('octocat', { tokenFn, fetchImpl })
    expect(report!.source).toBe('ai_credit')
    expect(report!.totals.billedAmount).toBe(8)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const url = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(String(url)).toContain('/users/octocat/settings/billing/ai_credit/usage')
  })

  it('falls back to premium_request when the primary returns empty usageItems', async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes('/ai_credit/')
        ? makeResp(EMPTY_RESPONSE)
        : makeResp(PREMIUM_REQUEST_BILLED),
    ) as unknown as typeof fetch
    const report = await fetchAiUsage('octocat', { tokenFn, fetchImpl })
    expect(report!.source).toBe('premium_request')
    expect(report!.totals.billedAmount).toBe(16)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('treats a 404 on the primary as scope-missing and tries the fallback', async () => {
    const logFn = vi.fn()
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes('/ai_credit/')
        ? makeResp({}, 404)
        : makeResp(PREMIUM_REQUEST_BILLED),
    ) as unknown as typeof fetch
    const report = await fetchAiUsage('octocat', { tokenFn, fetchImpl, logFn })
    expect(report!.source).toBe('premium_request')
    expect(logFn).toHaveBeenCalled() // one-time 404 log
  })

  it('treats a 403 like 404 with the scope hint (fine-grained PATs lacking Plan: read return 403)', async () => {
    const logFn = vi.fn()
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes('/ai_credit/')
        ? makeResp({}, 403)
        : makeResp(PREMIUM_REQUEST_BILLED),
    ) as unknown as typeof fetch
    const report = await fetchAiUsage('octocat', { tokenFn, fetchImpl, logFn })
    expect(report!.source).toBe('premium_request') // fallback still attempted
    expect(String(logFn.mock.calls[0]?.[0] ?? '')).toContain('Plan: read')
  })

  it('returns null when BOTH endpoints 404 (unscoped token, fail open)', async () => {
    const logFn = vi.fn()
    const fetchImpl = vi.fn(async () => makeResp({}, 404)) as unknown as typeof fetch
    const report = await fetchAiUsage('octocat', { tokenFn, fetchImpl, logFn })
    expect(report).toBeNull()
  })

  it('returns null on a network failure (fail open)', async () => {
    const logFn = vi.fn()
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const report = await fetchAiUsage('octocat', { tokenFn, fetchImpl, logFn })
    expect(report).toBeNull()
  })

  it('logs failures only once per session', async () => {
    const logFn = vi.fn()
    const fetchImpl = vi.fn(async () => makeResp({}, 404)) as unknown as typeof fetch
    await fetchAiUsage('octocat', { tokenFn, fetchImpl, logFn })
    await fetchAiUsage('octocat', { tokenFn, fetchImpl, logFn })
    expect(logFn).toHaveBeenCalledTimes(1)
  })
})

// --- fetchAiUsageWithStatus (status derivation table) -----------------------

describe('fetchAiUsageWithStatus', () => {
  it('ok + report when the primary returns rows', async () => {
    const fetchImpl = vi.fn(async () => makeResp(AI_CREDIT_BILLED)) as unknown as typeof fetch
    const r = await fetchAiUsageWithStatus('octocat', { tokenFn, fetchImpl })
    expect(r.status).toBe('ok')
    expect(r.report!.totals.billedAmount).toBe(8)
  })

  it('ok + report when only the fallback returns rows', async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes('/ai_credit/')
        ? makeResp(EMPTY_RESPONSE)
        : makeResp(PREMIUM_REQUEST_BILLED),
    ) as unknown as typeof fetch
    const r = await fetchAiUsageWithStatus('octocat', { tokenFn, fetchImpl })
    expect(r.status).toBe('ok')
    expect(r.report!.source).toBe('premium_request')
  })

  it('scope-missing when BOTH endpoints return 404 (unscoped classic token)', async () => {
    const logFn = vi.fn()
    const fetchImpl = vi.fn(async () => makeResp({}, 404)) as unknown as typeof fetch
    const r = await fetchAiUsageWithStatus('octocat', { tokenFn, fetchImpl, logFn })
    expect(r.report).toBeNull()
    expect(r.status).toBe('scope-missing')
  })

  it('scope-missing when BOTH endpoints return 403 (fine-grained PAT lacking Plan: read)', async () => {
    const logFn = vi.fn()
    const fetchImpl = vi.fn(async () => makeResp({}, 403)) as unknown as typeof fetch
    const r = await fetchAiUsageWithStatus('octocat', { tokenFn, fetchImpl, logFn })
    expect(r.report).toBeNull()
    expect(r.status).toBe('scope-missing')
  })

  it('scope-missing when one endpoint 404s and the other 403s', async () => {
    const fetchImpl = vi.fn(async (url: unknown) =>
      String(url).includes('/ai_credit/') ? makeResp({}, 404) : makeResp({}, 403),
    ) as unknown as typeof fetch
    const r = await fetchAiUsageWithStatus('octocat', { tokenFn, fetchImpl })
    expect(r.status).toBe('scope-missing')
  })

  it('error (not scope-missing) on a network failure', async () => {
    const logFn = vi.fn()
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    const r = await fetchAiUsageWithStatus('octocat', { tokenFn, fetchImpl, logFn })
    expect(r.report).toBeNull()
    expect(r.status).toBe('error')
  })

  it('error when one endpoint is scope-missing but the other is a network fail (not a scope problem)', async () => {
    const fetchImpl = vi.fn(async (url: unknown) => {
      if (String(url).includes('/ai_credit/')) return makeResp({}, 404)
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    const r = await fetchAiUsageWithStatus('octocat', { tokenFn, fetchImpl })
    expect(r.status).toBe('error')
  })

  it('error when both endpoints are 200-empty (no scope problem, no rows)', async () => {
    const fetchImpl = vi.fn(async () => makeResp(EMPTY_RESPONSE)) as unknown as typeof fetch
    const r = await fetchAiUsageWithStatus('octocat', { tokenFn, fetchImpl })
    expect(r.report).toBeNull()
    expect(r.status).toBe('error')
  })

  it('error for an empty login', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const r = await fetchAiUsageWithStatus('', { tokenFn, fetchImpl })
    expect(r.status).toBe('error')
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fetchAiUsage still returns the null-based report surface (unchanged)', async () => {
    const fetchImpl = vi.fn(async () => makeResp({}, 404)) as unknown as typeof fetch
    expect(await fetchAiUsage('octocat', { tokenFn, fetchImpl })).toBeNull()
  })
})

// --- scheduler --------------------------------------------------------------

describe('AiUsageScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeDeps(over: Partial<Parameters<typeof AiUsageScheduler.prototype.constructor>[0]> = {}) {
    const emit = vi.fn()
    const fetchImpl = vi.fn(async () => makeResp(AI_CREDIT_BILLED)) as unknown as typeof fetch
    const resolve = vi.fn(async () => ({ login: 'octocat', tokenFn }))
    return {
      emit,
      fetchImpl,
      resolve,
      deps: {
        resolve,
        isEnabled: () => true,
        emit,
        refreshIntervalMs: 1000,
        fetchImpl,
        logFn: vi.fn(),
        ...over,
      },
    }
  }

  it('does NOT poll while disabled', async () => {
    const { deps, fetchImpl, resolve } = makeDeps({ isEnabled: () => false })
    const s = new AiUsageScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(5000)
    expect(resolve).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(s.getLatest()).toBeNull()
  })

  it('refresh() returns null without a fetch while disabled', async () => {
    const { deps, fetchImpl } = makeDeps({ isEnabled: () => false })
    const s = new AiUsageScheduler(deps)
    const r = await s.refresh()
    expect(r).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('fetches immediately on start and emits the report + ok status', async () => {
    const { deps, emit } = makeDeps()
    const s = new AiUsageScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit.mock.calls[0][0]).toMatchObject({ status: 'ok' })
    expect(emit.mock.calls[0][0].report!.totals.billedAmount).toBe(8)
    expect(s.getLatest()!.totals.billedAmount).toBe(8)
    expect(s.getStatus()).toBe('ok')
    s.dispose()
  })

  it('emits no-auth (with a null report) when no profile resolves and nothing is cached', async () => {
    const resolve = vi.fn(async () => null)
    const { deps, emit } = makeDeps({ resolve })
    const s = new AiUsageScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(emit).toHaveBeenCalledWith({ report: null, status: 'no-auth' })
    expect(s.getStatus()).toBe('no-auth')
    s.dispose()
  })

  it('emits scope-missing (preserving the prior report) on a blocked refresh', async () => {
    let firstCall = true
    const fetchImpl = vi.fn(async () => {
      if (firstCall) {
        firstCall = false
        return makeResp(AI_CREDIT_BILLED)
      }
      return makeResp({}, 404)
    }) as unknown as typeof fetch
    const { deps, emit } = makeDeps({ fetchImpl })
    const s = new AiUsageScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.getStatus()).toBe('ok')
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.getStatus()).toBe('scope-missing')
    // The cached report survives the blocked refresh; status updates anyway.
    expect(s.getLatest()!.totals.billedAmount).toBe(8)
    expect(emit).toHaveBeenLastCalledWith({
      report: expect.objectContaining({ source: 'ai_credit' }),
      status: 'scope-missing',
    })
    s.dispose()
  })

  it('resets status to pending while disabled', async () => {
    const { deps } = makeDeps({ isEnabled: () => false })
    const s = new AiUsageScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.getStatus()).toBe('pending')
    s.dispose()
  })

  it('polls again after the refresh interval elapses', async () => {
    const { deps, fetchImpl } = makeDeps()
    const s = new AiUsageScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    s.dispose()
  })

  it('stop() halts the loop; no further polls fire', async () => {
    const { deps, fetchImpl } = makeDeps()
    const s = new AiUsageScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    s.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    s.dispose()
  })

  it('preserves the prior report when a refresh returns null', async () => {
    let firstCall = true
    const fetchImpl = vi.fn(async () => {
      if (firstCall) {
        firstCall = false
        return makeResp(AI_CREDIT_BILLED)
      }
      return makeResp({}, 404)
    }) as unknown as typeof fetch
    const { deps } = makeDeps({ fetchImpl })
    const s = new AiUsageScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.getLatest()!.totals.billedAmount).toBe(8)
    await vi.advanceTimersByTimeAsync(1000)
    // second poll 404'd on both endpoints -> null -> prior report preserved
    expect(s.getLatest()!.totals.billedAmount).toBe(8)
    s.dispose()
  })

  it('does not clobber a cached report when no auth profile resolves on a later tick', async () => {
    let firstCall = true
    const fetchImpl = vi.fn(async () => makeResp(AI_CREDIT_BILLED)) as unknown as typeof fetch
    const resolve = vi.fn(async () => {
      if (firstCall) {
        firstCall = false
        return { login: 'octocat', tokenFn }
      }
      return null
    })
    const { deps } = makeDeps({ resolve, fetchImpl })
    const s = new AiUsageScheduler(deps)
    s.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(s.getLatest()!.totals.billedAmount).toBe(8)
    // Next tick: resolve() yields null, but the good report must survive.
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.getLatest()!.totals.billedAmount).toBe(8)
    s.dispose()
  })
})
