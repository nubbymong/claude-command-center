#!/usr/bin/env node
// Make sure the history the WP1 gate tests read is in the object store:
//  1. the ONE commit the legacy-Codex gate reads, the pre-WP1 baseline named
//     by docs/wp1/baseline-test-inventory.json;
//  2. when tests/wp1/traceability.json declares a boundHead, enough of HEAD's
//     history to decide whether boundHead is an ancestor of HEAD (the
//     candidate check in tests/wp1/traceability.test.ts).
//
// tests/wp1/legacy-codex-gate.test.ts lists that commit's tree to tell a file
// WP1 created from one it inherited, and every workflow that runs the unit
// suite checks out at depth 1, which does not carry it (exact-head review: the
// gate failed "not a tree object" on both CI platforms). One script, called by
// every such workflow step, so the fetch cannot be fixed in one workflow and
// forgotten in another -- the release build runs the same suite from the same
// kind of checkout (exact-head review fix, independent spec review).
//
// It was first pointed at the ledger's `manifestHead`, a commit that moves with
// every re-skeleton; the gate now reads the fixed baseline, which is on beta,
// so nothing depends on GitHub keeping a branch commit reachable (adversarial
// round 8). An object already present is not fetched again, and `--depth=1` is
// passed only to a checkout that is already shallow: in a full clone it would
// have made the repository shallow (adversarial round 8, MINOR).
//
// The boundHead (2): a depth-1 checkout cannot answer `merge-base
// --is-ancestor` -- the commit is missing (exit 128), or present but cut off
// by the shallow boundary (exit 1) -- so an honest binding read as "not an
// ancestor" on every CI and release run (PR 4, P4.10 review). HEAD's history
// is deepened in bounded steps, each asked for from what is already here so it
// never shortens the history, then fetched in full once; a full clone is never
// deepened. If the question still has no answer, this step fails here, naming
// the cause. Whether boundHead IS an ancestor is the test's verdict, not this
// script's.
//
// Both SHAs come from files a PR can edit, so they are format-checked, and git
// is run without a shell: a value such as `--upload-pack=...` never reaches git.
//
//   node scripts/wp1/fetch-ledger-commit.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const INVENTORY = 'docs/wp1/baseline-test-inventory.json'
const TRACEABILITY = 'tests/wp1/traceability.json'

export const SHA_RE = /^[0-9a-f]{40}$/
/** Commits added to HEAD's history per bounded step, before one full fetch. */
export const DEEPEN_STEPS = [64, 512]

/** @typedef {(args: string[]) => { status: number | null, stdout: string, stderr?: string }} Git */

/** The manifest's boundHead: `{ sha }`, `{ none: true }` when no binding is
 *  declared, or `{ error }` when the value is not a 40-hex commit id.
 *  @param {string} text @returns {{ sha: string } | { none: true } | { error: string }} */
export function readBoundHead(text) {
  const bound = JSON.parse(text).boundHead
  if (bound === null || bound === undefined) return { none: true }
  if (typeof bound !== 'string' || !SHA_RE.test(bound)) return { error: `${TRACEABILITY} boundHead is not a 40-hex commit id` }
  return { sha: bound }
}

/** @param {Git} git @returns {boolean | null} null when git cannot say */
function isShallow(git) {
  const r = git(['rev-parse', '--is-shallow-repository'])
  const out = r.stdout.trim()
  return r.status === 0 && (out === 'true' || out === 'false') ? out === 'true' : null
}

/** Is `sha` an ancestor of HEAD: 'ancestor', 'not-ancestor', or 'undecidable'.
 *  A shallow repository can only ever prove 'ancestor': a missing commit or a
 *  path cut by the shallow boundary says nothing there.
 *  @param {Git} git @param {string} sha @returns {'ancestor' | 'not-ancestor' | 'undecidable'} */
export function ancestry(git, sha) {
  if (!SHA_RE.test(sha)) throw new Error(`not a 40-hex commit id: ${JSON.stringify(sha)}`)
  const r = git(['merge-base', '--is-ancestor', sha, 'HEAD'])
  if (r.status === 0) return 'ancestor'
  if (isShallow(git) !== false) return 'undecidable'
  return r.status === 1 || r.status === 128 ? 'not-ancestor' : 'undecidable'
}

/** Deepens HEAD's history until ancestry() has an answer: DEEPEN_STEPS, then
 *  one full fetch, never in a repository that is not shallow. Returns the
 *  verdict, the fetches made, and an error whenever the verdict is
 *  'undecidable'.
 *  @param {Git} git @param {string} sha
 *  @returns {{ verdict: 'ancestor' | 'not-ancestor' | 'undecidable', fetches: string[][], error?: string }} */
export function deepenUntilDecidable(git, sha) {
  /** @type {string[][]} */
  const fetches = []
  let verdict = ancestry(git, sha)
  if (verdict !== 'undecidable') return { verdict, fetches }
  const head = git(['rev-parse', 'HEAD']).stdout.trim()
  if (!SHA_RE.test(head)) return { verdict, fetches, error: 'HEAD does not resolve to a commit' }
  const steps = [...DEEPEN_STEPS.map((step) => () => {
    const have = Number(git(['rev-list', '--count', 'HEAD']).stdout.trim())
    return [`--depth=${(Number.isInteger(have) && have > 0 ? have : 1) + step}`]
  }), () => ['--unshallow']]
  for (const flags of steps) {
    const shallow = isShallow(git)
    if (shallow !== true) {
      return { verdict, fetches, error: shallow === false ? 'git merge-base gave no answer in a repository that is not shallow' : 'git cannot say whether the repository is shallow' }
    }
    const args = ['fetch', '--no-tags', ...flags(), 'origin', head]
    fetches.push(args)
    const r = git(args)
    if (r.status !== 0) return { verdict: 'undecidable', fetches, error: `git ${args.join(' ')} exited ${r.status}: ${(r.stderr ?? '').trim()}` }
    verdict = ancestry(git, sha)
    if (verdict !== 'undecidable') return { verdict, fetches }
  }
  return { verdict, fetches, error: "still no answer after fetching HEAD's full history" }
}

/** @type {Git} */
const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 26 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function prepareBinding() {
  if (!existsSync(TRACEABILITY)) {
    console.log(`no ${TRACEABILITY} in this tree; no binding to check`)
    return 0
  }
  const bound = readBoundHead(readFileSync(TRACEABILITY, 'utf8'))
  if ('none' in bound) {
    console.log(`${TRACEABILITY} declares no boundHead; nothing to deepen`)
    return 0
  }
  if ('error' in bound) {
    console.error(`::error::${bound.error}`)
    return 1
  }
  const { verdict, fetches, error } = deepenUntilDecidable(git, bound.sha)
  for (const f of fetches) console.log(`git ${f.join(' ')}`)
  if (verdict === 'undecidable') {
    console.error(`::error::cannot decide whether boundHead ${bound.sha} is an ancestor of HEAD: ${error}`)
    return 1
  }
  console.log(`boundHead ${bound.sha} ${verdict === 'ancestor' ? 'is' : 'is NOT'} an ancestor of HEAD; the candidate check judges the binding`)
  return 0
}

function fetchBaseline() {
  if (!existsSync(INVENTORY)) {
    console.log(`no ${INVENTORY} in this tree; nothing to fetch`)
    return 0
  }
  const sha = String(JSON.parse(readFileSync(INVENTORY, 'utf8')).head)
  if (!SHA_RE.test(sha)) {
    console.error(`::error::${INVENTORY} head is not a 40-hex commit id`)
    return 1
  }
  const present = () => {
    try {
      execFileSync('git', ['cat-file', '-e', `${sha}^{tree}`], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  }
  if (present()) {
    console.log(`${sha} already present`)
    return 0
  }
  const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true'
  execFileSync('git', ['fetch', '--no-tags', ...(shallow ? ['--depth=1'] : []), 'origin', sha], { stdio: 'inherit' })
  // Proves the object the gate reads is now present, not only that fetch exited 0.
  if (!present()) {
    console.error(`::error::fetched ${sha} but its tree is still not in the object store`)
    return 1
  }
  console.log(`fetched ${sha}`)
  return 0
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedDirectly) {
  // The binding first: once HEAD's history is deep enough, a baseline on it is
  // already present, and a baseline fetched at depth 1 afterwards cannot cut
  // the path just found (a commit on that path is present, so it is not
  // fetched).
  const binding = prepareBinding()
  const baseline = fetchBaseline()
  process.exit(binding || baseline)
}
