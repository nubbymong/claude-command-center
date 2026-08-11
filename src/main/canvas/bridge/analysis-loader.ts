// Lazy loader for the axe-core chunk.
//
// The bridge is injected into EVERY document ccc-ux:// serves, so it stays lean;
// the rule engine is an order of magnitude bigger and is only worth its parse
// cost when a snapshot actually asks for issues. One dynamic import(), memoised,
// with a hard timeout so a wedged analysis can never hold a reply open.
//
// The API shape is declared here rather than imported from './analysis' so that
// no import edge — not even a type-only one that a refactor could widen — can
// pull axe-core into the lean bundle.

import { CANVAS_ANALYSIS_PATH } from '../../../shared/canvas'

export interface AxeCheckData {
  contrastRatio?: number
  expectedContrastRatio?: string
}

export interface AxeNodeResult {
  element?: Element
  target?: string[]
  impact?: string | null
  any?: Array<{ data?: AxeCheckData }>
  all?: Array<{ data?: AxeCheckData }>
}

export interface AxeViolation {
  id: string
  impact?: string | null
  nodes: AxeNodeResult[]
}

export interface AnalysisApi {
  version: string
  /** `incomplete` is as load-bearing as `violations`: it is where axe puts every
   *  contrast check it declined to decide, and the measurement pass keys its own
   *  coverage off it (see captureSnapshot). */
  run(context: unknown, rules: string[]): Promise<{ violations: AxeViolation[]; incomplete: AxeViolation[] }>
}

const LOAD_TIMEOUT_MS = 5_000
export const ANALYSIS_RUN_TIMEOUT_MS = 12_000

let pending: Promise<AnalysisApi> | null = null

function timeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/** Load (once) and hand back the analysis API. Rejects if the chunk is blocked
 *  — callers degrade to measurement-only rather than failing the snapshot. */
export function ensureAnalysis(): Promise<AnalysisApi> {
  if (pending) return pending
  // Held in a variable so the bundler leaves the import alone: this module is
  // resolved by the ccc-ux:// server at runtime, not at build time.
  const specifier = CANVAS_ANALYSIS_PATH
  pending = timeout(
    import(/* @vite-ignore */ specifier).then((mod: unknown) => {
      const api = mod as AnalysisApi
      if (!api || typeof api.run !== 'function') throw new Error('analysis chunk exposed no run()')
      return api
    }),
    LOAD_TIMEOUT_MS,
    'analysis chunk load timed out',
  ).catch((err) => {
    // A failed load must not poison every later snapshot.
    pending = null
    throw err
  })
  return pending
}

/** Test seam: drop the memoised chunk. */
export function resetAnalysis(): void {
  pending = null
}

export function withRunTimeout<T>(promise: Promise<T>): Promise<T> {
  return timeout(promise, ANALYSIS_RUN_TIMEOUT_MS, 'analysis run timed out')
}
