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

export const version: string = axe.version

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
  // A renamed or dropped rule id rejects the WHOLE run ("unknown rule ..."),
  // which would turn every snapshot into run-failed on a dependency bump.
  const available = new Set((axe.getRules() as Array<{ ruleId: string }>).map((r) => r.ruleId))
  const values = rules.filter((rule) => available.has(rule))
  const options = {
    elementRef: true,
    iframes: false,
    resultTypes: ['violations'],
    runOnly: { type: 'rule', values },
  }
  const result = await axe.run(context as never, options as never)
  return result as unknown as AxeRunResult
}
