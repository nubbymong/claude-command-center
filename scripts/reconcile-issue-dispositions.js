#!/usr/bin/env node
/**
 * Reconcile issue dispositions — "nothing in limbo" governance (#437).
 *
 * Every OPEN issue must carry exactly one disposition:
 *   - a release line  `release-<major.minor>`  (scheduled to ship in that line), or a
 *     patch release on a line whose x.y.0 has shipped, `release-<major.minor.patch>`
 *     (CONTRIBUTING.md "Release-line labels"), OR
 *   - `backlog`   (real work, accepted, not yet scheduled), OR
 *   - `triage`    (undecided; a human must decide — the default on a new issue), OR
 *   - `wontfix` / `duplicate` / `excluded`  (will not ship).
 *
 * And once an issue is in a COMMITTED state (`in-beta`, `in-release`, `loop-claimed`,
 * `loop-in-progress`, `loop-done`) it must carry a release label — the line
 * `release-<major.minor>`, or the patch `release-<major.minor.patch>` once that
 * line's x.y.0 has shipped — because work started or shipped means the target
 * is decided.
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
 *   - add the active release label to an `in-beta` issue with no release line
 *     (unambiguous — it is shipping on the active line). The active label comes
 *     from the checked-out package.json: an unshipped `x.y.0-…` means the line
 *     label `release-x.y`; a shipped `x.y.z` means the NEXT patch, `release-x.y.(z+1)`;
 *   - everything else is FLAGGED for a human, never guessed. The script never
 *     removes a label, never closes anything, and never assigns a release line to
 *     a committed-but-not-in-beta issue (choosing the line is a human decision made
 *     when the work is claimed).
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/**
 * A release disposition: the line `release-<major>.<minor>`, or a patch release on
 * a shipped line `release-<major>.<minor>.<patch>` with patch >= 1 (`release-2.1.0`
 * is not a label: x.y.0 is what the line label means; no prerelease suffix ever).
 *
 * Every number is canonical -- no leading zero. `release-02.1` is not the 2.1 line
 * spelled differently, it is a second label that lineOf() would otherwise fold
 * into the real one (final adversarial pass, 2.1.1).
 */
const NUM = '(?:0|[1-9]\\d*)'
const RELEASE_RE = new RegExp(`^release-${NUM}\\.${NUM}(\\.[1-9]\\d*)?$`)
/** The LINE a release label belongs to: `release-2.1.1` -> `release-2.1`. */
function lineOf(label) {
  const m = String(label || '').toLowerCase().match(new RegExp(`^release-(${NUM})\\.(${NUM})(?:\\.|$)`))
  return m ? `release-${m[1]}.${m[2]}` : null
}
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

/**
 * The label in-beta work ships under, from the checked-out package.json version:
 *
 *   2.1.0-rc.17  -> release-2.1     x.y.0 not yet shipped: the line label
 *   2.1.1-rc.1   -> release-2.1.1   a patch in flight
 *   2.1.0        -> release-2.1.1   x.y.0 HAS shipped: the next patch on the line
 *   2.1.1        -> release-2.1.2
 *
 * The scheduled job checks out `beta` (issue-disposition.yml), so it sees the
 * shape the integration branch carries: the line label before x.y.0 ships, the
 * patch label after, and the next-patch shape only in the brief window between
 * a promotion's merge-back and the following bump. The grammar is
 * exactly what scripts/release.js produces -- `X.Y.Z`, `X.Y.Z-beta.N`, `X.Y.Z-rc.N`
 * -- and anything else (a bare `2.1`, `2.1.0-rc..1`, `2.1.0--`, an unknown
 * prerelease tag) is UNKNOWN (null): the caller then flags the issue for a human
 * instead of auto-labelling from a malformed version.
 */
function activeLineFromVersion(version) {
  const v = String(version || '')
  // Canonical numbers only (no leading zero): `02.1.1` would otherwise derive
  // `release-02.1`, a label nothing else in the repo recognises.
  const m = v.match(new RegExp(`^(${NUM})\\.(${NUM})\\.(${NUM})(?:-(beta|rc)\\.(\\d+))?$`))
  if (!m) return null
  const line = `release-${m[1]}.${m[2]}`
  // BigInt: a Number past 2^53 rounds (`...993` + 1 -> `...992`) and past 1e21
  // stringifies as `1e+21`; either way the label would be wrong (re-attack,
  // 2.1.1). Absurd for a real version, cheap to get right.
  const patch = BigInt(m[3])
  if (m[4]) return patch > 0n ? `${line}.${patch}` : line
  return `${line}.${patch + 1n}`
}

/**
 * Guard a CLI-supplied `--active-line`. Null/undefined is fine (the value is then
 * computed from package.json). A non-empty value that is not a
 * `release-<major>.<minor>[.<patch>]` label THROWS — a malformed operator value
 * must never reach `decide()` and get auto-added as a bogus label.
 */
function validateActiveLine(line) {
  if (line == null) return line
  if (!RELEASE_RE.test(String(line).toLowerCase())) {
    throw new Error(`--active-line must be release-<major>.<minor>[.<patch>] (got: "${line}")`)
  }
  return line
}

/**
 * The active label main() will auto-add: the validated CLI override when one is
 * given, else the label derived from the package version (read only then, as
 * before). The DERIVED value is checked against RELEASE_RE too -- it is the one
 * that reaches `gh issue edit --add-label` with no human in between, so a future
 * derivation bug throws here rather than minting a label (final adversarial
 * pass, 2.1.1). With the current grammar and BigInt arithmetic the deriver
 * cannot produce a non-label, so this is a backstop, not a live path. Null
 * (unknown version) is fine: decide() then flags instead of labelling.
 */
function resolveActiveLine({ cliValue, readVersion }) {
  validateActiveLine(cliValue) // throws on a malformed manual override
  if (cliValue) return cliValue
  const version = readVersion()
  const derived = activeLineFromVersion(version)
  if (derived != null && !RELEASE_RE.test(derived)) {
    throw new Error(`derived active line is not a release label (got: "${derived}" from version "${version}")`)
  }
  return derived
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
      // Compared at LINE level: `release-2.1` and `release-2.1.1` are the same
      // line (a patch label on an already-shipped line), only `release-2.2` is
      // a different one.
      if (pinnedToActive && active && lineOf(releases[0]) !== lineOf(active)) {
        flags.push(`${pinnedVia.join('/')} but carries ${releases[0]}, not the active line ${lineOf(active)}; it ships on the current line — a deferred release line is contradictory`)
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

/**
 * The ONE place `gh` is spawned: argv array, no shell. main() takes this as an
 * injectable so a test can record every argv the run would issue and assert the
 * whole set -- "never removes, never closes" is a claim about this layer.
 */
function ghExec(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 }).trim()
}

function readPackageVersionFromRepo() {
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
function listOpenIssues(repo, gh) {
  const raw = gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '2000', '--json', 'number,title,labels'])
  return parseIssuesJson(raw)
}

function fetchIssue(repo, number, gh) {
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
    else if (a === '--issue') { out.issueRaw = argv[++i]; out.issue = Number(out.issueRaw) }
    else if (a === '--repo') out.repo = argv[++i]
    else if (a === '--active-line') out.activeLine = argv[++i]
  }
  return out
}

/** Append a markdown block to the Actions job summary when running in CI. */
function writeSummary(md, env = process.env) {
  const file = env.GITHUB_STEP_SUMMARY
  if (file) {
    try { fs.appendFileSync(file, md + '\n') } catch { /* summary is best-effort */ }
  }
}

/**
 * The run. Every side effect goes through `io` so the whole thing is testable
 * end-to-end against a fake `gh` that records argv (tests/unit/scripts): the
 * defaults are the real process, the real `gh`, the checked-out package.json.
 * Returns what it did, for the same reason.
 */
function main(io = {}) {
  const argv = io.argv || process.argv.slice(2)
  const env = io.env || process.env
  const gh = io.gh || ghExec
  const readPackageVersion = io.readPackageVersion || readPackageVersionFromRepo
  const log = io.log || console.log

  const args = parseArgv(argv)
  const dryRun = args.dryRun || env.DRY_RUN === '1'
  // Operator input is validated BEFORE anything is asked of gh (re-attack,
  // 2.1.1: the repo fallback below is itself a gh call). A `--issue` that is
  // not a positive integer must not silently widen a one-issue run into a full
  // scan, which `args.issue ? ... : listOpenIssues` would do for `0` or NaN.
  const activeLine = resolveActiveLine({ cliValue: args.activeLine, readVersion: readPackageVersion })
  if (args.issue !== undefined && !(Number.isInteger(args.issue) && args.issue > 0)) {
    throw new Error(`--issue must be a positive integer (got: "${args.issueRaw}")`)
  }
  const repo = args.repo || env.GITHUB_REPOSITORY || gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])

  const issues = args.issue ? [fetchIssue(repo, args.issue, gh)].filter(Boolean) : listOpenIssues(repo, gh)
  log(`Repo: ${repo}   active line: ${activeLine || '(unknown)'}   issues: ${issues.length}${dryRun ? '   [DRY RUN]' : ''}`)

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
  log('\n' + report)
  writeSummary(report, env)

  if (dryRun) log('\nDry run — nothing changed.')
  return { repo, activeLine, dryRun, scanned: issues.length, added, flagged }
}

module.exports = {
  RELEASE_RE,
  lineOf,
  OTHER_DISPOSITIONS,
  COMMITTED_STATES,
  ACTIVE_LINE_STATES,
  activeLineFromVersion,
  validateActiveLine,
  resolveActiveLine,
  decide,
  parseIssuesJson,
  parseArgv,
  main,
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    console.error(`reconcile-issue-dispositions failed: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
