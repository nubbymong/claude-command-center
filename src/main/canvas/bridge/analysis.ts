// The analysis chunk: axe-core, and nothing else.
//
// Bundled SEPARATELY from the bridge and served at CANVAS_ANALYSIS_PATH. The
// bridge pulls it in with a dynamic import() the first time a snapshot asks for
// issue analysis — no <script> injection, because the bridge does not mutate the
// page it is reporting on (D8).
//
// axe-core is MPL-2.0. It is used as a dependency and never forked; its licence
// header rides in the bundle (esbuild legalComments) and in THIRD-PARTY-NOTICES.

import axe from 'axe-core'

interface AxeInternals {
  commons?: { aria?: { getRole?: (el: Element, opts?: unknown) => string | null } }
}

export const version: string = axe.version

/**
 * Element → ARIA role via axe's HTML-AAM implementation.
 *
 * `axe.commons` is not part of axe's documented API surface, so every call is
 * feature-detected and failure falls back to the bridge's own table rather than
 * breaking the snapshot.
 */
export function getRole(el: Element): string | null {
  const fn = (axe as unknown as AxeInternals).commons?.aria?.getRole
  if (typeof fn !== 'function') return null
  try {
    return fn(el)
  } catch {
    return null
  }
}

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

export interface AxeRunResult {
  violations: AxeViolation[]
}

/**
 * Run a fixed rule set over `context` (the document, or the scoped elements).
 *
 * `elementRef` is what makes joining results back onto snapshot nodes exact —
 * without it the only handle is a CSS selector string, which has to be re-queried
 * and can miss. `iframes: false` keeps axe inside this document: nested frames
 * are the page's own business and injecting into them is a mutation.
 */
export async function run(context: unknown, rules: string[]): Promise<AxeRunResult> {
  const options = {
    elementRef: true,
    iframes: false,
    resultTypes: ['violations'],
    runOnly: { type: 'rule', values: rules },
  }
  const result = await axe.run(context as never, options as never)
  return result as unknown as AxeRunResult
}
