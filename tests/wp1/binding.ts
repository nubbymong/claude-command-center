// WP1.70: the candidate check's binding rules, as pure functions over data.
// traceability.test.ts runs them on this repository; its [host] cases run them
// on injected lists and an injected git, so they spawn nothing. The ancestry
// verdict lives in scripts/wp1/fetch-ledger-commit.mjs, which deepens a
// shallow checkout before the suite runs, so the script and the test can
// never disagree on what "decidable" means.
import { ancestry, SHA_RE } from '../../scripts/wp1/fetch-ledger-commit.mjs'

export { ancestry, SHA_RE }

/** One git call: argv in, exit status and output back (status null: git did not run). */
export type Git = (args: string[]) => { status: number | null; stdout: string; stderr?: string }

export type EvidenceRecord = {
  artifact: string; sha256: string; head: string; actor: string; at: string; commands: string[]; runId?: string
}

export const MANIFEST_PATH = 'tests/wp1/traceability.json'

// What may change after the binding without breaking it: this manifest (the
// commit that records boundHead edits it), and text that nothing in the app,
// its build or its packaged files reads: docs/ (the evidence files there are
// pinned again by each record's sha256), the running log, the ADRs and the
// top-level Markdown. Everything else breaks it: src, tests, scripts,
// resources, build, the workflows, package.json and its lockfile, every
// config, and any path added later, so a new kind of file is covered without
// anyone widening a list.
export const BINDING_NEUTRAL: readonly RegExp[] = [
  /^tests\/wp1\/traceability\.json$/,
  /^docs\//,
  /^CONTEXT\.d\//,
  /^architecture\/decisions\/[^/]+\.md$/,
  /^[^/]+\.md$/,
]

/** The changed paths that break the evidence binding. */
export function bindingBreaks(changed: readonly string[]): string[] {
  return changed.filter((p) => !BINDING_NEUTRAL.some((re) => re.test(p)))
}

/** Every path changed between base and HEAD: NUL-separated (no quoting of
 *  unusual names) and without rename pairing (a file moved out of src still
 *  lists its old path). */
export function changedPaths(git: Git, base: string): string[] {
  const r = git(['diff', '--name-only', '--no-renames', '-z', `${base}..HEAD`])
  if (r.status !== 0) throw new Error(`git diff ${base}..HEAD exited ${r.status}: ${r.stderr ?? ''}`)
  return r.stdout.split('\0').filter(Boolean)
}

/** What every release step that runs the suite gives WP1_PHASE: the candidate
 *  phase on a stable release that is not a dry run, otherwise nothing
 *  (./phase.ts then reads the manifest). */
export const RELEASE_WP1_PHASE = "${{ inputs.channel == 'stable' && !inputs.dry_run && 'candidate' || '' }}"

export type SuiteStep = { job: string; name: string; phase: string | null }

/** The steps of a workflow that run the test suite (vitest, or an npm test
 *  script), each with its job, its name and the WP1_PHASE its own `env:`
 *  gives it (null: none). The manifest's `phase` is a neutral field, so a
 *  manifest-only commit could switch the candidate check off; the stable
 *  release declares the phase in its own steps' environment instead, which
 *  ./phase.ts lets only raise it. Line-based, for the workflows' own layout:
 *  jobs at two spaces; a step runs from its `- ` under `steps:` to the next
 *  one or the end of the list; comments never count. */
export function suiteSteps(yml: string): SuiteStep[] {
  const out: SuiteStep[] = []
  let job = ''
  let stepsAt = -1
  let itemAt = -1
  let step: string[] | null = null
  const close = () => {
    if (!step) return
    const code = step.filter((l) => !l.trim().startsWith('#')).join('\n')
    if (/^\s*(?:- )?run:/m.test(code) && /\bvitest\b|\bnpm (?:run )?test\b/.test(code)) {
      const name = /^\s*(?:- )?name:\s*(.+?)\s*$/m.exec(code)?.[1] ?? '(unnamed)'
      const phase = /^\s+WP1_PHASE:\s*(.+?)\s*$/m.exec(code)?.[1] ?? null
      out.push({ job, name, phase: phase === null ? null : phase.replace(/^(['"])(.*)\1$/, '$2') })
    }
    step = null
  }
  for (const line of yml.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '' || line.trim().startsWith('#')) { step?.push(line); continue }
    const lead = /^ */.exec(line)![0].length
    const top = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (top) { close(); job = top[1]; stepsAt = -1; itemAt = -1; continue }
    if (stepsAt >= 0 && lead <= stepsAt) { close(); stepsAt = -1; itemAt = -1 }
    const steps = /^( +)steps:\s*$/.exec(line)
    if (steps && stepsAt < 0) { stepsAt = steps[1].length; continue }
    if (stepsAt < 0) continue
    const item = /^( +)- /.exec(line)
    if (item && (itemAt < 0 || item[1].length === itemAt)) { close(); itemAt = item[1].length; step = [line]; continue }
    step?.push(line)
  }
  close()
  return out
}

/** Evidence records not taken at boundHead. The manifest that declares
 *  boundHead is itself neutral, so boundHead alone could be moved past a
 *  source change with the evidence untouched; each record therefore names the
 *  head it was taken at, its artifact says so in its text, and every one must
 *  be boundHead. */
export function staleRecords(
  items: ReadonlyArray<{ id: string; evidenceRecords?: ReadonlyArray<Pick<EvidenceRecord, 'artifact' | 'head'>> }>,
  boundHead: string,
  textOf: (artifact: string) => string,
): string[] {
  return items.flatMap((i) => (i.evidenceRecords ?? []).flatMap((r) => {
    if (r.head !== boundHead) return [`${i.id}: ${r.artifact} was taken at ${r.head || '(no head)'}, not at boundHead ${boundHead}`]
    if (!textOf(r.artifact).includes(r.head)) return [`${i.id}: ${r.artifact} does not name the head ${r.head} its record claims`]
    return []
  }))
}
