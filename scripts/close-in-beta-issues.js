#!/usr/bin/env node
/**
 * Close `in-beta` / `in-release` issues covered by a promotion to `main`.
 *
 * Under the RC-branch model, fixes merge to `beta` long before they ship. An
 * issue therefore stays OPEN with the `in-beta` label until its change promotes
 * to `main` (see CONTRIBUTING.md -> "Issue lifecycle"). When an rc cut rolls
 * the issue into a release candidate, `in-release` replaces `in-beta`
 * (scripts/roll-issues-into-release.mjs) — still open, one step further along.
 * This script performs the close-on-promotion step that was manual until now
 * (#134), for both labels.
 *
 *   node scripts/close-in-beta-issues.js --dry-run
 *   node scripts/close-in-beta-issues.js --range <base>..<head>
 *   node scripts/close-in-beta-issues.js --range v2.0.0..main --version 2.1.0
 *
 * Flags:
 *   --range <a>..<b>  Commit range to harvest refs from. Defaults to the push
 *                     event's before..after, else <previous tag>..HEAD.
 *   --dry-run         Print the plan; touch nothing. Also honoured via DRY_RUN=1.
 *   --version <v>     Version named in the close comment. Defaults to
 *                     package.json's version at the checked-out commit.
 *   --repo <o/n>      Target repo. Defaults to $GITHUB_REPOSITORY, else the
 *                     `gh` CLI's current repo.
 *
 * Why refs are resolved by TEXT rather than GitHub's linked-issue API:
 * `closingIssuesReferences` is EMPTY for every PR in this repo, because GitHub
 * only records a closing reference when the PR targets the DEFAULT branch. Our
 * feature PRs all target `beta`, so the API reports nothing and a linked-issue
 * implementation would silently close nothing at all. Verified against #92
 * (body says "Closes #74"; the API returns []). So: harvest `#NNN` from the
 * promoted commit messages, then from the title/body of each referenced PR.
 *
 * The FAIL-SAFE is the filter, not the harvest: a candidate is only ever closed
 * if it is an issue (not a PR), is currently OPEN, and carries the `in-beta` or
 * `in-release` label.
 *
 * Why the LABEL SET drives the lookups, not the refs: a promotion range is as
 * long as a release. `v2.0.0..main` for 2.1.0 spans 775 commits carrying 475
 * distinct refs — almost all of them PR numbers — against 128 labeled issues.
 * Fetching every ref to discover that most are pull requests is both slow and,
 * at one API call each, enough to bite the Actions token's hourly budget. Worse,
 * the old ceiling `return`ed without closing anything, so the single run that
 * matters most — the first stable promotion in months — would have silently
 * closed nothing. So: list the open `in-beta`/`in-release` issues once (bounded
 * by how many issues carry the label, which is inherently small), intersect with
 * the refs harvested from the commit log for free, and pay for a PR-body lookup
 * only when a labeled issue was NOT cited directly.
 *
 * What that trades away, deliberately: a ref that is foreign, a PR, or unlabeled
 * is now rejected by set lookup and never appears in the run log, where the old
 * ref-driven walk listed it under "Skipped". The reporting that matters is kept
 * and is stronger — every labeled issue is accounted for, and any that the range
 * does not reference is named as staying open.
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

// Lifecycle labels, in lifecycle order. An issue carries at most one (the roll
// script swaps in-beta for in-release), but the close path removes every one it
// finds so a mislabeled issue cannot keep a stale lifecycle label after close.
const LIFECYCLE_LABELS = ['in-beta', 'in-release']
// Ceiling on the OPTIONAL PR-body expansion pass only — the one part of the run
// whose cost is not bounded by the label set. Hitting it no longer discards the
// run: whatever was already matched still closes, and the shortfall is reported
// by number so a human can finish the job. (Before, the ceiling `return`ed and
// closed nothing, which is the failure mode that made a 475-ref promotion a
// no-op.)
const MAX_EXPANSION_LOOKUPS = 200
// Pause between issues while closing. See the close loop for why: three
// content-generating requests per issue against a ~80/min secondary limit.
const THROTTLE_MS = 250

/** Block for `ms`. Sync on purpose — the whole script is synchronous execFileSync. */
function sleepMs(ms) {
  if (!ms) return
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// ── pure helpers (unit-tested) ─────────────────────────────────────

/**
 * Every `#NNN` reference in a blob of text, deduped, ascending.
 *
 * Bounded to 1-6 digits so a hex/colour literal can't produce a ref, and the
 * lookbehind rejects a `#` glued to a word character or slash so GitHub's
 * cross-repo `owner/repo#123` form is NOT read as a local ref.
 *
 * Bare cross-project prose ("xterm.js #1194", "electron-builder #2964" — both
 * real in this repo's history) still matches; those refs simply don't resolve to
 * a local issue, and the label filter is what makes that harmless.
 */
function extractRefs(text) {
  if (!text) return []
  const out = new Set()
  for (const m of String(text).matchAll(/(?<![\w/-])#(\d{1,6})\b/g)) {
    const n = Number(m[1])
    if (n > 0) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/**
 * Refs from `git log --format=%s%n%b` output. Subjects carry the squash-merge
 * `(#NNN)` PR ref; bodies carry `Closes #NNN` and `(#NNN)` trailers. We do not
 * distinguish the two — both are candidates, and the label filter decides.
 *
 * Co-authored-by / Signed-off-by trailers are dropped first: they can't contain
 * issue refs and skipping them keeps the candidate set tight.
 */
function refsFromCommitLog(logText) {
  const cleaned = String(logText || '')
    .split('\n')
    .filter((line) => !/^\s*(co-authored-by|signed-off-by|reported-by):/i.test(line))
    .join('\n')
  return extractRefs(cleaned)
}

/**
 * Decide what to do with one fetched candidate. Returns either
 * `{ action: 'close' }` or `{ action: 'skip', reason }` — the single place the
 * fail-safe rules live, so they're testable without any network.
 *
 * `item` is the `/issues/{n}` payload shape: { number, state, labels: [{name}],
 * pull_request?: {...}, title }.
 */
function classifyCandidate(item) {
  if (!item || item.notFound) return { action: 'skip', reason: 'not found' }
  if (item.pull_request) return { action: 'skip', reason: 'is a pull request' }
  const labels = (item.labels || []).map((l) => (typeof l === 'string' ? l : l.name))
  const carried = LIFECYCLE_LABELS.filter((l) => labels.includes(l))
  if (!carried.length) return { action: 'skip', reason: `not labeled ${LIFECYCLE_LABELS.join(' or ')}` }
  if (item.state !== 'open') return { action: 'skip', reason: `already ${item.state}` }
  // `label` is the furthest-along lifecycle label — that is the state the close
  // comment describes if the issue somehow carries both.
  return { action: 'close', label: carried[carried.length - 1], carried }
}

/** Split candidates into a close list and an annotated skip list. */
function planClosures(items) {
  const toClose = []
  const skipped = []
  for (const item of items) {
    const verdict = classifyCandidate(item)
    // The verdict's label facts ride along on a copy so the close loop knows
    // which lifecycle label(s) to describe and remove.
    if (verdict.action === 'close') toClose.push({ ...item, closeLabel: verdict.label, closeCarried: verdict.carried })
    else skipped.push({ number: item && item.number, reason: verdict.reason })
  }
  return { toClose, skipped }
}

/**
 * Intersect the refs harvested from the promoted commits with the set of issues
 * that could possibly close (open + lifecycle-labeled), fetched once up front.
 *
 * Returns the matched items in ref order, plus the labeled issues that were NOT
 * cited anywhere in the range. That second list is what decides whether the
 * caller pays for PR-body expansion at all: when it is empty — the common case,
 * because a squash subject carries `(#NNN)` — the whole run costs one listing
 * and no per-ref lookups.
 *
 * Labeled PULL REQUESTS are excluded from the shortfall: they can never close,
 * so their absence from the range must not trigger an expansion pass hunting
 * for them. They stay in `matched` if referenced, where classifyCandidate's own
 * guard skips them and reports why.
 */
function selectCandidates(refs, labeledByNumber) {
  if (!labeledByNumber || !labeledByNumber.size) return { matched: [], unmatched: [] }
  const matched = []
  const hit = new Set()
  for (const n of refs || []) {
    const item = labeledByNumber.get(n)
    if (!item || hit.has(n)) continue
    hit.add(n)
    matched.push(item)
  }
  const unmatched = [...labeledByNumber.entries()]
    .filter(([n, item]) => !hit.has(n) && !(item && item.pull_request))
    .map(([n]) => n)
    .sort((a, b) => a - b)
  return { matched, unmatched }
}

/**
 * Chase the labeled issues no commit cited, through the BODIES of the PRs the
 * range does cite (`Closes #NNN`). Extracted from main() and given an injected
 * `fetchItem` so it is testable: it is the one part of the run whose cost is not
 * bounded by the label set, and the part where a silent miss is most likely.
 *
 * Note the PR guard on the skip. `labeled` holds issues AND pull requests, since
 * REST `/issues?labels=` returns both. Skipping everything already in `labeled`
 * would skip labeled PRs too — and a labeled PR's body is exactly what this pass
 * exists to read, so the issue it closes would be reported as "not referenced
 * anywhere in this range" when it plainly is.
 *
 * Returns the newly-found items and whatever is still missing, so the caller can
 * report the shortfall honestly rather than closing the gap in silence.
 */
function expandViaPrBodies({ direct, labeled, unmatched, fetchItem: fetch, max = MAX_EXPANSION_LOOKUPS, log = () => {} }) {
  const wanted = new Set(unmatched)
  const found = []
  let lookups = 0
  for (const n of direct || []) {
    if (!wanted.size) break
    const known = labeled.get(n)
    if (known && !known.pull_request) continue
    // A labeled PR is already in hand, body included — reading it costs nothing
    // and must not be charged against the lookup ceiling.
    let item = known
    if (!item) {
      if (lookups >= max) {
        log(`  Stopped after ${max} lookups with ${wanted.size} still unaccounted for.`)
        break
      }
      lookups++
      item = fetch(n)
    }
    if (!item || !item.pull_request) continue
    for (const ref of extractRefs(`${item.title || ''}\n${item.body || ''}`)) {
      if (!wanted.has(ref)) continue
      wanted.delete(ref)
      found.push(labeled.get(ref))
    }
  }
  return { found, stillMissing: [...wanted].sort((a, b) => a - b), lookups }
}

/**
 * Pick the commit range to harvest.
 *
 * `before` is all-zeros on a branch's first push, and unreachable after a force
 * push — in both cases the push event can't describe the promotion, so we fall
 * back to the previous tag. With neither available we return null and the caller
 * does nothing (fail-safe: never guess a range).
 */
function resolveRange({ explicit, before, after, isKnownCommit, previousTag }) {
  if (explicit) return explicit
  const usableBefore = before && !/^0+$/.test(before) && isKnownCommit(before)
  if (usableBefore && after) return `${before}..${after}`
  if (previousTag) return `${previousTag}..${after || 'HEAD'}`
  return null
}

/** Comment left on each issue as it closes. `label` = the lifecycle label it carried. */
function closeCommentBody({ version, sha, range, label = 'in-beta' }) {
  const shipped = version ? `**v${version}**` : 'a stable release'
  const journey =
    label === 'in-release'
      ? `The fix was in a cut release candidate (labeled \`in-release\`); it has now promoted to`
      : `The fix was on \`beta\` and in testing (labeled \`${label}\`); it has now promoted to`
  const lines = [
    `Shipped to \`main\` in ${shipped}${sha ? ` (${sha.slice(0, 7)})` : ''}.`,
    '',
    journey,
    '`main`, so this is closed as completed.',
  ]
  if (range) lines.push('', `<sub>Closed automatically from the promotion range \`${range}\`.</sub>`)
  return lines.join('\n')
}

// ── i/o ────────────────────────────────────────────────────────────

// maxBuffer matters here, not just on gh: a promotion range is a whole release,
// and `git log --format=%s%n%b v2.0.0..main` for 2.1.0 is ~2 MB of subjects and
// bodies. Node's 1 MB default kills it with ENOBUFS, which the catch in main()
// reports as a bare failure with nothing closed.
function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 }).trim()
}

/**
 * GET a single issue/PR, or null when it doesn't exist. A 404 is EXPECTED —
 * commit prose cites other projects' issue numbers — so gh's stderr is swallowed
 * rather than spraying "gh: Not Found (HTTP 404)" through the run log.
 */
function fetchItem(repo, number) {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', `repos/${repo}/issues/${number}`], {
        encoding: 'utf-8',
        maxBuffer: 16 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    )
  } catch {
    return null
  }
}

/**
 * Every OPEN issue currently carrying a lifecycle label, keyed by number.
 *
 * Uses the REST `/issues` list so the payload shape is identical to fetchItem's
 * (lowercase `state`, a `pull_request` key on PRs) — `gh issue list --json`
 * returns `"OPEN"` and would silently fail classifyCandidate's `state !== 'open'`
 * check, closing nothing. Paged explicitly rather than via `--paginate`, which
 * concatenates raw pages into invalid JSON.
 *
 * `runGh` is injectable so the paging boundaries are testable without network,
 * matching scripts/release-gate.mjs's `githubListAll` — which is also where the
 * `maxPages` ceiling and the non-array guard come from. Without the ceiling a
 * server that ignores `page` and keeps returning full pages spins until the job
 * times out; without the guard a non-array body dies as "items is not iterable"
 * instead of naming what went wrong.
 */
function fetchLifecycleIssues(repo, runGh = gh, maxPages = 20) {
  const byNumber = new Map()
  for (const label of LIFECYCLE_LABELS) {
    for (let page = 1; page <= maxPages; page++) {
      const items = JSON.parse(runGh(['api', `repos/${repo}/issues?state=open&labels=${label}&per_page=100&page=${page}`]))
      if (!Array.isArray(items)) {
        throw new Error(`GitHub API returned a non-array for open \`${label}\` issues (page ${page})`)
      }
      for (const item of items) byNumber.set(item.number, item)
      if (items.length < 100) break
      if (page === maxPages) {
        throw new Error(
          `More than ${maxPages * 100} open \`${label}\` issues — refusing to page further. ` +
            `Either the label is being applied wrongly or the API is ignoring \`page\`.`,
        )
      }
    }
  }
  return byNumber
}

function commitLogFor(range) {
  return git(['log', '--format=%s%n%b', range])
}

function isKnownCommit(sha) {
  try {
    git(['cat-file', '-e', `${sha}^{commit}`])
    return true
  } catch {
    return false
  }
}

function previousTagBefore(ref) {
  try {
    return git(['describe', '--tags', '--abbrev=0', `${ref}^`])
  } catch {
    return null
  }
}

function readPackageVersion() {
  try {
    const pkg = path.join(path.resolve(__dirname, '..'), 'package.json')
    return JSON.parse(fs.readFileSync(pkg, 'utf-8')).version || null
  } catch {
    return null
  }
}

function parseArgv(argv) {
  const out = { dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--range') out.range = argv[++i]
    else if (a === '--version') out.version = argv[++i]
    else if (a === '--repo') out.repo = argv[++i]
  }
  return out
}

function main() {
  const args = parseArgv(process.argv.slice(2))
  const dryRun = args.dryRun || process.env.DRY_RUN === '1'
  const repo = args.repo || process.env.GITHUB_REPOSITORY || gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  const after = process.env.GITHUB_SHA || git(['rev-parse', 'HEAD'])

  const range = resolveRange({
    explicit: args.range,
    before: process.env.EVENT_BEFORE,
    after,
    isKnownCommit,
    previousTag: previousTagBefore(after),
  })

  if (!range) {
    console.log('No usable commit range (no event before-sha, no previous tag). Nothing to do.')
    return
  }
  console.log(`Repo:  ${repo}`)
  console.log(`Range: ${range}${dryRun ? '   [DRY RUN]' : ''}`)

  // 1. Refs straight out of the promoted commits (PR numbers, mostly). Local
  //    git, so the 475 refs of a full release range cost nothing.
  const direct = refsFromCommitLog(commitLogFor(range))
  console.log(`\nRefs in promoted commits: ${direct.length}`)
  if (!direct.length) {
    console.log('Nothing referenced. Done.')
    return
  }

  // 2. The only issues that can possibly close, fetched once. This is what
  //    bounds the run: refs that are PRs, foreign, or unlabeled are rejected by
  //    set lookup instead of by an API call each.
  const labeled = fetchLifecycleIssues(repo)
  console.log(`Open ${LIFECYCLE_LABELS.join('/')} issues: ${labeled.size}`)

  const { matched, unmatched } = selectCandidates(direct, labeled)
  console.log(`Cited in this promotion: ${matched.length}`)

  // 3. A labeled issue that no commit cites may still be linked from a PR BODY
  //    (`Closes #NNN`), which is why this pass exists at all. It runs only when
  //    there is a shortfall to chase, and stops the moment the shortfall closes.
  if (unmatched.length) {
    console.log(`\nNot cited directly (${unmatched.length}) — expanding PR bodies: ${unmatched.map((n) => `#${n}`).join(' ')}`)
    const { found, stillMissing } = expandViaPrBodies({
      direct,
      labeled,
      unmatched,
      fetchItem: (n) => fetchItem(repo, n),
      log: (line) => console.log(line),
    })
    matched.push(...found)
    if (stillMissing.length) {
      console.log(
        `  ${stillMissing.length} labeled issue(s) are not referenced anywhere in this range and stay OPEN: ` +
          `${stillMissing.map((n) => `#${n}`).join(' ')}`,
      )
    }
  }

  const { toClose, skipped } = planClosures(matched)

  if (skipped.length) {
    console.log('\nSkipped:')
    for (const s of skipped) console.log(`  #${s.number} — ${s.reason}`)
  }

  if (!toClose.length) {
    console.log(`\nNo open \`${LIFECYCLE_LABELS.join('`/`')}\` issues in this promotion. Done.`)
    return
  }

  const version = args.version || readPackageVersion()

  console.log(`\n${dryRun ? 'Would close' : 'Closing'} ${toClose.length} issue(s):`)
  const failed = []
  for (const issue of toClose) {
    console.log(`  #${issue.number}  ${issue.title}  [${issue.closeLabel}]`)
    if (dryRun) continue
    try {
      // Comment first: if the close call fails, the issue still carries the
      // explanation rather than being silently half-processed.
      const body = closeCommentBody({ version, sha: after, range, label: issue.closeLabel })
      gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body', body])
      // Remove every lifecycle label the issue actually carries — never one it
      // doesn't, and never leave one behind on a closed issue.
      const removeFlags = issue.closeCarried.flatMap((l) => ['--remove-label', l])
      gh(['issue', 'edit', String(issue.number), '--repo', repo, ...removeFlags])
      gh(['issue', 'close', String(issue.number), '--repo', repo, '--reason', 'completed'])
    } catch (err) {
      // One issue failing must not abandon the other 127. A promotion closes a
      // whole release's worth at once, and the common failure here is GitHub's
      // secondary rate limit, which is transient — so record it, keep going, and
      // fail the job at the end with the list. Re-running is safe and resumes:
      // an already-closed or already-unlabeled issue is skipped by the filter.
      failed.push({ number: issue.number, message: (err && err.message) || String(err) })
      console.log(`    FAILED — ${failed[failed.length - 1].message.split('\n')[0]}`)
    }
    // GitHub's secondary rate limit is on CONTENT-GENERATING requests, and each
    // issue costs three of them. 128 issues is 384 calls; sent flat out that is
    // roughly double the documented ceiling and trips partway through. A short
    // pause keeps the whole promotion under it — this job is not in a hurry.
    sleepMs(THROTTLE_MS)
  }
  console.log(dryRun ? '\nDry run — nothing was changed.' : `\nClosed ${toClose.length - failed.length} of ${toClose.length}.`)
  if (failed.length) {
    throw new Error(
      `${failed.length} issue(s) could not be closed: ${failed.map((f) => `#${f.number}`).join(' ')}. ` +
        `Re-run the workflow (Close in-beta issues -> Run workflow) with the same range; it resumes safely.`,
    )
  }
}

module.exports = {
  LIFECYCLE_LABELS,
  MAX_EXPANSION_LOOKUPS,
  extractRefs,
  refsFromCommitLog,
  classifyCandidate,
  planClosures,
  selectCandidates,
  expandViaPrBodies,
  fetchLifecycleIssues,
  resolveRange,
  closeCommentBody,
  parseArgv,
}

if (require.main === module) {
  try {
    main()
  } catch (err) {
    // Fail LOUD and non-zero. Nothing depends on this job, so a red X blocks no
    // release — and the entire point of #134 is that a missed close step goes
    // unnoticed, which a silent success would reintroduce.
    console.error(`close-in-beta-issues failed: ${err && err.message ? err.message : err}`)
    process.exitCode = 1
  }
}
