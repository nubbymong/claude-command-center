// P3.8 (row 28): the one LiteLLM fetch that prices Claude also prices Codex,
// as Claude's prices are live with a fallback: the OpenAI part is taken
// (checked), kept in memory, saved beside Claude's for 24 hours and read back
// checked; the session strip and Tokenomics then price a Codex turn alike from
// it, the static table pricing what it lacks. The request and the config folder
// are faked: nothing leaves the machine and nothing is written outside a temp
// folder this test makes and removes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const env = vi.hoisted(() => ({ dir: '', requests: 0, body: '' as string, fail: false }))

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
      queueMicrotask(() => {
        if (env.fail) { req.emit('error', new Error('offline')); return }
        const res = new EventEmitter()
        cb(res)
        res.emit('data', env.body)
        res.emit('end')
      })
    }
    return req
  }
  return { request, default: { request } }
})

const per = (usdPer1M: number) => usdPer1M / 1e6
const BODY = JSON.stringify({
  'claude-opus-5': { input_cost_per_token: per(5), output_cost_per_token: per(25), cache_read_input_token_cost: per(0.5), cache_creation_input_token_cost: per(6.25), litellm_provider: 'anthropic', mode: 'chat' },
  'gpt-5.5': { input_cost_per_token: per(4), output_cost_per_token: per(20), cache_read_input_token_cost: per(0.4), litellm_provider: 'openai', mode: 'chat' },
  'gpt-6-astra': { input_cost_per_token: per(10), output_cost_per_token: per(60), litellm_provider: 'openai', mode: 'responses' },
  'azure/gpt-5.2': { input_cost_per_token: per(1), output_cost_per_token: per(1), litellm_provider: 'azure', mode: 'chat' },
})

async function load() {
  vi.resetModules()
  const tk = await import('../../../src/main/tokenomics/tk-pricing')
  const cx = await import('../../../src/main/providers/codex/pricing')
  // Tokenomics reads Codex's prices through the registered package (WP2 PR 4).
  const { registerProviderPackage } = await import('../../../src/main/providers/core')
  const { createCodexPackage } = await import('../../../src/main/providers/codex')
  registerProviderPackage(createCodexPackage())
  return { tk, cx }
}

beforeEach(() => {
  env.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-p38-pricing-'))
  env.requests = 0
  env.body = BODY
  env.fail = false
})
afterEach(() => {
  // Only the folder this test made: its own prefix, directly in the temp folder.
  if (path.basename(env.dir).startsWith('ccc-p38-pricing-') && path.dirname(env.dir) === os.tmpdir()) {
    fs.rmSync(env.dir, { recursive: true, force: true })
  }
})

describe('live Codex prices from the LiteLLM fetch', () => {
  it('prices Codex from the fetch, the live price over the table, and a live-only model too', async () => {
    const { tk, cx } = await load()
    await tk.fetchModelPricing()
    expect(env.requests).toBe(1)
    expect(cx.priceForModel('gpt-5.5')).toEqual({ inputPer1M: 4, cachedInputPer1M: 0.4, outputPer1M: 20 })
    expect(cx.priceForModel('gpt-6-astra')).toEqual({ inputPer1M: 10, cachedInputPer1M: null, outputPer1M: 60 })
    expect(cx.priceForModel('gpt-5.3-codex')!.inputPer1M).toBe(1.75)
    expect(cx.priceForModel('gpt-5.2')).toBeNull()
    const all = tk.getAllPricing()
    expect(all['gpt-6-astra']).toEqual({ input: 10, output: 60, cacheRead: 10, cacheWrite: 0 })
    expect(all['gpt-5.5']).toEqual({ input: 4, output: 20, cacheRead: 0.4, cacheWrite: 0 })
    expect(all['claude-opus-5'].input).toBeCloseTo(5, 9)
  })

  it('Tokenomics prices a Codex turn exactly as the session strip does, live prices included', async () => {
    const { tk, cx } = await load()
    await tk.fetchModelPricing()
    const all = tk.getAllPricing()
    for (const k of cx.codexPricingKeys()) {
      const p = all[k]
      const tokenomics = (600 * p.input + 400 * p.cacheRead + 50 * p.output) / 1e6
      expect(tokenomics, k).toBeCloseTo(cx.computeCodexCostUsd(k, { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 })!, 12)
    }
  })

  it('saves the live Codex prices and, within a day, reads them back instead of fetching', async () => {
    let { tk } = await load()
    await tk.fetchModelPricing()
    expect(fs.existsSync(path.join(env.dir, 'openai-model-pricing.json'))).toBe(true)
    expect(env.requests).toBe(1)
    const loaded = await load()
    tk = loaded.tk
    await tk.fetchModelPricing()
    expect(env.requests).toBe(1)
    expect(loaded.cx.priceForModel('gpt-6-astra')!.outputPer1M).toBe(60)
  })

  it('a saved entry that is not a usable price is dropped on read', async () => {
    fs.writeFileSync(path.join(env.dir, 'model-pricing.json'), JSON.stringify({ 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }))
    fs.writeFileSync(path.join(env.dir, 'openai-model-pricing.json'), JSON.stringify({ models: {
      'gpt-6-astra': { inputPer1M: 10, cachedInputPer1M: null, outputPer1M: 60 },
      'gpt-5.5': { inputPer1M: 'free', cachedInputPer1M: null, outputPer1M: 60 },
    } }))
    const { tk, cx } = await load()
    await tk.fetchModelPricing()
    expect(env.requests).toBe(0)
    expect(cx.priceForModel('gpt-6-astra')!.inputPer1M).toBe(10)
    expect(cx.priceForModel('gpt-5.5')).toEqual({ inputPer1M: 5, cachedInputPer1M: 1.25, outputPer1M: 30 })
  })

  it('a saved Claude copy alone (an older build wrote it) still fetches, so Codex gets live prices', async () => {
    fs.writeFileSync(path.join(env.dir, 'model-pricing.json'), JSON.stringify({ 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }))
    const { tk, cx } = await load()
    await tk.fetchModelPricing()
    expect(env.requests).toBe(1)
    expect(cx.priceForModel('gpt-6-astra')).not.toBeNull()
  })

  it('a saved OpenAI copy older than a day is not used: the list is fetched again', async () => {
    const claudeCache = path.join(env.dir, 'model-pricing.json')
    const openAiCache = path.join(env.dir, 'openai-model-pricing.json')
    fs.writeFileSync(claudeCache, JSON.stringify({ 'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }))
    fs.writeFileSync(openAiCache, JSON.stringify({ models: { 'gpt-old': { inputPer1M: 1, cachedInputPer1M: null, outputPer1M: 1 } } }))
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    fs.utimesSync(openAiCache, old, old)
    const { tk, cx } = await load()
    await tk.fetchModelPricing()
    expect(env.requests).toBe(1)
    expect(cx.priceForModel('gpt-old')).toBeNull()
    expect(cx.priceForModel('gpt-6-astra')).not.toBeNull()
  })

  it('offline: nothing throws and Codex is priced from the table, anything else no price', async () => {
    env.fail = true
    const { tk, cx } = await load()
    await expect(tk.fetchModelPricing()).resolves.toBeUndefined()
    expect(cx.priceForModel('gpt-5.5')).toEqual({ inputPer1M: 5, cachedInputPer1M: 1.25, outputPer1M: 30 })
    expect(cx.priceForModel('gpt-6-astra')).toBeNull()
    expect(fs.existsSync(path.join(env.dir, 'openai-model-pricing.json'))).toBe(false)
  })
})
