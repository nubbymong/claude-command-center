/**
 * tk-pricing.ts — Unified pricing map for the tokenomics indexer.
 *
 * Exports:
 *  - registryFallbackPricing(): registry-derived Claude pricing (per 1M tokens)
 *  - fetchModelPricing(): fetches/caches live pricing from LiteLLM
 *  - getPricing(model): resolves per-model pricing at runtime
 *  - getPricingWithSource(model): resolves pricing with a source tag
 *  - normalizeModelForPricing(model, keys): longest-prefix key match
 *  - getAllPricing(): merged Claude + Codex map for query-time cost CTE
 */

import * as fs from 'fs'
import * as path from 'path'
import { getConfigDir, ensureConfigDir } from '../config-manager'
import { logInfo } from '../debug-logger'
import {
  codexPricingKeys, priceForModel, codexCachedInputPer1M,
  parseLiteLlmOpenAiPricing, parseCachedCodexPricing, serializeCodexPricing, setLiveCodexPricing,
} from '../providers/codex/pricing'
import { getRegistry } from '../model-registry-service'
import type { TkPricing } from './tk-types'

// ── Types ──

export interface ModelPricing {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type PricingSource = 'live' | 'fallback' | 'prefix' | 'guess'

// ── Registry-derived fallback pricing (per 1M tokens) ──
// Replaces the old hardcoded FALLBACK_PRICING literal. Derived from the
// model registry so that overlay additions (e.g. Sentinel-proposed entries)
// automatically flow into tokenomics without a code change.

/** Registry-derived replacement for the old FALLBACK_PRICING literal. Keyed by entry id. */
export function registryFallbackPricing(): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {}
  for (const m of getRegistry().models) {
    if (m.fallbackPricing) out[m.id] = m.fallbackPricing
  }
  return out
}

// ── Dynamic pricing from LiteLLM (static JSON of model prices, cached 24h) ──

let livePricing: Record<string, ModelPricing> | null = null

/** P3.8 (row 28): where the OpenAI part of the same list is saved, for Codex
 *  (providers/codex/pricing.ts), beside Claude's model-pricing.json. */
const OPENAI_CACHE_FILE = 'openai-model-pricing.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** The saved OpenAI prices, when saved within the TTL: handed to the Codex
 *  pricing, checked entry by entry. True when they were fresh. */
function loadFreshOpenAiCache(): boolean {
  try {
    const cachePath = path.join(getConfigDir(), OPENAI_CACHE_FILE)
    if (!fs.existsSync(cachePath) || Date.now() - fs.statSync(cachePath).mtimeMs >= CACHE_TTL_MS) return false
    const saved = parseCachedCodexPricing(JSON.parse(fs.readFileSync(cachePath, 'utf-8')))
    setLiveCodexPricing(saved)
    logInfo(`[tokenomics] Loaded cached OpenAI model pricing (${saved.size} models)`)
    return true
  } catch { return false /* cache miss */ }
}

/** Fetch Claude and OpenAI (Codex) model pricing from LiteLLM's open pricing
 *  dataset (static JSON only). One request prices both (P3.8, row 28). */
export async function fetchModelPricing(): Promise<void> {
  // Check disk caches first (24h TTL). Both fresh: no request. Claude's alone
  // (a build before P3.8 wrote it): fetch, so Codex gets live prices too.
  let claudeFresh = false
  try {
    const cachePath = path.join(getConfigDir(), 'model-pricing.json')
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath)
      if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
        livePricing = JSON.parse(fs.readFileSync(cachePath, 'utf-8'))
        logInfo(`[tokenomics] Loaded cached model pricing (${Object.keys(livePricing!).length} models)`)
        claudeFresh = true
      }
    }
  } catch { /* cache miss */ }
  const openAiFresh = loadFreshOpenAiCache()
  if (claudeFresh && openAiFresh) return

  try {
    const https = await import('https')
    const body: string = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'raw.githubusercontent.com',
        path: '/BerriAI/litellm/main/model_prices_and_context_window.json',
        method: 'GET',
        timeout: 10000
      }, (res) => {
        let d = ''
        res.on('data', (c: string) => { d += c })
        res.on('end', () => resolve(d))
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
      req.end()
    })

    const allModels = JSON.parse(body)
    const pricing: Record<string, ModelPricing> = {}

    for (const [key, val] of Object.entries(allModels) as [string, any][]) {
      if (!key.includes('claude')) continue
      const modelName = key.replace(/^[^/]+\//, '') // strip provider prefix
      if (pricing[modelName]) continue

      const inp = (val.input_cost_per_token || 0) * 1_000_000
      const out = (val.output_cost_per_token || 0) * 1_000_000
      const cr = (val.cache_read_input_token_cost || 0) * 1_000_000
      const cw = (val.cache_creation_input_token_cost || 0) * 1_000_000

      if (inp > 0 || out > 0) {
        pricing[modelName] = {
          input: inp, output: out,
          cacheRead: cr || inp * 0.1,
          cacheWrite: cw || inp * 1.25,
        }
      }
    }

    if (Object.keys(pricing).length > 0) {
      livePricing = pricing
      try {
        ensureConfigDir()
        fs.writeFileSync(path.join(getConfigDir(), 'model-pricing.json'), JSON.stringify(pricing, null, 2))
      } catch { /* ignore */ }
      logInfo(`[tokenomics] Fetched pricing for ${Object.keys(pricing).length} Claude models`)
    }

    // P3.8 (row 28): the OpenAI part, for Codex, taken only as checked prices.
    const openAi = parseLiteLlmOpenAiPricing(allModels)
    if (openAi.size > 0) {
      setLiveCodexPricing(openAi)
      try {
        ensureConfigDir()
        fs.writeFileSync(path.join(getConfigDir(), OPENAI_CACHE_FILE), JSON.stringify(serializeCodexPricing(openAi), null, 2))
      } catch { /* ignore */ }
      logInfo(`[tokenomics] Fetched pricing for ${openAi.size} OpenAI models`)
    }
  } catch (err: any) {
    logInfo(`[tokenomics] Pricing fetch failed (using hardcoded): ${err?.message}`)
  }
}

// Safe terminal default for the guess branch: sonnet-tier rates. Literal, not a
// registry lookup, so a future baseline rename can never make costs NaN.
const GUESS_DEFAULT: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

const guessedModels = new Set<string>()

export function getPricingWithSource(model: string): { pricing: ModelPricing; source: PricingSource } {
  const fallback = registryFallbackPricing()
  const sources: Array<[Record<string, ModelPricing>, PricingSource]> =
    livePricing ? [[livePricing, 'live'], [fallback, 'fallback']] : [[fallback, 'fallback']]
  for (const [db, src] of sources) {
    if (db[model]) return { pricing: db[model], source: src }
    // LONGEST base wins, not the first one that happens to match. Keys collapse
    // to a base by dropping the trailing version (`claude-opus-4-8` ->
    // `claude-opus`), so a short generic base can shadow a specific one purely
    // by sitting earlier in the registry: `claude-opus-5` collapses to
    // `claude-opus`, which prefixes `claude-opus-4-8-fast-20260601` and would
    // have priced a Fast model at standard Opus rates. Registry order is a UI
    // concern now (#385) and must not move prices.
    let bestKey: string | null = null
    let bestBase = ''
    for (const key of Object.keys(db)) {
      const base = key.replace(/-\d+[-\d]*$/, '')
      if (model.startsWith(base) && base.length > bestBase.length) { bestBase = base; bestKey = key }
    }
    if (bestKey) return { pricing: db[bestKey], source: 'prefix' }
  }
  // Novel family: WARN + guess (spec §4) — same terminal numbers as before
  // (sonnet rates) so totals don't shift, but tagged + logged, never silent.
  if (!guessedModels.has(model)) {
    guessedModels.add(model)
    logInfo(`[tokenomics] no pricing for "${model}" — using guess (sonnet rates); Sentinel will propose a registry entry`)
  }
  return { pricing: fallback['claude-sonnet-4-6'] ?? GUESS_DEFAULT, source: 'guess' }
}

export function getPricing(model: string): ModelPricing { return getPricingWithSource(model).pricing }

// ── normalizeModelForPricing ──

/**
 * Maps a raw model name (possibly with a date suffix like `-20260101`) to the
 * longest matching canonical pricing key. Returns the raw model name unchanged
 * when no key matches.
 */
export function normalizeModelForPricing(model: string, keys: string[]): string {
  if (keys.includes(model)) return model
  let best = ''
  for (const k of keys) {
    if (model.startsWith(k) && k.length > best.length) best = k
  }
  return best || model
}

// ── getAllPricing — merged Claude + Codex map ──

/**
 * Returns a complete Record<priceModelKey, TkPricing> merging:
 *  - Claude: registryFallbackPricing() overridden by livePricing (if fetched)
 *  - Codex: every priced Codex model, its live price over the static table
 *    (P3.8), mapped to TkPricing (cacheWrite=0)
 *
 * Used by the indexer worker to build a pricing CTE for query-time cost
 * computation without shipping the full session corpus to the renderer.
 */
export function getAllPricing(): Record<string, TkPricing> {
  const out: Record<string, TkPricing> = {}

  // Claude entries: live pricing takes precedence over fallback
  const claude = { ...registryFallbackPricing(), ...(livePricing ?? {}) }
  for (const [k, v] of Object.entries(claude)) {
    out[k] = { input: v.input, output: v.output, cacheRead: v.cacheRead, cacheWrite: v.cacheWrite }
  }

  // Codex entries: the live list's and the table's, each at the price the
  // session strip uses (priceForModel), mapped to TkPricing (cacheWrite always 0)
  for (const key of codexPricingKeys()) {
    const p = priceForModel(key)
    if (!p) continue
    out[key] = {
      input: p.inputPer1M,
      output: p.outputPer1M,
      // MP11: no cached tier costs the full input rate, as in the strip.
      cacheRead: codexCachedInputPer1M(p),
      cacheWrite: 0,
    }
  }

  return out
}
