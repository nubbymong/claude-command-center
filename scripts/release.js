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
 *   4. Update changelog.ts version line
 *   5. Typecheck + unit tests + build smoke test
 *   6. Git commit + tag + push
 *
 * Remote (GitHub Actions) steps:
 *   7. Dispatch the .github/workflows/release.yml workflow
 *   8. Watch the workflow run to completion
 *   9. Verify the final release has both .exe and .dmg attached
 *
 * Usage:
 *   npm run release                 (interactive channel prompt, patch bump)
 *   npm run release -- --beta       (force beta channel)
 *   npm run release -- --stable     (force stable channel)
 *   npm run release -- --dev        (force dev channel — experimental)
 *   npm run release -- --minor      (minor version bump)
 *   npm run release -- --major      (major version bump)
 *   npm run release -- --skip-tests (skip local typecheck + vitest)
 *   npm run release -- --skip-build (skip local build smoke test)
 *   npm run release -- --skip-watch (don't wait for workflow to finish)
 *   npm run release -- --skip-push  (everything except commit/push/dispatch)
 *
 * Notes:
 *   - VirusTotal scanning is part of the GitHub Actions workflow, not local.
 *     The workflow scans BOTH the .exe and the .dmg.
 *   - Changelog generation is hand-authored. Edit src/renderer/changelog.ts to
 *     add a new entry BEFORE running this script. The script will update the
 *     version field of the first entry to match the bumped version.
 *   - The workflow is dispatched on the current branch (typically main).
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
const BUMP_MINOR = args.includes('--minor')
const BUMP_MAJOR = args.includes('--major')
const FORCE_BETA = args.includes('--beta')
const FORCE_STABLE = args.includes('--stable')
const FORCE_DEV = args.includes('--dev')

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

function tagFor(version, channel) {
  switch (channel) {
    case 'beta': return `v${version}-beta`
    case 'dev':  return `v${version}-dev`
    default:     return `v${version}`
  }
}

// ============================================================
// MAIN
// ============================================================

;(async () => {

const TOTAL_STEPS = 9
let exitCode = 0

const channel = await pickChannel()
header(`Claude Command Center Beta\n  Release channel: ${channel.toUpperCase()}`)

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
if (currentBranch !== 'main') {
  warn(`On branch '${currentBranch}' — workflow will dispatch on this branch, not main`)
}
ok(`Current branch: ${currentBranch}`)

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

// --- Step 2: Version bump ---
step(2, TOTAL_STEPS, 'Incrementing version...')

const pkgPath = path.join(PROJECT_ROOT, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
const oldVersion = pkg.version
const parts = oldVersion.split('.').map(Number)

if (BUMP_MAJOR) {
  parts[0] += 1; parts[1] = 0; parts[2] = 0
} else if (BUMP_MINOR) {
  parts[1] += 1; parts[2] = 0
} else {
  parts[2] = (parts[2] || 0) + 1
}

const version = parts.join('.')
pkg.version = version
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8')

const tag = tagFor(version, channel)

console.log('')
console.log(`      v${oldVersion} → v${version}  (tag: ${tag}, channel: ${channel})`)

// --- Step 3: Sync changelog version ---
step(3, TOTAL_STEPS, 'Aligning changelog version with bumped version...')

const changelogPath = path.join(PROJECT_ROOT, 'src', 'renderer', 'changelog.ts')
try {
  let changelogContent = fs.readFileSync(changelogPath, 'utf-8')
  // Match the FIRST `version: '...'` entry — that's the topmost (newest) entry
  const versionRegex = /version:\s*'(\d+\.\d+\.\d+)'/
  const match = changelogContent.match(versionRegex)
  if (!match) {
    warn('Could not locate first version entry in changelog.ts')
  } else if (match[1] === version) {
    ok(`Changelog already on v${version}`)
  } else {
    changelogContent = changelogContent.replace(versionRegex, `version: '${version}'`)
    fs.writeFileSync(changelogPath, changelogContent, 'utf-8')
    ok(`Changelog version: v${match[1]} → v${version}`)
    warn('Hand-author the changelog body BEFORE the next release for accurate notes')
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
    run(`git commit -m "Release v${version}"`)
    ok(`Committed: Release v${version}`)
  } else {
    ok('Nothing to commit')
  }

  // Tag — clean up any pre-existing tag with the same name (rare edge case)
  try {
    run(`git tag ${tag}`)
    ok(`Tagged: ${tag}`)
  } catch {
    warn(`Tag ${tag} may already exist locally — continuing`)
  }

  console.log('      Pushing to origin...')
  run(`git push origin ${currentBranch} --tags 2>&1`, { timeout: 60000 })
  ok(`Pushed ${currentBranch} + tags to origin`)
} catch (err) {
  fail(`Git push failed: ${err.message}`)
}

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
    const hasChecksums = names.some((n) => n.toLowerCase().includes('checksum'))

    console.log(`      Release URL: ${release.url}`)
    console.log(`      Assets: ${names.join(', ')}`)
    if (hasExe) ok('Windows installer (.exe) attached')
    else { warn('Windows installer NOT found'); exitCode = 1 }
    if (hasDmg) ok('macOS installer (.dmg) attached')
    else { warn('macOS installer NOT found'); exitCode = 1 }
    if (hasChecksums) ok('CHECKSUMS.txt attached')
    else warn('CHECKSUMS.txt not found (workflow normally generates this)')
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

})()
