// P3.8 round 1 (P1, P2, P3): both providers' prices from the LiteLLM list, and
// both saved copies, are read through the same checks (finite, bounded,
// non-negative prices; a plain model id); valid Claude data prices exactly as
// before. The two halves are read independently, an empty OpenAI result is
// recorded so the day's window holds, a saved copy dated in the future is
// stale, calls made together share one request, and a Codex price never
// replaces a Claude one. The request and the config folder are faked: nothing
// leaves the machine and nothing is written outside a temp folder this test
// makes and removes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const env = vi.hoisted(() => ({ dir: '', requests: 0, body: '' as string, fail: false, hold: null as null | Promise<void> }))

vi.mock('../../../src/main/config-manager', () => ({
  getConfigDir: () => env.dir,
  ensureConfigDir: () => {},
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {} }))
vi.mock('https', () => {
  const request = (_opts: unknown, cb: (res: EventEmitter) => void) => {
    env.requests++
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void }
    req.destroy = () => {}
    req.end = () => {
      void (async () => {
        if (env.hold) await env.hold
        if (env.fail) { req.emit('error', new Error('offline')); return }
        const res = new EventEmitter()
        cb(res)
        res.emit('data', env.body)
        res.emit('end')
      })()
    }
    return req
  }
  return { request, default: { request } }
})

const per = (usdPer1M: number) => usdPer1M / 1e6
const claude = (i: number, o: number, extra: Record<string, unknown> = {}) => ({ input_cost_per_token: per(i), output_cost_per_token: per(o), litellm_provider: 'anthropic', mode: 'chat', ...extra })
const openai = (i: number, o: number, extra: Record<string, unknown> = {}) => ({ input_cost_per_token: per(i), output_cost_per_token: per(o), litellm_provider: 'openai', mode: 'chat', ...extra })

/** The Claude half of the list exactly as the fetch read it before P3.8: the
 *  reference a valid list must still price the same against. */
function preP38Claude(allModels: Record<string, any>) {
  const pricing: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {}
  for (const [key, val] of Object.entries(allModels)) {
    if (!key.includes('claude')) continue
    const modelName = key.replace(/^[^/]+\//, '')
    if (pricing[modelName]) continue
    const inp = (val.input_cost_per_token || 0) * 1_000_000
    const out = (val.output_cost_per_token || 0) * 1_000_000
    const cr = (val.cache_read_input_token_cost || 0) * 1_000_000
    const cw = (val.cache_creation_input_token_cost || 0) * 1_000_000
    if (inp > 0 || out > 0) pricing[modelName] = { input: inp, output: out, cacheRead: cr || inp * 0.1, cacheWrite: cw || inp * 1.25 }
  }
  return pricing
}

/** A realistic valid list: bare, provider-prefixed, dated, Bedrock and Vertex
 *  spellings, missing cache fields, a zero cache rate, a first-wins repeat. */
const VALID: Record<string, unknown> = {
  'claude-opus-5': claude(5, 25, { cache_read_input_token_cost: per(0.5), cache_creation_input_token_cost: per(6.25) }),
  'anthropic/claude-sonnet-5': claude(3, 15),
  'claude-sonnet-5': claude(9, 9),
  'claude-haiku-4-5-20251001': claude(1, 5, { cache_read_input_token_cost: 0 }),
  'anthropic.claude-opus-4-8-v1:0': claude(5, 25),
  'vertex_ai/claude-opus-4-6@20250514': claude(5, 25),
  'bedrock/us-east-1/anthropic.claude-3-haiku': claude(0.25, 1.25),
  'claude-free-tier': claude(0, 0),
  'claude-output-only': { output_cost_per_token: per(4), litellm_provider: 'anthropic', mode: 'chat' },
  'gpt-6-astra': openai(10, 60),
}

async function load() {
  vi.resetModules()
  const tk = await import('../../../src/main/tokenomics/tk-pricing')
  const cx = await import('../../../src/main/providers/codex/pricing')
  return { tk, cx }
}

beforeEach(() => {
  env.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-p38-pricechecks-'))
  env.requests = 0
  env.body = JSON.stringify(VALID)
  env.fail = false
  env.hold = null
})
afterEach(() => {
  // Only the folder this test made: its own prefix, directly in the temp folder.
  if (path.basename(env.dir).startsWith('ccc-p38-pricechecks-') && path.dirname(env.dir) === os.tmpdir()) {
    fs.rmSync(env.dir, { recursive: true, force: true })
  }
})

describe('the Claude half through the shared checks (P3)', () => {
  it('a valid list prices every Claude model exactly as before', async () => {
    const { tk } = await load()
    expect(tk.parseLiteLlmClaudePricing(VALID)).toEqual(preP38Claude(VALID))
  })

  it('an entry that is not a usable price is left out, the rest kept', async () => {
    const { tk } = await load()
    const bad = {
      'claude-opus-5': claude(5, 25),
      'claude-null': null,
      'claude-array': [1],
      'claude-inf': { input_cost_per_token: Infinity, output_cost_per_token: per(1) },
      'claude-neg': { input_cost_per_token: -0.5, output_cost_per_token: per(10) },
      'claude-string': { input_cost_per_token: '0.000005', output_cost_per_token: per(10) },
      'claude-huge': { input_cost_per_token: 1, output_cost_per_token: per(1) },
      'claude-badcache': claude(2, 8, { cache_read_input_token_cost: 'x' }),
      'claude space': claude(1, 1),
    }
    expect(Object.keys(tk.parseLiteLlmClaudePricing(bad))).toEqual(['claude-opus-5'])
    for (const junk of [null, 'x', 42, [], [bad]]) expect(tk.parseLiteLlmClaudePricing(junk)).toEqual({})
  })

  it('the saved Claude copy is read back through the same checks', async () => {
    const { tk } = await load()
    const saved = {
      'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      'claude-junk': 'junk',
      'claude-x': { input: 'x', output: 1, cacheRead: 0, cacheWrite: 0 },
      'claude-zero': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      'claude-neg': { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 },
      'bad id': { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }
    expect(tk.parseCachedClaudePricing(saved)).toEqual({ 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } })
    for (const junk of [null, 'x', []]) expect(tk.parseCachedClaudePricing(junk)).toEqual({})
  })
})

describe('the fetch reads each half on its own (P2) and keeps its window (P1, P2)', () => {
  it('a broken Claude entry does not cost Codex its live prices', async () => {
    env.body = JSON.stringify({ 'gpt-6-astra': openai(10, 60), 'claude-x-broken': null, 'claude-opus-5': claude(6, 30) })
    const { tk, cx } = await load()
    await tk.fetchModelPricing()
    expect(cx.priceForModel('gpt-6-astra')).toEqual({ inputPer1M: 10, cachedInputPer1M: null, outputPer1M: 60 })
    // The live price (6 / 30), not the registry's (5 / 25): Tokenomics' own map.
    expect(tk.getAllPricing()['claude-opus-5']).toMatchObject({ input: 6, output: 30 })
  })

  it('a list with no usable OpenAI price is recorded, so a fresh day asks once, not on every call', async () => {
    env.body = JSON.stringify({ 'claude-opus-5': claude(5, 25), 'gpt-6-astra': openai(10, 60, { mode: 'completion' }) })
    const { tk } = await load()
    await tk.fetchModelPricing()
    await tk.fetchModelPricing()
    await tk.fetchModelPricing()
    expect(env.requests).toBe(1)
  })

  it('a saved copy dated in the future is stale: the list is fetched again', async () => {
    const cp = path.join(env.dir, 'model-pricing.json')
    const op = path.join(env.dir, 'openai-model-pricing.json')
    fs.writeFileSync(cp, JSON.stringify({ 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }))
    fs.writeFileSync(op, JSON.stringify({ models: { 'gpt-6-astra': { inputPer1M: 1, cachedInputPer1M: null, outputPer1M: 1 } } }))
    const future = new Date('2100-01-01')
    fs.utimesSync(cp, future, future)
    fs.utimesSync(op, future, future)
    const { tk, cx } = await load()
    await tk.fetchModelPricing()
    expect(env.requests).toBe(1)
    expect(cx.priceForModel('gpt-6-astra')!.outputPer1M).toBe(60)
  })

  it('a fresh saved Claude copy is read back through the checks at start, not taken as it is', async () => {
    fs.writeFileSync(path.join(env.dir, 'model-pricing.json'), JSON.stringify({
      'claude-opus-5': { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 },
      'claude-sonnet-9': { input: -1, output: 1, cacheRead: 0, cacheWrite: 0 },
    }))
    fs.writeFileSync(path.join(env.dir, 'openai-model-pricing.json'), JSON.stringify({ models: {} }))
    const { tk } = await load()
    await tk.fetchModelPricing()
    expect(env.requests).toBe(0)
    // The saved copy's price (6 / 30, not the registry's 5 / 25) is taken; the
    // entry that fails the checks never reaches Tokenomics' map.
    expect(tk.getAllPricing()['claude-opus-5']).toEqual({ input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 })
    expect(tk.getAllPricing()['claude-sonnet-9']).toBeUndefined()
  })

  it('a saved OpenAI entry with both prices zero is not a price', async () => {
    fs.writeFileSync(path.join(env.dir, 'model-pricing.json'), JSON.stringify({ 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }))
    fs.writeFileSync(path.join(env.dir, 'openai-model-pricing.json'), JSON.stringify({ models: { 'gpt-5.5': { inputPer1M: 0, cachedInputPer1M: null, outputPer1M: 0 } } }))
    const { tk, cx } = await load()
    await tk.fetchModelPricing()
    expect(env.requests).toBe(0)
    expect(cx.priceForModel('gpt-5.5')).toEqual({ inputPer1M: 5, cachedInputPer1M: 1.25, outputPer1M: 30 })
  })

  it('calls made together share one request', async () => {
    let release!: () => void
    env.hold = new Promise<void>((r) => { release = r })
    const { tk } = await load()
    // The request module loaded once up front, as in the app, so every call
    // below reaches the request rather than waiting on the first import.
    await import('https')
    const a = tk.fetchModelPricing()
    const b = tk.fetchModelPricing()
    const c = tk.fetchModelPricing()
    // Every call reaches its request while the first is still answering.
    await new Promise((r) => setTimeout(r, 50))
    release()
    await Promise.all([a, b, c])
    expect(env.requests).toBe(1)
  })

  it('a finished fetch is not kept: with still nothing fresh, the next call asks again', async () => {
    env.fail = true
    const { tk } = await load()
    await tk.fetchModelPricing()
    await tk.fetchModelPricing()
    expect(env.requests).toBe(2)
  })
})

describe('a Codex price never replaces a Claude one', () => {
  it('an OpenAI-listed entry named like a Claude model leaves the Claude price in Tokenomics', async () => {
    env.body = JSON.stringify({ 'anthropic/claude-sonnet-5': claude(3, 15), 'openai/claude-sonnet-5': openai(0.0001, 0.0001) })
    const { tk, cx } = await load()
    await tk.fetchModelPricing()
    expect(cx.priceForModel('claude-sonnet-5')).not.toBeNull()
    const p = tk.getAllPricing()['claude-sonnet-5']
    expect(p.input).toBeCloseTo(3, 9)
    expect(p.output).toBeCloseTo(15, 9)
    expect(p.cacheWrite).toBeCloseTo(3.75, 9)
  })
})
