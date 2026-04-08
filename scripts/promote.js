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

// Clean tree — promoting with uncommitted changes would be ambiguous
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
  warn(`Could not check git status: ${err.message}`)
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

// Verify main exists locally
try {
  run('git rev-parse --verify main')
} catch {
  // Create local main tracking origin/main if it doesn't exist
  run('git branch main origin/main')
  ok('Created local main branch tracking origin/main')
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
    // Check: is main an ancestor of beta? (i.e. can we fast-forward?)
    try {
      run(`git merge-base --is-ancestor main beta`)
      const ahead = run('git rev-list --count main..beta')
      ok(`Main can fast-forward to beta (${ahead} commit(s) ahead)`)
    } catch {
      fail(
        `Cannot fast-forward: beta has diverged from main. This means main has commits ` +
        `not on beta (e.g. a hotfix landed directly on main). Resolve by merging main ` +
        `into beta first: git checkout beta && git merge main && git push`
      )
    }
  }
} catch (err) {
  if (err.message.includes('Cannot fast-forward')) throw err
  fail(`Ancestry check failed: ${err.message}`)
}

// --- Step 4: Fast-forward main to beta ---
step(4, TOTAL, 'Fast-forwarding main to beta...')
try {
  run('git checkout main')
  run('git merge --ff-only beta')
  ok('Fast-forwarded main → beta')
} catch (err) {
  fail(`Fast-forward failed: ${err.message}`)
}

// --- Step 5: Push main ---
step(5, TOTAL, 'Pushing main to origin...')
try {
  run('git push origin main 2>&1', { timeout: 60000 })
  ok('Pushed main to origin')
} catch (err) {
  fail(`Push failed: ${err.message}`)
}

if (FF_ONLY) {
  console.log('')
  console.log('  ===========================================')
  console.log('    Main is promoted. Run the release manually:')
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

console.log('')
console.log('  ===========================================')
console.log('    Promote complete. Remember to:')
console.log('      git checkout beta')
console.log('    ... before continuing feature work.')
console.log('  ===========================================')

})()
