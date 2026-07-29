#!/usr/bin/env node
/**
 * Close `in-beta` issues covered by a promotion to `main`.
 *
 * Under the RC-branch model, fixes merge to `beta` long before they ship. An
 * issue therefore stays OPEN with the `in-beta` label until its change promotes
 * to `main` (see CONTRIBUTING.md -> "Issue lifecycle"). This script performs the
 * close-on-promotion step that was manual until now (#134).
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
 * is currently OPEN, and carries the `in-beta` label. Anything else is skipped
 * and reported.
 */

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const LABEL = 'in-beta'
// Ceiling on API lookups. A promotion spans one release; hundreds of distinct
// refs means the range is wrong (e.g. a fallback that reached back too far), and
// we would rather do nothing than hammer the API on a bad range.
const MAX_CANDIDATES = 200

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
  if (!labels.includes(LABEL)) return { action: 'skip', reason: `not labeled ${LABEL}` }
  if (item.state !== 'open') return { action: 'skip', reason: `already ${item.state}` }
  return { action: 'close' }
}

/** Split candidates into a close list and an annotated skip list. */
function planClosures(items) {
  const toClose = []
  const skipped = []
  for (const item of items) {
    const verdict = classifyCandidate(item)
    if (verdict.action === 'close') toClose.push(item)
    else skipped.push({ number: item && item.number, reason: verdict.reason })
  }
  return { toClose, skipped }
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

/** Comment left on each issue as it closes. */
function closeCommentBody({ version, sha, range }) {
  const shipped = version ? `**v${version}**` : 'a stable release'
  const lines = [
    `Shipped to \`main\` in ${shipped}${sha ? ` (${sha.slice(0, 7)})` : ''}.`,
    '',
    `The fix was on \`beta\` and in testing (labeled \`${LABEL}\`); it has now promoted to`,
    '`main`, so this is closed as completed.',
  ]
  if (range) lines.push('', `<sub>Closed automatically from the promotion range \`${range}\`.</sub>`)
  return lines.join('\n')
}

// ── i/o ────────────────────────────────────────────────────────────

function git(args) {
  return execFileSync('git', args, { encoding: 'utf-8' }).trim()
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

  // 1. Refs straight out of the promoted commits (PR numbers, mostly).
  const direct = refsFromCommitLog(commitLogFor(range))
  console.log(`\nRefs in promoted commits: ${direct.length ? direct.map((n) => `#${n}`).join(' ') : '(none)'}`)
  if (!direct.length) {
    console.log('Nothing referenced. Done.')
    return
  }

  // 2. Fetch each, and for anything that turns out to be a PR, harvest the refs
  //    in its title+body too (that's where `Closes #NNN` lives). One level deep:
  //    a PR's linked issues, not an issue's onward references.
  const fetched = new Map()
  const queue = [...direct]
  const seen = new Set()
  while (queue.length) {
    if (seen.size >= MAX_CANDIDATES) {
      console.log(`\nRefusing to look up more than ${MAX_CANDIDATES} refs — the range looks wrong. Nothing changed.`)
      return
    }
    const n = queue.shift()
    if (seen.has(n)) continue
    seen.add(n)
    const item = fetchItem(repo, n)
    fetched.set(n, item)
    if (item && item.pull_request) {
      for (const ref of extractRefs(`${item.title || ''}\n${item.body || ''}`)) {
        if (!seen.has(ref)) queue.push(ref)
      }
    }
  }

  // Keep unresolvable refs in the list (as `notFound`) so the report accounts for
  // every ref harvested — a silently-dropped ref is indistinguishable from one
  // that was never seen, which is exactly the blind spot #134 is about.
  const items = [...fetched.entries()].map(([n, item]) => item || { number: n, notFound: true })
  const { toClose, skipped } = planClosures(items)

  if (skipped.length) {
    console.log('\nSkipped:')
    for (const s of skipped) console.log(`  #${s.number} — ${s.reason}`)
  }

  if (!toClose.length) {
    console.log(`\nNo open \`${LABEL}\` issues in this promotion. Done.`)
    return
  }

  const version = args.version || readPackageVersion()
  const body = closeCommentBody({ version, sha: after, range })

  console.log(`\n${dryRun ? 'Would close' : 'Closing'} ${toClose.length} issue(s):`)
  for (const issue of toClose) {
    console.log(`  #${issue.number}  ${issue.title}`)
    if (dryRun) continue
    // Comment first: if the close call fails, the issue still carries the
    // explanation rather than being silently half-processed.
    gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body', body])
    gh(['issue', 'edit', String(issue.number), '--repo', repo, '--remove-label', LABEL])
    gh(['issue', 'close', String(issue.number), '--repo', repo, '--reason', 'completed'])
  }
  console.log(dryRun ? '\nDry run — nothing was changed.' : '\nDone.')
}

module.exports = {
  LABEL,
  MAX_CANDIDATES,
  extractRefs,
  refsFromCommitLog,
  classifyCandidate,
  planClosures,
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
