#!/usr/bin/env node
/**
 * Promote an accepted release candidate to stable.
 *
 * Branching model (RC-branch model — see CONTRIBUTING.md → Branching Model):
 *   - `beta`          : perpetual feature integration, never frozen.
 *   - `release/X.Y.Z` : stabilization for one release, carrying `X.Y.Z-rc.N`.
 *   - `main`          : stable only. Receives `release/X.Y.Z` at promote time.
 *
 * What this script does:
 *   1. Verifies you're on `release/X.Y.Z`, tree is clean, in sync with origin.
 *   2. Verifies package.json is an `-rc.N` of exactly the branch's base version.
 *   3. Warns about release-branch work that was never back-ported to `beta`.
 *   4. Finds or creates the `release/X.Y.Z → main` PR and merges it.
 *   5. Syncs local main, then ships stable from main at the stripped version
 *      (`2.0.0-rc.2` → `2.0.0`).
 *
 * Usage:
 *   npm run promote           (interactive — asks before running release)
 *   npm run promote -- --yes  (no prompts, immediately releases stable)
 *   npm run promote -- --ff-only  (just promote main, don't run release)
 *
 * Requires repo-admin rights. Two ruleset rules are bypassed on the way through,
 * both by design and both only the owner can satisfy:
 *   - The PR needs a code-owner approval, and the promote PR's author IS the
 *     code owner (CODEOWNERS is `* @nubbymong`). Nobody can self-approve, so
 *     the merge lands via the owner's admin bypass.
 *   - `protect-release-lines` allows squash only. Stable promotes have always
 *     been merge commits (`Promote beta v1.4.x → main` on main's first-parent
 *     walk), which is what keeps main's history connected to the release lines;
 *     a squash would flatten the release into one commit and cut main's shared
 *     ancestry with beta. The squash-only rule predates this path and was
 *     written for feature PRs.
 *
 * After this script runs you are left on main. Delete the release branch once
 * the stable release is verified — the script does not do it for you.
 */

const { execSync } = require('child_process')
const path = require('path')
const readline = require('readline')

// Version rules live in release.js, which guards main() behind
// `require.main === module` — requiring it here imports only pure helpers.
const { parseVersion, releaseBranchBase } = require('./release.js')

const PROJECT_ROOT = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const AUTO_YES = args.includes('--yes') || args.includes('-y')
const FF_ONLY = args.includes('--ff-only')

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf-8', ...opts }).trim()
}

function runInherit(cmd) {
  execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'inherit' })
}

function ok(msg) { console.log(`      OK  ${msg}`) }
function warn(msg) { console.log(`      WARN  ${msg}`) }
function fail(msg) { console.error(`      FAIL  ${msg}`); process.exit(1) }
function step(num, total, msg) { console.log(`\n[${num}/${total}] ${msg}`) }

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, (answer) => {
      rl.close()
      resolve((answer || '').trim().toLowerCase())
    })
  })
}

// ============================================================
// PURE LOGIC (exported for unit tests — tests/unit/scripts/promote.test.ts)
// ============================================================

/**
 * The stable version a release branch promotes to, with the guards that make
 * the promote safe. Throws with an actionable message rather than returning a
 * sentinel, because every one of these is a stop-the-line condition.
 */
function stableVersionFor(branch, currentVersion) {
  const base = releaseBranchBase(branch)
  if (!base) {
    throw new Error(
      `Must be on a release branch to promote — '${branch}' is not release/X.Y.Z.\n      ` +
      `Under the RC-branch model, stable is promoted from the release branch, not from beta.`
    )
  }
  const cur = parseVersion(currentVersion)
  if (!cur) {
    throw new Error(`Cannot parse package.json version "${currentVersion}"`)
  }
  const curBase = `${cur.major}.${cur.minor}.${cur.patch}`
  if (curBase !== base) {
    throw new Error(
      `Version mismatch: ${branch} stabilizes ${base} but package.json says ${currentVersion}. ` +
      `Promoting would ship ${curBase} under a ${base} branch.`
    )
  }
  if (cur.preId !== 'rc') {
    throw new Error(
      `package.json is ${currentVersion}, which is not a release candidate. ` +
      `Cut an rc first: npm run release -- --beta`
    )
  }
  return base
}

/**
 * Commits on the release branch that never made it back to beta. The `-rc.N`
 * version bumps are expected to be release-branch-only (beta carries its own
 * version line), so they are not back-port debt. Anything else is: it would be
 * silently dropped when the release branch is deleted.
 */
function unBackportedCommits(logLines) {
  return (logLines || [])
    .map((l) => String(l).trim())
    .filter(Boolean)
    .filter((l) => !/^[0-9a-f]{7,40}\s+build\(release\):/i.test(l))
}

/**
 * The closing summary. Pure so that "did we actually ship?" is testable.
 *
 * Skipping the release leaves main merged but still carrying the -rc.N version
 * and no stable tag. Announcing "main is now stable" there is a lie told at
 * precisely the moment someone would act on it by deleting the release branch —
 * which is the one thing that makes the state unrecoverable.
 */
function promoteSummaryLines({ released, branch, rcVersion, stableVersion }) {
  if (released) {
    return [
      'Promote complete!',
      `main is now stable v${stableVersion}.`,
      '',
      'Once the release is verified, clean up:',
      `  git push origin --delete ${branch}`,
      'Feature work continues on beta (never frozen).',
    ]
  }
  return [
    'Promote INCOMPLETE — no release was shipped.',
    `main carries ${branch}'s code, but package.json still says`,
    `${rcVersion} and no v${stableVersion} tag exists.`,
    '',
    'Finish with:',
    '  npm run release -- --stable',
    `Do NOT delete ${branch} until that succeeds.`,
  ]
}

async function main() {

const TOTAL = FF_ONLY ? 5 : 6

console.log('')
console.log('  ===========================================')
console.log('    Promote release/X.Y.Z → main (stable)')
console.log('  ===========================================')

// --- Step 1: Validate starting state ---
step(1, TOTAL, 'Validating starting state...')

let currentBranch
try {
  currentBranch = run('git rev-parse --abbrev-ref HEAD')
} catch {
  fail('Not a git repository')
}

const pkgVersion = require(path.join(PROJECT_ROOT, 'package.json')).version
let stableVersion
try {
  stableVersion = stableVersionFor(currentBranch, pkgVersion)
} catch (err) {
  fail(err.message)
}
ok(`On ${currentBranch}, promoting ${pkgVersion} → ${stableVersion}`)

// Clean tree — promoting with uncommitted changes would be ambiguous.
try {
  const status = run('git status --porcelain')
  if (status.length > 0) {
    fail(
      `Working tree has uncommitted changes. Either commit them (then re-run promote) ` +
      `or stash them:\n${status.split('\n').map((l) => '         ' + l).join('\n')}`
    )
  }
  ok('Working tree clean')
} catch (err) {
  if (err.message.includes('Working tree has')) throw err
  fail(`Could not check git status: ${err.message}`)
}

try {
  run('gh auth status 2>&1')
  ok('GitHub CLI authenticated')
} catch {
  fail('GitHub CLI not authenticated. Run: gh auth login')
}

// --- Step 2: Fetch and confirm the branch is pushed ---
step(2, TOTAL, 'Fetching latest from origin...')
try {
  run(`git fetch origin ${currentBranch} main beta --tags`)
  ok(`Fetched origin/${currentBranch}, origin/main, origin/beta`)
} catch (err) {
  fail(`git fetch failed: ${err.message}`)
}

try {
  const local = run('git rev-parse HEAD')
  const remote = run(`git rev-parse origin/${currentBranch}`)
  if (local !== remote) {
    fail(
      `Local ${currentBranch} (${local.slice(0, 7)}) does not match ` +
      `origin/${currentBranch} (${remote.slice(0, 7)}). Push first.`
    )
  }
  ok(`Local ${currentBranch} matches origin`)
} catch (err) {
  if (err.message.includes('does not match')) throw err
  fail(`Could not compare refs: ${err.message}`)
}

// --- Step 3: Merge safety + back-port debt ---
step(3, TOTAL, 'Checking merge safety and back-port debt...')

// NOTE: deliberately NOT a strict-ancestor check. The old script required main
// to be an ancestor of the promoted branch, which fails permanently here: main
// carries commits the release branch does not (CODEOWNERS landed directly on
// main). A merge commit handles divergence fine, so the real question is only
// whether it conflicts.
try {
  run(`git merge-tree --write-tree origin/main origin/${currentBranch}`, { stdio: 'pipe' })
  ok('release → main merges cleanly (no conflicts)')
} catch {
  fail(
    `Merging ${currentBranch} into main produces conflicts. Resolve by merging ` +
    `main into ${currentBranch} first:\n      ` +
    `git merge origin/main && git push origin ${currentBranch}`
  )
}

try {
  const behind = run(`git rev-list --count origin/${currentBranch}..origin/main`)
  if (Number(behind) > 0) {
    ok(`main has ${behind} commit(s) not on the release branch — the merge preserves them`)
  }
} catch { /* informational only */ }

// Work that only exists on the release branch dies with the branch unless it is
// back-ported. The version bumps are expected to be release-branch-only.
try {
  const raw = run(`git log --oneline origin/beta..origin/${currentBranch}`)
  const debt = unBackportedCommits(raw ? raw.split('\n') : [])
  if (debt.length > 0) {
    warn(`${debt.length} release-branch commit(s) are NOT on beta and will be lost when it is deleted:`)
    for (const line of debt) console.log(`         ${line}`)
    warn(`Back-port them first: git checkout beta && git cherry-pick <sha>`)
  } else {
    ok('All release-branch fixes are already back-ported to beta')
  }
} catch (err) {
  warn(`Could not compute back-port debt: ${err.message}`)
}

// --- Step 4: Find/create and merge the release → main PR ---
step(4, TOTAL, `Merging ${currentBranch} → main PR...`)

let prNumber = null
try {
  const prJson = run(`gh pr list --base main --head ${currentBranch} --state open --json number,title --limit 1`)
  const prs = JSON.parse(prJson)
  if (prs.length > 0) {
    prNumber = prs[0].number
    ok(`Found open PR #${prNumber}: ${prs[0].title}`)
  } else {
    warn(`No open ${currentBranch}→main PR found — creating one now`)
    const createResult = run(
      `gh pr create --base main --head ${currentBranch} ` +
      `--title "Promote ${currentBranch} → main (stable v${stableVersion})" ` +
      `--body "Promotes the accepted release candidate ${pkgVersion} to stable v${stableVersion}."`
    )
    const match = createResult.match(/\/pull\/(\d+)/)
    if (match) {
      prNumber = parseInt(match[1], 10)
      ok(`Created PR #${prNumber}`)
    } else {
      fail(`Could not parse PR number from: ${createResult}`)
    }
  }
} catch (err) {
  fail(`PR lookup/creation failed: ${err.message}`)
}

// Merge commit, matching every prior promote on main's first-parent walk.
try {
  run(`gh pr merge ${prNumber} --merge --subject "Promote ${currentBranch} → main (stable v${stableVersion})" --delete-branch=false`)
  ok(`Merged PR #${prNumber} into main`)
} catch (err) {
  fail(
    `PR merge failed: ${err.message}\n      ` +
    `This step needs repo-admin bypass: the promote PR requires a code-owner\n      ` +
    `approval its own author cannot give, and the ruleset allows squash only.\n      ` +
    `If gh refuses on a stale BLOCKED state, the REST call takes the same path:\n      ` +
    `gh api -X PUT repos/nubbymong/claude-command-center/pulls/${prNumber}/merge -f merge_method=merge`
  )
}

// --- Step 5: Sync local main after the remote merge ---
step(5, TOTAL, 'Syncing local main after merge...')
try {
  run('git fetch origin main')
  run('git checkout main')
  run('git reset --hard origin/main')
  ok('Local main updated to match origin/main')
} catch (err) {
  fail(`Could not sync local main: ${err.message}`)
}

if (FF_ONLY) {
  console.log('')
  console.log('  ===========================================')
  console.log('    Main is promoted. Ship the release with:')
  console.log('      npm run release -- --stable')
  console.log(`    Then delete the branch: git push origin --delete ${currentBranch}`)
  console.log('  ===========================================')
  process.exit(0)
}

// --- Step 6: Ship stable release ---
step(6, TOTAL, 'Shipping stable release from main...')

let confirm = 'y'
if (!AUTO_YES) {
  confirm = await ask(`      Run \`npm run release -- --stable\` now (ships v${stableVersion})? (y/N): `)
}

let released = false
if (confirm === 'y' || confirm === 'yes') {
  try {
    // No --no-bump: release.js derives the stable version by stripping the rc
    // suffix. Reusing the version verbatim would tag stable as v2.0.0-rc.2.
    runInherit('node scripts/release.js --stable')
    released = true
    ok('Stable release dispatched')
  } catch {
    fail('Release failed — check the output above')
  }
} else {
  console.log('')
  console.log('  Skipped release.')
}

// The old script merged main back into beta here. Under the RC-branch model
// that is wrong: beta is already ahead on its own version line (e.g. 2.1.0-beta.N
// while main lands 2.0.0), so the merge conflicts on package.json and leaves a
// half-merged beta behind. Release-branch fixes reach beta by back-port instead,
// which step 3 verifies.
console.log('')
console.log('  ===========================================')
for (const line of promoteSummaryLines({
  released,
  branch: currentBranch,
  rcVersion: pkgVersion,
  stableVersion,
})) {
  console.log(line ? `    ${line}` : '')
}
console.log('  ===========================================')

}

// Pure-logic exports for unit testing. Guarded so `require()` from a test does
// NOT run a promote.
module.exports = {
  stableVersionFor,
  unBackportedCommits,
  promoteSummaryLines,
}

if (require.main === module) {
  main()
}
