// The analysis chunk: axe-core, and nothing else.
//
// Bundled SEPARATELY from the bridge and served at CANVAS_ANALYSIS_PATH. The
// bridge pulls it in with a dynamic import() the first time a snapshot asks for
// issue analysis — no <script> injection, because the bridge does not mutate the
// page it is reporting on (D8).
//
// axe-core is MPL-2.0. It is used as a dependency and never forked; its licence
// header rides in the served bundle (esbuild legalComments) and in NOTICE.

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
  /**
   * Rules axe EVALUATED but could not decide — neither pass nor fail.
   *
   * This is not an edge case for `color-contrast`: axe routes to `incomplete`
   * whenever the foreground has alpha, the text overlaps other content, it comes
   * from pseudo-content, the font is an icon font, or the background is an
   * image. Discarding it, while the measurement pass simultaneously stood down
   * because "axe ran", left those nodes checked by NOBODY on the only path
   * production takes — and the capture note still claimed contrast applied.
   */
  incomplete: AxeViolation[]
}

// axe publishes itself onto `window` when it loads, and that global IS the object
// this module calls. One line of page script — `window.axe.run = async () => ({
// violations: [] })` — therefore silences every rule, and because nothing threw,
// no analysisError is raised and the agent is told the pass ran clean. Capturing
// the entry points at import time means our calls keep using the real ones.
//
// This does NOT make the bridge unforgeable. It shares a realm with the page and
// cannot be made to (see the note in index.ts); it removes the one-line version.
const axeRun = axe.run.bind(axe)
const axeGetRules = axe.getRules.bind(axe)
const axeReset = axe.reset.bind(axe)

/**
 * Run a fixed rule set over `context` (the document, or the scoped elements).
 *
 * `elementRef` is what makes joining results back onto snapshot nodes exact —
 * without it the only handle is a CSS selector string, which has to be re-queried
 * and can miss. `iframes: false` keeps axe inside this document: nested frames
 * are the page's own business and injecting into them is a mutation.
 */
export async function run(context: unknown, rules: string[]): Promise<AxeRunResult> {
  // Undo any `axe.configure()` the page ran: config lives in axe's own state, so
  // capturing the function references above does not protect the rule set.
  axeReset()
  // A renamed or dropped rule id rejects the WHOLE run ("unknown rule ..."),
  // which would turn every snapshot into run-failed on a dependency bump.
  const available = new Set((axeGetRules() as Array<{ ruleId: string }>).map((r) => r.ruleId))
  const values = rules.filter((rule) => available.has(rule))
  const options = {
    elementRef: true,
    iframes: false,
    // Deliberately WITHOUT 'passes'. Asking for it does not change what axe
    // computes, but it makes axe build a full result — and a unique CSS
    // selector — for every passing node of every rule, and selector generation
    // queries the whole document once per ancestor level. Measured: 4,202
    // elements went 4.6 s -> 15.5 s, past the 12 s run timeout, and 4,902 went
    // 5.0 s -> 28.4 s, past the 25 s frame timeout. Above roughly four thousand
    // elements the entire axe half of the tool silently vanished from a result
    // still returned as a success.
    resultTypes: ['violations', 'incomplete'],
    runOnly: { type: 'rule', values },
  }
  const result = (await axeRun(context as never, options as never)) as unknown as Partial<AxeRunResult>
  return { violations: result.violations ?? [], incomplete: result.incomplete ?? [] }
}
