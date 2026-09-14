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
 * Over-collecting candidates is deliberately safe. The FAIL-SAFE is the filter,
 * not the harvest: a candidate is only ever closed if it is an issue (not a PR),
 * is currently OPEN, and carries the `in-beta` or `in-release` label. Anything
 * else is skipped and reported.
 *
 * Why the LABEL SET drives the lookups, not the refs: a promotion range is as
 * long as a release. `v2.0.0..main` for 2.1.0 spans 775 commits carrying 476
 * distinct refs — almost all of them PR numbers. Fetching every ref to discover
 * that 348 of them are pull requests is both slow and, at one API call each,
 * enough to bite the Actions token's hourly budget. Worse, the old ceiling
 * `return`ed without closing anything, so the single run that matters most —
 * the first stable promotion in months — would have silently closed nothing.
 * So: list the open `in-beta`/`in-release` issues once (bounded by how many
 * issues carry the label, which is inherently small), intersect with the refs
 * harvested from the commit log for free, and pay for a PR-body lookup only
 * when a labeled issue was NOT cited directly.
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
// closed nothing, which is the failure mode that made a 476-ref promotion a
// no-op.)
const MAX_EXPANSION_LOOKUPS = 200

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
 */
function fetchLifecycleIssues(repo) {
  const byNumber = new Map()
  for (const label of LIFECYCLE_LABELS) {
    for (let page = 1; ; page++) {
      const raw = gh(['api', `repos/${repo}/issues?state=open&labels=${label}&per_page=100&page=${page}`])
      const items = JSON.parse(raw)
      for (const item of items) byNumber.set(item.number, item)
      if (items.length < 100) break
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
  //    git, so the 476 refs of a full release range cost nothing.
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
    const wanted = new Set(unmatched)
    let lookups = 0
    for (const n of direct) {
      if (!wanted.size) break
      if (labeled.has(n)) continue
      if (lookups >= MAX_EXPANSION_LOOKUPS) {
        console.log(`  Stopped after ${MAX_EXPANSION_LOOKUPS} lookups with ${wanted.size} still unaccounted for.`)
        break
      }
      lookups++
      const item = fetchItem(repo, n)
      if (!item || !item.pull_request) continue
      for (const ref of extractRefs(`${item.title || ''}\n${item.body || ''}`)) {
        if (!wanted.has(ref)) continue
        wanted.delete(ref)
        matched.push(labeled.get(ref))
      }
    }
    if (wanted.size) {
      console.log(
        `  ${wanted.size} labeled issue(s) are not referenced anywhere in this range and stay OPEN: ` +
          `${[...wanted].sort((a, b) => a - b).map((n) => `#${n}`).join(' ')}`,
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
  for (const issue of toClose) {
    console.log(`  #${issue.number}  ${issue.title}  [${issue.closeLabel}]`)
    if (dryRun) continue
    // Comment first: if the close call fails, the issue still carries the
    // explanation rather than being silently half-processed.
    const body = closeCommentBody({ version, sha: after, range, label: issue.closeLabel })
    gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body', body])
    // Remove every lifecycle label the issue actually carries — never one it
    // doesn't, and never leave one behind on a closed issue.
    const removeFlags = issue.closeCarried.flatMap((l) => ['--remove-label', l])
    gh(['issue', 'edit', String(issue.number), '--repo', repo, ...removeFlags])
    gh(['issue', 'close', String(issue.number), '--repo', repo, '--reason', 'completed'])
  }
  console.log(dryRun ? '\nDry run — nothing was changed.' : '\nDone.')
}

module.exports = {
  LIFECYCLE_LABELS,
  MAX_EXPANSION_LOOKUPS,
  extractRefs,
  refsFromCommitLog,
  classifyCandidate,
  planClosures,
  selectCandidates,
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
