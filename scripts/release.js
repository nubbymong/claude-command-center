#!/usr/bin/env node
/**
 * Claude Command Center Release Script (workflow-dispatch edition)
 *
 * Unified release pipeline. Local script does fast checks + version bump + push,
 * then dispatches the GitHub Actions workflow for the canonical dual-platform
 * build (Windows EXE + macOS DMG, both signed/notarized, both VirusTotal-scanned,
 * single GitHub release with checksums).
 *
 * Local steps (fast feedback before pushing):
 *   1. Pre-flight checks (gh auth, npm audit, git status)
 *   2. Channel selection (stable / beta / dev)
 *   3. Version bump
 *   4. Update changelog.ts version + date of the newest entry, regenerate CHANGELOG.md
 *   5. Typecheck + unit tests + build smoke test
 *   6. Git commit + tag + push
 *
 * Remote (GitHub Actions) steps:
 *   7. Dispatch the .github/workflows/release.yml workflow
 *   8. Watch the workflow run to completion
 *   9. Verify the final release has both .exe and .dmg attached
 *
 * Branching model (RC-branch model — see CONTRIBUTING.md → Branching Model):
 *   - `beta`          : perpetual feature integration, NEVER frozen.
 *                       Carries `X.Y.Z-beta.N`. Beta/dev releases cut here.
 *   - `release/X.Y.Z` : stabilization for one release; fixes only, no features.
 *                       Carries `X.Y.Z-rc.N`. RC releases cut here, on the beta
 *                       channel (`-beta.N` and `-rc.N` both ride beta updates).
 *   - `main`          : stable only. Carries the bare `X.Y.Z`. Reached by
 *                       merging `release/X.Y.Z` → main via `npm run promote`.
 *
 * Version rules:
 *   - The prerelease identifier comes from the BRANCH, not the channel:
 *     beta → `-beta.N`, release/X.Y.Z → `-rc.N`, main → none.
 *   - Default bump increments the prerelease counter ONLY; the base version is
 *     never touched implicitly. Use --major/--minor/--patch to move the base
 *     (beta only — a release branch's base is pinned by its name).
 *   - Stable strips the prerelease: `2.0.0-rc.2` ships as `2.0.0`.
 *
 * Usage:
 *   npm run release                 (interactive channel prompt; bumps -rc.N/-beta.N)
 *   npm run release -- --beta       (force beta channel — on `beta` or `release/X.Y.Z`)
 *   npm run release -- --stable     (force stable channel — must be on main branch)
 *   npm run release -- --dev        (force dev channel — must be on beta branch)
 *   npm run release -- --minor      (minor base bump, resets prerelease to .1)
 *   npm run release -- --major      (major base bump, resets prerelease to .1)
 *   npm run release -- --patch      (patch base bump, resets prerelease to .1)
 *   npm run release -- --no-bump    (reuse current version verbatim — escape hatch)
 *   npm run release -- --skip-tests (skip local typecheck + vitest)
 *   npm run release -- --skip-build (skip local build smoke test)
 *   npm run release -- --skip-watch (don't wait for workflow to finish)
 *   npm run release -- --skip-push  (everything except commit/push/dispatch)
 *   npm run release -- --skip-branch-check  (bypass branch ↔ channel enforcement)
 *
 * Notes:
 *   - VirusTotal scanning is part of the GitHub Actions workflow, not local.
 *     The workflow scans BOTH the .exe and the .dmg.
 *   - Changelog generation is hand-authored. Edit src/renderer/changelog.ts to
 *     add a new entry BEFORE running this script. The script then aligns the
 *     FIRST (newest) entry with the release being cut: it rewrites both the
 *     `version` field to the bumped version AND the `date` field to today's
 *     LOCAL date, then regenerates CHANGELOG.md so the generated file cannot go
 *     stale in the release commit (the `Changelog in sync` CI gate would
 *     otherwise fail on the release itself).
 *     So both fields in a pending entry are placeholders — write whatever is
 *     reasonable and let the release correct them. Before #157 only `version`
 *     was synced, so an entry authored days earlier shipped stale-dated.
 *   - This script does NOT create or push a git tag. release.yml creates the tag
 *     via `gh release create --target $GITHUB_SHA`, pinning it to the commit it
 *     actually built. A pre-pushed tag would defeat that and can strand the
 *     release on a stale commit (see src/main/github-update.ts).
 */

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const readline = require('readline')

const PROJECT_ROOT = path.resolve(__dirname, '..')

const args = process.argv.slice(2)
const SKIP_TESTS = args.includes('--skip-tests')
const SKIP_BUILD = args.includes('--skip-build')
const SKIP_WATCH = args.includes('--skip-watch')
const SKIP_PUSH = args.includes('--skip-push')
const SKIP_BRANCH_CHECK = args.includes('--skip-branch-check')
const NO_BUMP = args.includes('--no-bump')
const BUMP = args.includes('--major') ? 'major'
  : args.includes('--minor') ? 'minor'
  : args.includes('--patch') ? 'patch'
  : null
const FORCE_BETA = args.includes('--beta')
const FORCE_STABLE = args.includes('--stable')
const FORCE_DEV = args.includes('--dev')

// ============================================================
// PURE LOGIC (exported for unit tests — see tests/unit/scripts/release.test.ts)
// ============================================================

/**
 * Parse `X.Y.Z` or `X.Y.Z-<id>.<n>`. Returns null for anything else, including
 * a bare `-beta` with no counter (the retired v1 TAG shape, never a version).
 */
function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?$/.exec(String(version || '').trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    preId: m[4] || null,
    preNum: m[5] === undefined ? null : Number(m[5]),
  }
}

/** `release/2.0.0` or `release/v2.0.0` → `2.0.0`. Anything else → null. */
function releaseBranchBase(branch) {
  const m = /^release\/v?(\d+\.\d+\.\d+)$/.exec(String(branch || '').trim())
  return m ? m[1] : null
}

/**
 * The prerelease identifier is a property of the BRANCH, never the channel.
 * That keeps `--dev` from minting a `-dev.N` version on beta and colliding with
 * the `-beta.N` line: dev is a presentation choice made by release.yml, not a
 * separate version series.
 */
function preIdForBranch(branch) {
  if (branch === 'beta') return 'beta'
  if (releaseBranchBase(branch)) return 'rc'
  return null // main → stable, no prerelease
}

/**
 * Channel → allowed branch. `beta` accepts BOTH `beta` and any `release/X.Y.Z`
 * because -beta.N and -rc.N both ride the beta update channel.
 */
function branchAllowsChannel(branch, channel) {
  if (channel === 'stable') return branch === 'main'
  if (channel === 'dev') return branch === 'beta'
  if (channel === 'beta') return branch === 'beta' || releaseBranchBase(branch) !== null
  return false
}

/** Human-readable answer to "where should I be to cut this?" */
function branchHintFor(channel) {
  if (channel === 'stable') return 'main'
  if (channel === 'dev') return 'beta'
  return 'beta or release/X.Y.Z'
}

/**
 * Next version for (current, branch, channel, bump).
 *
 * Default = increment the prerelease counter. The base version NEVER moves
 * implicitly: the old script defaulted to a patch bump, which on `2.1.0-beta.0`
 * produced `2.1.1-...` for a 2.1.0 that had not shipped yet.
 */
function nextVersion(currentVersion, { branch, channel, bump = null } = {}) {
  const cur = parseVersion(currentVersion)
  if (!cur) {
    throw new Error(`Cannot parse version "${currentVersion}" (expected 2.0.0 or 2.0.0-rc.2)`)
  }

  // Stable ships the accepted candidate's base version unchanged — the code is
  // identical to the RC, only the tag differs.
  if (channel === 'stable') {
    if (bump) throw new Error(`--${bump} is not valid for a stable release: stable ships the RC's base version unchanged`)
    return `${cur.major}.${cur.minor}.${cur.patch}`
  }

  const base = releaseBranchBase(branch)
  if (base) {
    if (bump) {
      throw new Error(`--${bump} is not valid on ${branch}: a release branch stabilizes exactly ${base}. Cut a new release branch instead.`)
    }
    // The branch NAME is the source of truth for the base version, not
    // package.json — this is what stops a stray `2.1.0-rc.1` from being cut on
    // release/2.0.0. A first rc cut from beta (2.0.0-beta.6) starts at rc.1.
    const b = parseVersion(base)
    const sameBase = cur.major === b.major && cur.minor === b.minor && cur.patch === b.patch
    const n = sameBase && cur.preId === 'rc' ? cur.preNum + 1 : 1
    return `${base}-rc.${n}`
  }

  const preId = preIdForBranch(branch)
  if (!preId) {
    throw new Error(`Branch "${branch}" is not a release line (expected beta or release/X.Y.Z)`)
  }

  let { major, minor, patch } = cur
  if (bump === 'major') { major += 1; minor = 0; patch = 0 }
  else if (bump === 'minor') { minor += 1; patch = 0 }
  else if (bump === 'patch') { patch += 1 }

  // Moving the base, or switching identifier, restarts the counter at .1.
  const n = !bump && cur.preId === preId ? cur.preNum + 1 : 1
  return `${major}.${minor}.${patch}-${preId}.${n}`
}

// ============================================================
// HELPERS
// ============================================================

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: PROJECT_ROOT, encoding: 'utf-8', ...opts }).trim()
}

function runInherit(cmd) {
  execSync(cmd, { cwd: PROJECT_ROOT, stdio: 'inherit' })
}

function step(num, total, msg) {
  console.log(`\n[${num}/${total}] ${msg}`)
}

function ok(msg) {
  console.log(`      OK  ${msg}`)
}

function warn(msg) {
  console.log(`      WARN  ${msg}`)
}

function fail(msg) {
  console.error(`      FAIL  ${msg}`)
  process.exit(1)
}

function header(msg) {
  console.log('')
  console.log('  ===========================================')
  for (const line of msg.split('\n')) {
    console.log(`    ${line}`)
  }
  console.log('  ===========================================')
}

// Cross-platform sleep. Uses Node's setTimeout instead of shelling out to
// `timeout` (Windows) / `sleep` (POSIX) — the Windows `timeout` builtin
// requires a terminal and fails silently inside execSync with stdio: 'ignore'.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pickChannel() {
  return new Promise((resolve) => {
    if (FORCE_STABLE) return resolve('stable')
    if (FORCE_BETA) return resolve('beta')
    if (FORCE_DEV) return resolve('dev')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    rl.question('Release channel? (s)table / (b)eta / (d)ev: ', (answer) => {
      rl.close()
      const a = (answer || '').trim().toLowerCase()
      if (a === 'd' || a === 'dev') return resolve('dev')
      if (a === 's' || a === 'stable') return resolve('stable')
      // Default to beta for safety — most releases are betas
      resolve('beta')
    })
  })
}

/**
 * MUST stay identical to release.yml → "Determine version". The workflow owns
 * tag creation; this is only used to pre-clean a stale release and to verify
 * assets afterwards. If the two disagree, the script cleans/verifies a tag that
 * does not exist while the workflow publishes one nobody checked.
 *
 * A version carrying a prerelease suffix IS the tag (v2.0.0-rc.2) — appending a
 * second channel suffix would give the v2.0.0-rc.2-beta nonsense the old code
 * produced. The channel-suffixed form is the retired v1 scheme (v1.5.45-beta),
 * kept only so a bare version still tags correctly.
 */
function tagFor(version, channel) {
  if (String(version).includes('-')) return `v${version}`
  switch (channel) {
    case 'beta': return `v${version}-beta`
    case 'dev':  return `v${version}-dev`
    default:     return `v${version}`
  }
}

/**
 * Today's date as YYYY-MM-DD in LOCAL time.
 *
 * Deliberately not `toISOString().slice(0, 10)`: that is UTC, and for anyone west
 * of Greenwich an evening release would stamp TOMORROW's date. In Denver
 * (UTC-6/-7) any release after ~17:00 local would be off by a day — silently, and
 * in a user-visible file.
 *
 * `now` is injectable so the behaviour is testable without faking the clock.
 */
function todayIso(now = new Date()) {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * Align the FIRST (newest) changelog.ts entry with the release being cut.
 *
 * Entries are hand-authored BEFORE the release, so both fields drift: the version
 * is whatever the author guessed the next bump would be, and the date is whatever
 * day they wrote it. `beta` is never frozen, so a pending entry can sit for a week
 * and then ship stale-dated (#157). Both are rewritten here.
 *
 * Pure: takes and returns source text, so the regex behaviour is unit-testable.
 * The inline version of this logic was untested and had already corrupted an old
 * entry once — see the prerelease-suffix note below.
 *
 * Both regexes REQUIRE quotes, which is what keeps them off the `ChangelogEntry`
 * interface at the top of the file (`version: string`, `date: string` — unquoted).
 * The version pattern must also carry the optional prerelease suffix: without it
 * the match skipped past `2.0.0-rc.2` at the top and rewrote the first BARE
 * version found (a historical `2.0.0` entry), corrupting an old entry while
 * reporting success and leaving the real one stale.
 *
 * @returns {{ok: false, reason: string} | {ok: true, content: string, prevVersion: string, prevDate: string|null, versionChanged: boolean, dateChanged: boolean}}
 */
function syncChangelogEntry(source, version, date) {
  const versionRegex = /version:\s*'(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+\.\d+)?)'/
  const dateRegex = /date:\s*'(\d{4}-\d{2}-\d{2})'/

  const vMatch = String(source).match(versionRegex)
  if (!vMatch) return { ok: false, reason: 'no version entry found' }
  const dMatch = String(source).match(dateRegex)

  const versionChanged = vMatch[1] !== version
  const dateChanged = !!dMatch && dMatch[1] !== date

  let content = source
  if (versionChanged) content = content.replace(versionRegex, `version: '${version}'`)
  if (dateChanged) content = content.replace(dateRegex, `date: '${date}'`)

  return {
    ok: true,
    content,
    prevVersion: vMatch[1],
    prevDate: dMatch ? dMatch[1] : null,
    versionChanged,
    dateChanged,
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {

const TOTAL_STEPS = 9
let exitCode = 0

const channel = await pickChannel()
header(`Claude Command Center Beta\n  Release channel: ${channel.toUpperCase()}`)

// --- Pre-release reminder (must be acknowledged) ---
console.log('')
console.log('  ┌─────────────────────────────────────────────┐')
console.log('  │          PRE-RELEASE CHECKLIST               │')
console.log('  │                                              │')
console.log('  │  Before shipping, confirm you have:          │')
console.log('  │                                              │')
console.log('  │  □ Updated tips in tips-library.ts if any    │')
console.log('  │    new features were added this release      │')
console.log('  │  □ Added trackUsage() calls for new features │')
console.log('  │  □ Updated changelog.ts with release notes   │')
console.log('  │  □ Tested new features visually in dev mode  │')
console.log('  │                                              │')
console.log('  └─────────────────────────────────────────────┘')
console.log('')

await new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.question('  Press Enter to acknowledge and continue (or Ctrl+C to abort): ', () => {
    rl.close()
    resolve()
  })
})

// --- Step 1: Pre-flight checks ---
step(1, TOTAL_STEPS, 'Pre-flight checks...')

// gh auth
try {
  run('gh auth status 2>&1')
  ok('GitHub CLI authenticated')
} catch {
  fail('GitHub CLI not authenticated. Run: gh auth login')
}

// npm audit (non-fatal warning)
try {
  const auditResult = run('npm audit --audit-level=critical 2>&1 || true')
  if (auditResult.includes('critical')) {
    fail('npm audit found CRITICAL vulnerabilities. Fix before releasing.')
  }
  ok('npm audit clean (no critical vulnerabilities)')
} catch {
  warn('npm audit check failed (non-fatal)')
}

// Verify the workflow file exists
const workflowPath = path.join(PROJECT_ROOT, '.github', 'workflows', 'release.yml')
if (!fs.existsSync(workflowPath)) {
  fail(`Workflow not found at ${workflowPath}`)
}
ok('Workflow file present')

// Determine current branch — workflow is dispatched on this branch
let currentBranch = 'main'
try {
  currentBranch = run('git rev-parse --abbrev-ref HEAD')
} catch {
  warn('Could not detect current branch, defaulting to main')
}
ok(`Current branch: ${currentBranch}`)

// Enforce branch ↔ channel correspondence to prevent shipping beta code as
// stable (or vice versa). `--skip-branch-check` exists for emergencies but
// should not be used in normal operation.
const branchOk = branchAllowsChannel(currentBranch, channel)
if (!SKIP_BRANCH_CHECK && !branchOk) {
  fail(
    `Channel '${channel}' must be released from ${branchHintFor(channel)}, ` +
    `but current branch is '${currentBranch}'.\n      ` +
    `(or pass --skip-branch-check to bypass — not recommended)`
  )
}
if (SKIP_BRANCH_CHECK && !branchOk) {
  warn(`Branch check skipped: releasing ${channel} from '${currentBranch}' (expected ${branchHintFor(channel)})`)
}
if (releaseBranchBase(currentBranch)) {
  ok(`Release branch stabilizing ${releaseBranchBase(currentBranch)} — cutting an rc`)
}

// Git status (uncommitted changes will be included in the release commit)
try {
  const status = run('git status --porcelain')
  if (status.length > 0) {
    const lineCount = status.split('\n').length
    warn(`${lineCount} uncommitted change(s) (will be included in release commit)`)
  } else {
    ok('Git working tree clean')
  }
} catch {
  warn('Git status check failed (non-fatal)')
}

// --- Step 2: Version bump (or reuse) ---
step(2, TOTAL_STEPS, NO_BUMP ? 'Reusing current version (--no-bump)...' : 'Incrementing version...')

const pkgPath = path.join(PROJECT_ROOT, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
const oldVersion = pkg.version

let version
if (NO_BUMP) {
  // Escape hatch: reuse package.json verbatim. The promote flow no longer needs
  // this — a stable release derives its version by stripping the RC suffix.
  version = oldVersion
} else {
  try {
    version = nextVersion(oldVersion, { branch: currentBranch, channel, bump: BUMP })
  } catch (err) {
    fail(err.message)
  }
  pkg.version = version
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')

  // Regenerate package-lock.json so its version field matches the bumped
  // package.json. Without this, the lockfile keeps the OLD version while
  // package.json has the new one -- npm ci on a clean checkout would either
  // refuse or install with the stale version. Surfaced by Codex review on
  // v1.5.0-beta: live tree had package.json@1.5.0 + package-lock.json@1.4.3.
  // --package-lock-only skips actual node_modules install (~10s -> <1s).
  // --ignore-scripts avoids running lifecycle scripts mid-release.
  // --no-audit / --no-fund silence noise we already gate elsewhere.
  try {
    run('npm install --package-lock-only --ignore-scripts --no-audit --no-fund', { stdio: 'pipe' })
    ok(`package-lock.json regenerated at v${version}`)
  } catch (err) {
    warn(`Failed to regenerate package-lock.json (continuing anyway): ${err.message}`)
  }
}

const tag = tagFor(version, channel)

console.log('')
console.log(`      ${NO_BUMP ? `v${version} (reused)` : `v${oldVersion} → v${version}`}  (tag: ${tag}, channel: ${channel})`)

// --- Step 3: Sync changelog version + date ---
step(3, TOTAL_STEPS, 'Aligning changelog version and date with this release...')

const changelogPath = path.join(PROJECT_ROOT, 'src', 'renderer', 'changelog.ts')
try {
  const changelogContent = fs.readFileSync(changelogPath, 'utf-8')
  const releaseDate = todayIso()
  const sync = syncChangelogEntry(changelogContent, version, releaseDate)
  if (!sync.ok) {
    warn(`Could not locate first version entry in changelog.ts (${sync.reason})`)
  } else if (!sync.versionChanged && !sync.dateChanged) {
    ok(`Changelog already on v${version} (${releaseDate})`)
  } else {
    fs.writeFileSync(changelogPath, sync.content, 'utf-8')
    if (sync.versionChanged) ok(`Changelog version: v${sync.prevVersion} → v${version}`)
    if (sync.dateChanged) ok(`Changelog date: ${sync.prevDate} → ${releaseDate}`)
    // Regenerate so CHANGELOG.md carries the corrected version/date. Without
    // this the `Changelog in sync` CI gate fails on the release commit itself:
    // the generated file still holds the pre-sync values.
    try {
      run('node scripts/gen-changelog.js')
      ok('CHANGELOG.md regenerated')
    } catch (err) {
      warn(`CHANGELOG.md regeneration failed — run 'npm run changelog' before committing (${err.message})`)
    }
    if (sync.versionChanged) {
      warn('Hand-author the changelog body BEFORE the next release for accurate notes')
    }
  }
} catch (err) {
  warn(`Changelog sync skipped: ${err.message}`)
}

// --- Step 4: Local smoke tests (fast feedback before pushing to CI) ---
step(4, TOTAL_STEPS, 'Local smoke tests (typecheck + unit tests + build)...')

if (SKIP_TESTS) {
  warn('Skipped (--skip-tests)')
} else {
  try {
    runInherit('npx tsc --noEmit')
    ok('Typecheck passed')
  } catch {
    fail('TYPECHECK FAILED — fix before releasing')
  }
  try {
    runInherit('npx vitest run')
    ok('Unit tests passed')
  } catch {
    fail('UNIT TESTS FAILED — fix before releasing')
  }
}

if (SKIP_BUILD) {
  warn('Build skipped (--skip-build)')
} else {
  try {
    runInherit('npx electron-vite build')
    ok('Build succeeded (smoke test only — installer will be built in CI)')
  } catch {
    fail('BUILD FAILED — fix before releasing')
  }
}

// --- Step 5: Git commit + tag + push ---
step(5, TOTAL_STEPS, 'Git commit, tag, push...')

if (SKIP_PUSH) {
  warn('Skipped (--skip-push) — workflow will not be dispatched')
  process.exit(0)
}

try {
  run('git add -A')
  const staged = run('git diff --cached --stat 2>&1 || echo ""')
  if (staged.length > 0) {
    run(`git commit -m "build(release): ${version}"`)
    ok(`Committed: build(release): ${version}`)
  } else {
    ok('Nothing to commit')
  }

  // No `git tag` here on purpose. release.yml creates the tag with
  // `gh release create --target $GITHUB_SHA`, pinning it to the commit CI
  // actually built. Pre-pushing a tag hands `gh release create` an existing ref
  // and defeats --target, which is how betas ended up stranded on a stale
  // created_at and invisible to the in-app updater.
  console.log('      Pushing to origin...')
  run(`git push origin ${currentBranch} 2>&1`, { timeout: 60000 })
  ok(`Pushed ${currentBranch} to origin (tag ${tag} will be created by the workflow)`)
} catch (err) {
  fail(`Git push failed: ${err.message}`)
}

// The old Step 6 created/updated a rolling `beta → main` PR on every beta
// release. Under the RC-branch model beta never promotes to main directly —
// stabilization goes to release/X.Y.Z first — so that PR tracked a merge that
// must not happen (it is what left #30 open and stale). The promotion PR is
// now `release/X.Y.Z → main`, created by `npm run promote` at promote time.

// --- Step 6: Pre-clean any existing GitHub release for this tag ---
step(6, TOTAL_STEPS, 'Checking for stale GitHub release...')
try {
  const existing = run(`gh release view ${tag} --json tagName -q .tagName 2>&1 || echo ""`)
  if (existing.trim() === tag) {
    warn(`A release for ${tag} already exists — deleting so the workflow can recreate cleanly`)
    run(`gh release delete ${tag} --yes`)
    ok('Stale release deleted (tag preserved)')
  } else {
    ok('No existing release for this tag')
  }
} catch (err) {
  warn(`Could not check/delete existing release: ${err.message}`)
}

// --- Step 7: Dispatch GitHub Actions workflow ---
step(7, TOTAL_STEPS, 'Dispatching GitHub Actions release workflow...')

try {
  run(`gh workflow run release.yml --ref ${currentBranch} -f channel=${channel} -f skip_vt=false`)
  ok(`Workflow dispatched (channel=${channel}, ref=${currentBranch})`)
} catch (err) {
  fail(`Workflow dispatch failed: ${err.message}`)
}

// Wait briefly for the run to register, then find the run ID.
// Note the dispatched run won't appear instantly — GitHub queues it first,
// so we poll for up to ~20 seconds.
let runId = ''
let lastPollError = ''
console.log('      Waiting for run to register...')
for (let attempt = 0; attempt < 10; attempt++) {
  await sleep(2000)
  try {
    const json = run('gh run list --workflow=release.yml --limit 5 --json databaseId,status,headBranch,event,createdAt')
    const runs = JSON.parse(json)
    // Take the most recent workflow_dispatch run — it's the one we just fired.
    // (Filtering by branch is unreliable because the API may return runs from
    // older dispatches on the same branch before our new one appears.)
    const dispatched = runs
      .filter((r) => r.event === 'workflow_dispatch')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    if (dispatched.length > 0 && (dispatched[0].status === 'in_progress' || dispatched[0].status === 'queued')) {
      runId = String(dispatched[0].databaseId)
      break
    }
  } catch (err) {
    lastPollError = err.message
  }
}

if (!runId) {
  warn(`Could not detect dispatched run ID${lastPollError ? ` (${lastPollError})` : ''}`)
  ok(`Check the Actions tab manually: https://github.com/nubbymong/claude-command-center/actions/workflows/release.yml`)
} else {
  ok(`Run ID: ${runId}`)
  ok(`Run URL: https://github.com/nubbymong/claude-command-center/actions/runs/${runId}`)
}

// --- Step 8: Watch the workflow to completion ---
step(8, TOTAL_STEPS, 'Watching workflow run...')

if (SKIP_WATCH || !runId) {
  warn(SKIP_WATCH ? 'Skipped (--skip-watch)' : 'No run ID — cannot watch')
} else {
  console.log('      Streaming run status (may take 5-10 minutes for both platforms)...')
  console.log('')
  try {
    runInherit(`gh run watch ${runId} --exit-status --interval 15`)
    ok('Workflow completed successfully')
  } catch {
    warn('Workflow failed or was cancelled — check the Actions tab')
    exitCode = 1
  }
}

// --- Step 9: Verify final release has both platforms ---
step(9, TOTAL_STEPS, 'Verifying release artifacts...')

if (exitCode !== 0) {
  warn('Skipping verification because workflow did not complete cleanly')
} else {
  try {
    // Wait a few seconds for the release to be visible after workflow completion
    await sleep(3000)
    const releaseJson = run(`gh release view ${tag} --json assets,url -q "{url: .url, names: [.assets[].name]}"`)
    const release = JSON.parse(releaseJson)
    const names = release.names || []
    const hasExe = names.some((n) => n.endsWith('.exe'))
    const hasDmg = names.some((n) => n.endsWith('.dmg'))
    const hasAppImage = names.some((n) => n.endsWith('.AppImage'))
    // Exact name: the client hard-codes literal 'CHECKSUMS.txt' in both the
    // derived URL and `gh release download --pattern`, so a checksums.txt or a
    // CHECKSUMS.txt.sig would pass this gate and still fail every update.
    const hasChecksums = names.includes('CHECKSUMS.txt')

    console.log(`      Release URL: ${release.url}`)
    console.log(`      Assets: ${names.join(', ')}`)
    if (hasExe) ok('Windows installer (.exe) attached')
    else { warn('Windows installer NOT found'); exitCode = 1 }
    if (hasDmg) ok('macOS installer (.dmg) attached')
    else { warn('macOS installer NOT found'); exitCode = 1 }
    if (hasAppImage) ok('Linux AppImage attached')
    else { warn('Linux AppImage NOT found'); exitCode = 1 }
    if (hasChecksums) ok('CHECKSUMS.txt attached')
    else fail('CHECKSUMS.txt not attached -- the in-app updater REFUSES to install\n        a release it cannot verify (#111), so publishing without it ships a\n        release nobody can auto-update to.')
  } catch (err) {
    warn(`Could not verify release: ${err.message}`)
    exitCode = 1
  }
}

// --- Done ---
header(
  exitCode === 0
    ? `${channel.toUpperCase()} Release v${version} complete!\n  Tag: ${tag}`
    : `Release completed with warnings.\n  Tag: ${tag}`
)

process.exit(exitCode)

}

// Pure-logic exports for unit testing. Guarded so `require()` from a test does
// NOT dispatch a release.
module.exports = {
  parseVersion,
  releaseBranchBase,
  preIdForBranch,
  branchAllowsChannel,
  branchHintFor,
  nextVersion,
  tagFor,
  todayIso,
  syncChangelogEntry,
}

if (require.main === module) {
  main()
}
