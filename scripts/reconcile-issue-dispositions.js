#!/usr/bin/env node
/**
 * Reconcile issue dispositions — "nothing in limbo" governance (#437).
 *
 * Every OPEN issue must carry exactly one disposition:
 *   - a release line  `release-<major.minor>`  (scheduled to ship in that line), OR
 *   - `backlog`   (real work, accepted, not yet scheduled), OR
 *   - `triage`    (undecided; a human must decide — the default on a new issue), OR
 *   - `wontfix` / `duplicate` / `excluded`  (will not ship).
 *
 * And once an issue is in a COMMITTED state (`in-beta`, `loop-claimed`,
 * `loop-in-progress`, `loop-done`) it must carry a `release-<major.minor>` label —
 * work started or shipped means the target line is decided.
 *
 * This job is the DURABLE enforcer. It runs on a schedule (and workflow_dispatch),
 * NOT off an `on: labeled` event — a label applied with the Actions `GITHUB_TOKEN`
 * does not fire `labeled`, so an event listener would silently miss bot-applied
 * labels. The scheduled full scan has no such blind spot.
 *
 *   node scripts/reconcile-issue-dispositions.js --dry-run
 *   node scripts/reconcile-issue-dispositions.js --issue 123   # one issue (opened event)
 *   node scripts/reconcile-issue-dispositions.js --repo o/n --active-line release-2.1
 *
 * Actions taken are DELIBERATELY minimal and safe:
 *   - add `triage` to an open issue with no disposition (never leave limbo);
 *   - add the active `release-<x.y>` to an `in-beta` issue with no release line
 *     (unambiguous — it is shipping on the active line);
 *   - everything else is FLAGGED for a human, never guessed. The script never
 *     removes a label, never closes anything, and never assigns a release line to
 *     a committed-but-not-in-beta issue (choosing the line is a human decision made
 *     when the work is claimed).
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/** A release-line label: `release-<major>.<minor>` (no patch, no suffix). */
const RELEASE_RE = /^release-\d+\.\d+$/
/** Non-release dispositions. Exactly one disposition total is allowed. */
const OTHER_DISPOSITIONS = ['backlog', 'triage', 'wontfix', 'duplicate', 'excluded']
/** States that mean "work has started or shipped" → a release line is required. */
const COMMITTED_STATES = ['in-beta', 'in-release', 'loop-claimed', 'loop-in-progress', 'loop-done']
/**
 * Lifecycle states pinned to the ACTIVE line specifically: `in-beta` (merged to
 * the current beta) and `in-release` (in a cut rc of the current line). Both are
 * unambiguous — they ship on the active line — so a missing release line is
 * auto-added and a different (deferred) line is flagged as contradictory
 * (CONTRIBUTING.md "Release-line labels" invariant). Other committed states
 * (loop-*) may legitimately target a future line.
 */
const ACTIVE_LINE_STATES = ['in-beta', 'in-release']

// ── pure decision (unit-tested; no network) ────────────────────────

/** `release-2.1` from a version like `2.1.0-beta.17`. Null if unparseable. */
function activeLineFromVersion(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/)
  return m ? `release-${m[1]}.${m[2]}` : null
}

/**
 * Guard a CLI-supplied `--active-line`. Null/undefined is fine (the value is then
 * computed from package.json). A non-empty value that is not a
 * `release-<major>.<minor>` label THROWS — a malformed operator value must never
 * reach `decide()` and get auto-added as a bogus label.
 */
function validateActiveLine(line) {
  if (line == null) return line
  if (!RELEASE_RE.test(String(line).toLowerCase())) {
    throw new Error(`--active-line must be release-<major>.<minor> (got: "${line}")`)
  }
  return line
}

/**
 * Decide what a single issue needs, from its labels alone.
 * @param {{labels?: string[], activeLine?: string|null}} input
 * @returns {{add: string[], flags: string[]}}  labels to add, and human-only flags.
 *
 * Never returns a label to REMOVE and never both adds and flags a conflict — a
 * conflict is handed to a human untouched. `add` is safe to apply blindly.
 */
function decide({ labels = [], activeLine = null }) {
  // Normalize to lowercase before matching — GitHub label names are
  // case-sensitive, so `In-Beta` / `Release-2.1` would otherwise be silently
  // unrecognized. The labels we ADD are canonical lowercase (triage, release-x.y).
  const set = (labels || []).filter(Boolean).map((l) => String(l).toLowerCase())
  const active = activeLine ? String(activeLine).toLowerCase() : null
  const releases = set.filter((l) => RELEASE_RE.test(l))
  const others = OTHER_DISPOSITIONS.filter((d) => set.includes(d))
  const dispositionCount = releases.length + others.length
  const committedVia = COMMITTED_STATES.filter((s) => set.includes(s))
  const committed = committedVia.length > 0
  const add = []
  const flags = []

  // More than one disposition of any kind (two release lines, or a release line
  // alongside backlog/triage/wontfix/…). Ambiguous intent — a human resolves it;
  // we add nothing on top of a conflict.
  if (dispositionCount > 1) {
    flags.push(`multiple dispositions (${[...releases, ...others].join(', ')}); exactly one required`)
    return { add, flags }
  }

  if (committed) {
    const pinnedToActive = ACTIVE_LINE_STATES.some((s) => set.includes(s))
    const pinnedVia = ACTIVE_LINE_STATES.filter((s) => set.includes(s))
    if (releases.length === 1) {
      // `in-beta`/`in-release` mean the fix is in the CURRENT beta / a cut rc of
      // the current line, so they must carry the ACTIVE line — a different
      // (deferred) line is self-contradictory (CONTRIBUTING.md invariant:
      // in-beta/in-release and release-2.2 never coexist). Other committed states
      // (loop-*) may legitimately target a future line, so they are left alone.
      if (pinnedToActive && active && releases[0] !== active) {
        flags.push(`${pinnedVia.join('/')} but carries ${releases[0]}, not the active line ${active}; it ships on the current line — a deferred release line is contradictory`)
      }
      return { add, flags }
    }
    if (dispositionCount === 0) {
      if (pinnedToActive) {
        // Unambiguous: an in-beta / in-release issue ships on the active line.
        if (active) add.push(active)
        else flags.push(`${pinnedVia.join('/')} but the active release line is unknown (package.json version unparsed)`)
      } else {
        // Claimed/in-progress/done with no line — choosing it is a human decision.
        flags.push(`committed (${committedVia.join(', ')}) but no release line; a human must assign one`)
      }
      return { add, flags }
    }
    // committed with a single NON-release disposition (e.g. in-beta + backlog) — contradictory.
    flags.push(`committed (${committedVia.join(', ')}) but marked ${others.join(', ')}; needs a release line, not a non-release disposition`)
    return { add, flags }
  }

  // Not committed: any single disposition is fine; none means limbo → triage.
  if (dispositionCount === 0) add.push('triage')
  return { add, flags }
}

// ── i/o ────────────────────────────────────────────────────────────

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 }).trim()
}

function readPackageVersion() {
  try {
    const pkg = path.join(path.resolve(__dirname, '..'), 'package.json')
    return JSON.parse(fs.readFileSync(pkg, 'utf-8')).version || null
  } catch {
    return null
  }
}

/** Map `gh issue list --json number,title,labels` output to our shape. Pure so a
 *  title containing any characters (e.g. `] [`) is parsed by JSON, never by string
 *  surgery. */
function parseIssuesJson(jsonText) {
  const arr = JSON.parse(jsonText)
  return arr.map((it) => ({
    number: it.number,
    title: it.title || '',
    labels: (it.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
  }))
}

/**
 * Open issues (NOT pull requests), each `{ number, title, labels: string[] }`.
 *
 * Uses `gh issue list`, which returns ONE well-formed JSON array (and excludes
 * PRs for us) — no cross-page `][` concatenation to stitch back together, so an
 * issue title containing `] [` can never corrupt the parse (the previous
 * `raw.replace(/\]\s*\[/g, ',')` reassembly could).
 */
function listOpenIssues(repo) {
  const raw = gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '2000', '--json', 'number,title,labels'])
  return parseIssuesJson(raw)
}

function fetchIssue(repo, number) {
  const it = JSON.parse(gh(['api', `repos/${repo}/issues/${number}`]))
  if (it.pull_request) return null
  return {
    number: it.number,
    title: it.title || '',
    labels: (it.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
  }
}

function parseArgv(argv) {
  const out = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--issue') out.issue = Number(argv[++i])
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--active-line') out.activeLine = argv[++i]
  }
  return out
}

/** Append a markdown block to the Actions job summary when running in CI. */
function writeSummary(md) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file) {
    try { fs.appendFileSync(file, md + '\n') } catch { /* summary is best-effort */ }
  }
}

function main() {
  const args = parseArgv(process.argv.slice(2))
  const dryRun = args.dryRun || process.env.DRY_RUN === '1'
  const repo = args.repo || process.env.GITHUB_REPOSITORY || gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  validateActiveLine(args.activeLine) // throws on a malformed manual override
  const activeLine = args.activeLine || activeLineFromVersion(readPackageVersion())

  const issues = args.issue ? [fetchIssue(repo, args.issue)].filter(Boolean) : listOpenIssues(repo)
  console.log(`Repo: ${repo}   active line: ${activeLine || '(unknown)'}   issues: ${issues.length}${dryRun ? '   [DRY RUN]' : ''}`)

  const added = []
  const flagged = []
  for (const issue of issues) {
    const { add, flags } = decide({ labels: issue.labels, activeLine })
    for (const label of add) {
      added.push({ number: issue.number, label, title: issue.title })
      if (!dryRun) gh(['issue', 'edit', String(issue.number), '--repo', repo, '--add-label', label])
    }
    for (const flag of flags) flagged.push({ number: issue.number, flag, title: issue.title })
  }

  const lines = ['## Issue-disposition reconcile', '', `Active line: \`${activeLine || 'unknown'}\` · scanned ${issues.length} open issue(s).`, '']
  lines.push(`### Added (${added.length})`)
  for (const a of added) lines.push(`- #${a.number} → \`${a.label}\``)
  lines.push('', `### Flagged for a human (${flagged.length})`)
  for (const f of flagged) lines.push(`- #${f.number} — ${f.flag}`)
  const report = lines.join('\n')
  console.log('\n' + report)
  writeSummary(report)

  if (dryRun) console.log('\nDry run — nothing changed.')
}

module.exports = {
  RELEASE_RE,
  OTHER_DISPOSITIONS,
  COMMITTED_STATES,
  ACTIVE_LINE_STATES,
  activeLineFromVersion,
  validateActiveLine,
  decide,
  parseIssuesJson,
  parseArgv,
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error(`reconcile-issue-dispositions failed: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
