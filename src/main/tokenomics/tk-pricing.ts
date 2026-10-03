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
import * as https from 'https'
import * as path from 'path'
import { getConfigDir, ensureConfigDir } from '../config-manager'
import { logInfo } from '../debug-logger'
import {
  codexPricingKeys, priceForModel, codexCachedInputPer1M,
  parseLiteLlmOpenAiPricing, parseCachedCodexPricing, serializeCodexPricing, setLiveCodexPricing,
} from '../providers/codex/pricing'
import { isPlainPriceId, checkedPer1M, listPricePer1M, isFreshCopy, isPriceRecord } from './price-checks'
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
const CLAUDE_CACHE_FILE = 'model-pricing.json'

/**
 * The Claude models of a LiteLLM price list, per 1M tokens, read through the
 * checks both providers' prices pass (price-checks.ts). The rule is the one
 * the fetch always used: every key naming claude, one provider prefix
 * stripped, the first spelling kept, cache rates defaulting to a tenth and
 * five quarters of the input rate, and an entry with neither an input nor an
 * output price left out; valid entries price exactly as before. An entry that
 * is not a record, a price present but not a usable number, or an id that is
 * not plain text is left out.
 */
export function parseLiteLlmClaudePricing(all: unknown): Record<string, ModelPricing> {
  const pricing: Record<string, ModelPricing> = {}
  if (!isPriceRecord(all)) return pricing
  for (const key of Object.keys(all)) {
    if (!key.includes('claude')) continue
    const modelName = key.replace(/^[^/]+\//, '') // strip provider prefix
    if (!isPlainPriceId(modelName) || Object.prototype.hasOwnProperty.call(pricing, modelName)) continue
    const val = all[key]
    if (!isPriceRecord(val)) continue
    const inp = listPricePer1M(val.input_cost_per_token)
    const out = listPricePer1M(val.output_cost_per_token)
    const cr = listPricePer1M(val.cache_read_input_token_cost)
    const cw = listPricePer1M(val.cache_creation_input_token_cost)
    if (inp === null || out === null || cr === null || cw === null) continue
    const input = inp ?? 0
    const output = out ?? 0
    if (input > 0 || output > 0) {
      pricing[modelName] = { input, output, cacheRead: cr || input * 0.1, cacheWrite: cw || input * 1.25 }
    }
  }
  return pricing
}

/** The saved Claude prices read back through the same checks: an entry that
 *  is not four usable prices, has neither an input nor an output price, or
 *  whose id is not plain text is dropped. */
export function parseCachedClaudePricing(saved: unknown): Record<string, ModelPricing> {
  const out: Record<string, ModelPricing> = {}
  if (!isPriceRecord(saved)) return out
  for (const id of Object.keys(saved)) {
    const p = saved[id]
    if (!isPlainPriceId(id) || !isPriceRecord(p)) continue
    const input = checkedPer1M(p.input)
    const output = checkedPer1M(p.output)
    const cacheRead = checkedPer1M(p.cacheRead)
    const cacheWrite = checkedPer1M(p.cacheWrite)
    if (input === null || output === null || cacheRead === null || cacheWrite === null) continue
    if (input === 0 && output === 0) continue
    out[id] = { input, output, cacheRead, cacheWrite }
  }
  return out
}

/** A saved copy's text when it was written within the TTL (and not in the
 *  future), else null. */
function freshCopy(file: string): string | null {
  const cachePath = path.join(getConfigDir(), file)
  if (!fs.existsSync(cachePath) || !isFreshCopy(fs.statSync(cachePath).mtimeMs, Date.now())) return null
  return fs.readFileSync(cachePath, 'utf-8')
}

function saveCopy(file: string, value: unknown): void {
  try {
    ensureConfigDir()
    fs.writeFileSync(path.join(getConfigDir(), file), JSON.stringify(value, null, 2))
  } catch { /* ignore */ }
}

/** The fetch in flight, shared by every call made while it runs (the app
 *  asks at start from more than one place). */
let inFlight: Promise<void> | null = null

/** Fetch Claude and OpenAI (Codex) model pricing from LiteLLM's open pricing
 *  dataset (static JSON only). One request prices both (P3.8, row 28); calls
 *  made while one runs share it. */
export function fetchModelPricing(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = fetchModelPricingOnce().finally(() => { inFlight = null })
  return inFlight
}

async function fetchModelPricingOnce(): Promise<void> {
  // Check disk caches first (24h TTL). Both fresh: no request. Claude's alone
  // (a build before P3.8 wrote it): fetch, so Codex gets live prices too.
  let claudeFresh = false
  try {
    const text = freshCopy(CLAUDE_CACHE_FILE)
    if (text !== null) {
      livePricing = parseCachedClaudePricing(JSON.parse(text))
      logInfo(`[tokenomics] Loaded cached model pricing (${Object.keys(livePricing).length} models)`)
      claudeFresh = true
    }
  } catch { /* cache miss */ }
  let openAiFresh = false
  try {
    const text = freshCopy(OPENAI_CACHE_FILE)
    if (text !== null) {
      const saved = parseCachedCodexPricing(JSON.parse(text))
      setLiveCodexPricing(saved)
      logInfo(`[tokenomics] Loaded cached OpenAI model pricing (${saved.size} models)`)
      openAiFresh = true
    }
  } catch { /* cache miss */ }
  if (claudeFresh && openAiFresh) return

  let allModels: unknown
  try {
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

    allModels = JSON.parse(body)
  } catch (err: any) {
    logInfo(`[tokenomics] Pricing fetch failed (using hardcoded): ${err?.message}`)
    return
  }

  // Each half is read on its own: an entry one half cannot use never costs
  // the other its prices.
  try {
    const pricing = parseLiteLlmClaudePricing(allModels)
    if (Object.keys(pricing).length > 0) {
      livePricing = pricing
      saveCopy(CLAUDE_CACHE_FILE, pricing)
      logInfo(`[tokenomics] Fetched pricing for ${Object.keys(pricing).length} Claude models`)
    }
  } catch (err: any) {
    logInfo(`[tokenomics] Claude pricing not read: ${err?.message}`)
  }
  // P3.8 (row 28): the OpenAI part, for Codex, taken only as checked prices.
  // Saved even when it holds none, so the day's window holds and the list is
  // not fetched again on every call.
  try {
    const openAi = parseLiteLlmOpenAiPricing(allModels)
    setLiveCodexPricing(openAi)
    saveCopy(OPENAI_CACHE_FILE, serializeCodexPricing(openAi))
    logInfo(`[tokenomics] Fetched pricing for ${openAi.size} OpenAI models`)
  } catch (err: any) {
    logInfo(`[tokenomics] OpenAI pricing not read: ${err?.message}`)
  }
}

// Safe terminal default for the guess branch: sonnet-tier rates. Literal, not a
// registry lookup, so a future baseline rename can never make costs NaN.
const GUESS_DEFAULT: ModelPricing = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

const guessedModels = new Set<string>()

/**
 * The key whose price a model id with no key of its own takes.
 *
 * 1. The longest key that is the model's own id with something after it (a
 *    date, `claude-opus-4-5-20251101`, or a variant, `claude-opus-4-8-fast-...`),
 *    never a longer number (`claude-opus-4-8` does not price `claude-opus-4-80`).
 *    Version-faithful, so a sibling's price or the registry's order cannot move
 *    it: since Opus 5.5 and Sonnet 5.5 cost less than the versions before them,
 *    a collapsed family base alone would price a dated Opus 4.5 at Opus 5.5's
 *    rate (P4.11).
 * 2. Else the LONGEST base wins, not the first one that happens to match. Keys
 *    collapse to a base by dropping the trailing version (`claude-opus-4-8` ->
 *    `claude-opus`), so a short generic base can shadow a specific one purely
 *    by sitting earlier in the registry. Registry order is a UI concern (#385):
 *    it decides only which member of a family prices a version no key knows (the
 *    registry lists each family newest first, so the newest).
 */
export function prefixPricingKey(keys: readonly string[], model: string): string | null {
  let own: string | null = null
  for (const key of keys) {
    if (key.length < model.length && model.startsWith(key) && !/\d/.test(model.charAt(key.length)) && (!own || key.length > own.length)) own = key
  }
  if (own) return own
  let bestKey: string | null = null
  let bestBase = ''
  for (const key of keys) {
    const base = key.replace(/-\d+[-\d]*$/, '')
    if (model.startsWith(base) && base.length > bestBase.length) { bestBase = base; bestKey = key }
  }
  return bestKey
}

export function getPricingWithSource(model: string): { pricing: ModelPricing; source: PricingSource } {
  const fallback = registryFallbackPricing()
  const sources: Array<[Record<string, ModelPricing>, PricingSource]> =
    livePricing ? [[livePricing, 'live'], [fallback, 'fallback']] : [[fallback, 'fallback']]
  for (const [db, src] of sources) {
    if (db[model]) return { pricing: db[model], source: src }
    const key = prefixPricingKey(Object.keys(db), model)
    if (key) return { pricing: db[key], source: 'prefix' }
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
    // A Claude model's price is Claude's: a Codex entry of the same name
    // never replaces it.
    if (Object.prototype.hasOwnProperty.call(out, key)) continue
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
