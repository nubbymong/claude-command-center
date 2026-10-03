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
