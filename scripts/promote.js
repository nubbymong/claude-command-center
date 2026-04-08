#!/usr/bin/env node
/**
 * Promote the current beta to a stable release.
 *
 * Branching model:
 *   - `beta` is the working branch where all features land.
 *   - `main` is stable-only — it only receives fast-forwards from beta.
 *
 * What this script does:
 *   1. Verifies you're on `beta`, tree is clean, `main` is a strict ancestor.
 *   2. Fetches the latest state of both branches from origin.
 *   3. Fast-forwards local `main` to match `beta`.
 *   4. Pushes `main` to origin.
 *   5. Optionally runs `node scripts/release.js --stable --no-bump` from main
 *      to ship a stable release at the same version as the current beta.
 *
 * Usage:
 *   npm run promote           (interactive — asks before running release)
 *   npm run promote -- --yes  (no prompts, immediately releases stable)
 *   npm run promote -- --ff-only  (just FF main, don't run release)
 *
 * After this script runs, you'll be left on `main` with the stable release
 * either shipped (default) or ready to ship (--ff-only). In either case,
 * remember to `git checkout beta` before continuing feature work.
 */

const { execSync } = require('child_process')
const path = require('path')
const readline = require('readline')

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

;(async () => {

const TOTAL = FF_ONLY ? 5 : 6

console.log('')
console.log('  ===========================================')
console.log('    Promote beta → main (stable release)')
console.log('  ===========================================')

// --- Step 1: Validate starting state ---
step(1, TOTAL, 'Validating starting state...')

let currentBranch
try {
  currentBranch = run('git rev-parse --abbrev-ref HEAD')
} catch {
  fail('Not a git repository')
}

if (currentBranch !== 'beta') {
  fail(`Must be on the 'beta' branch to promote — currently on '${currentBranch}'. Run: git checkout beta`)
}
ok(`On beta branch`)

// Clean tree — promoting with uncommitted changes would be ambiguous.
// If the status check itself fails (git unavailable, corrupt repo, etc.),
// treat it as a hard failure: we can't safely promote without confirming
// the working tree is clean, since later steps (checkout main, push) could
// either fail mid-flow or accidentally promote uncommitted work.
try {
  const status = run('git status --porcelain')
  if (status.length > 0) {
    fail(
      `Working tree has uncommitted changes. Either commit them on beta (then re-run promote) ` +
      `or stash them:\n${status.split('\n').map((l) => '         ' + l).join('\n')}`
    )
  }
  ok('Working tree clean')
} catch (err) {
  if (err.message.includes('Working tree has')) throw err
  fail(`Could not check git status: ${err.message}`)
}

// gh auth
try {
  run('gh auth status 2>&1')
  ok('GitHub CLI authenticated')
} catch {
  fail('GitHub CLI not authenticated. Run: gh auth login')
}

// --- Step 2: Fetch latest from origin ---
step(2, TOTAL, 'Fetching latest from origin...')
try {
  run('git fetch origin beta main --tags')
  ok('Fetched origin/beta, origin/main, and tags')
} catch (err) {
  fail(`git fetch failed: ${err.message}`)
}

// Verify local beta is in sync with origin/beta
try {
  const localBeta = run('git rev-parse beta')
  const originBeta = run('git rev-parse origin/beta')
  if (localBeta !== originBeta) {
    fail(
      `Local beta (${localBeta.slice(0, 7)}) does not match origin/beta (${originBeta.slice(0, 7)}). ` +
      `Push or reset beta first.`
    )
  }
  ok('Local beta matches origin/beta')
} catch (err) {
  if (err.message.includes('Local beta')) throw err
  fail(`Could not compare beta refs: ${err.message}`)
}

// Ensure local main exists and is in sync with origin/main before we touch it.
// A stale or diverged local main can break the ancestry check or result in a
// surprising push (promoting an unexpected history). We hard-reset local main
// to origin/main — this is safe because the promote flow only ever
// fast-forwards main to beta; there should never be local-only commits on main
// that we want to preserve. If a user has made local commits to main they
// didn't push, that's a workflow violation the reset cleanly recovers from.
try {
  run('git rev-parse --verify main')
} catch {
  // Create a local main tracking origin/main if it doesn't exist yet
  run('git branch --track main origin/main')
  ok('Created local main branch tracking origin/main')
}

try {
  const localMain = run('git rev-parse main')
  const originMain = run('git rev-parse origin/main')
  if (localMain !== originMain) {
    run('git branch -f main origin/main')
    ok(`Reset local main from ${localMain.slice(0, 7)} to origin/main (${originMain.slice(0, 7)})`)
  } else {
    ok('Local main matches origin/main')
  }
} catch (err) {
  fail(`Could not synchronize main with origin/main: ${err.message}`)
}

// --- Step 3: Verify main is strictly behind beta ---
step(3, TOTAL, 'Checking that main is a strict ancestor of beta...')
try {
  const mainSha = run('git rev-parse main')
  const betaSha = run('git rev-parse beta')

  if (mainSha === betaSha) {
    warn('main is already at beta — nothing to promote')
    if (FF_ONLY) process.exit(0)
    // Fall through to release step — maybe they want to re-ship stable
  } else {
    // Check: is main an ancestor of beta? (i.e. can we merge cleanly?)
    try {
      run(`git merge-base --is-ancestor main beta`)
      const ahead = run('git rev-list --count main..beta')
      ok(`Beta is ${ahead} commit(s) ahead of main — ready to merge`)
    } catch {
      fail(
        `Cannot merge: beta has diverged from main. This means main has commits ` +
        `not on beta (e.g. a hotfix landed directly on main). Resolve by merging main ` +
        `into beta first: git checkout beta && git merge main && git push`
      )
    }
  }
} catch (err) {
  if (err.message.includes('Cannot merge')) throw err
  fail(`Ancestry check failed: ${err.message}`)
}

// --- Step 4: Find and merge the beta→main PR ---
step(4, TOTAL, 'Merging beta → main PR...')

let prNumber = null
try {
  const prJson = run('gh pr list --base main --head beta --state open --json number,title --limit 1')
  const prs = JSON.parse(prJson)
  if (prs.length > 0) {
    prNumber = prs[0].number
    ok(`Found open PR #${prNumber}: ${prs[0].title}`)
  } else {
    // No PR exists — create one on the fly so the merge is recorded as a PR event
    warn('No open beta→main PR found — creating one now')
    const version = run("node -e \"console.log(require('./package.json').version)\"")
    const createResult = run(
      `gh pr create --base main --head beta ` +
      `--title "Beta v${version} → stable promotion" ` +
      `--body "Automated promotion from beta to main for stable release v${version}."`
    )
    // Extract PR number from the URL returned by gh pr create
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

// Merge the PR with a merge commit (Style A — visible "promoted" marker in history)
try {
  run(`gh pr merge ${prNumber} --merge --subject "Promote beta → main (stable)" --delete-branch=false`)
  ok(`Merged PR #${prNumber} into main`)
} catch (err) {
  fail(`PR merge failed: ${err.message}`)
}

// --- Step 5: Sync local main after the remote merge ---
step(5, TOTAL, 'Syncing local main after merge...')
try {
  run('git fetch origin main')
  run('git branch -f main origin/main')
  ok('Local main updated to match origin/main')
} catch (err) {
  fail(`Could not sync local main: ${err.message}`)
}

if (FF_ONLY) {
  console.log('')
  console.log('  ===========================================')
  console.log('    Main is promoted. Run the release manually:')
  console.log('      git checkout main')
  console.log('      npm run release -- --stable --no-bump')
  console.log('    Then: git checkout beta')
  console.log('  ===========================================')
  process.exit(0)
}

// --- Step 6: Ship stable release ---
step(6, TOTAL, 'Shipping stable release from main...')

let confirm = 'y'
if (!AUTO_YES) {
  confirm = await ask('      Run `npm run release -- --stable --no-bump` now? (y/N): ')
}

if (confirm === 'y' || confirm === 'yes') {
  try {
    // Checkout main for the release script's branch enforcement check
    run('git checkout main')
    ok('Switched to main branch')
    runInherit('node scripts/release.js --stable --no-bump')
    ok('Stable release dispatched')
  } catch {
    fail('Release failed — check the output above')
  }
} else {
  console.log('')
  console.log('  Skipped release. To ship stable manually:')
  console.log('    npm run release -- --stable --no-bump')
}

// Switch back to beta so the user is on the correct branch for continued work
try {
  run('git checkout beta')
  ok('Switched back to beta branch')
} catch {
  warn('Could not switch back to beta — run `git checkout beta` manually')
}

console.log('')
console.log('  ===========================================')
console.log('    Promote complete!')
console.log('    You are on the beta branch, ready for')
console.log('    continued feature work.')
console.log('  ===========================================')

})()
