#!/usr/bin/env node
// seed-dev-accounts.mjs — copy signed-in account credentials from the PROD
// install into the DEV data dir (#257).
//
// WHY THIS EXISTS. `ccc --seed` copies only `resources\CONFIG`, and credentials
// live in `resources\account-profiles\<id>\` — a sibling of CONFIG. So there was
// no supported way to get a working set of signed-in accounts into dev, and a dev
// instance whose own profile homes had drifted (empty tokens, or a home whose
// identity no longer matches `profiles.json`) could not be repaired from inside
// dev: `restoreProfileHomeFromCanonical` reads dev's own canonical backup, which
// drifts with it. Prod holds the only good copy.
//
// DIRECTION IS ONE-WAY AND ASSERTED. Prod is opened read-only and every write
// target is checked to live under the dev data dir before it is touched — a bug
// here would corrupt the user's real accounts, so containment is verified rather
// than assumed.
//
// KNOWN LIMITATION, printed at runtime: dev and prod end up holding the SAME
// refresh token. Whichever refreshes first rotates it and invalidates the other's
// copy (see src/shared/account-auth.ts:44-46). Re-running this script is the
// documented recovery; it is a repeatable convenience, not a permanent fix, and
// it can break PROD if dev refreshes first.
//
// Usage:
//   node scripts/seed-dev-accounts.mjs [--dry-run] [--no-labels] [--force]
//
//   --dry-run    report what would change; write nothing
//   --no-labels  do not copy profiles.json (keep dev's own account labels)
//   --force      proceed even if a dev instance appears to be running
//
// Exit codes: 0 ok (or nothing to do), 1 refused / failed.

import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'

const args = new Set(process.argv.slice(2))
const DRY = args.has('--dry-run')
const NO_LABELS = args.has('--no-labels')
const FORCE = args.has('--force')

/** Same shape the app enforces for a profile id, which is also a directory name. */
const PROFILE_ID_RE = /^profile-[a-z0-9-]{1,64}$/

/** Per-profile files that carry identity and tokens. Relative to the home. */
const PROFILE_FILES = [
  '.claude.json',
  join('.claude', '.credentials.json'),
  join('identity', '.claude.json'),
  join('identity', '.credentials.json'),
]

const DEV_PORT = 5173

function log(...m) { console.log('[seed]', ...m) }
function die(...m) { console.error('[seed] REFUSED:', ...m); process.exit(1) }

/**
 * Prod's resources dir, resolved the same way `ccc.cmd --seed` resolves it:
 * the installer's registry value first, then the default location.
 */
function prodResourcesDir() {
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Claude Command Center', '/v', 'ResourcesDirectory'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const m = out.match(/ResourcesDirectory\s+REG_\w+\s+(.+)/)
    const v = m?.[1]?.trim()
    if (v) return v
  } catch { /* not installed, or no such value */ }
  return join(process.env.LOCALAPPDATA ?? '', 'Claude Command Center', 'resources')
}

function devDataDir() {
  return process.env.CCC_DEV_DATA_DIR
    ?? join(process.env.LOCALAPPDATA ?? '', 'Claude Command Center', 'dev')
}

/** True when something is listening on the dev vite port. */
async function devIsRunning() {
  return new Promise((done) => {
    const s = connect({ host: '127.0.0.1', port: DEV_PORT })
    const finish = (v) => { try { s.destroy() } catch { /* ignore */ } done(v) }
    s.setTimeout(700)
    s.once('connect', () => finish(true))
    s.once('timeout', () => finish(false))
    s.once('error', () => finish(false))
  })
}

function readJson(f) {
  try { return JSON.parse(readFileSync(f, 'utf-8')) } catch { return null }
}

/** The account a home claims to be, from its own .claude.json. */
function emailOf(f) {
  if (!existsSync(f)) return '-'
  const e = readJson(f)?.oauthAccount?.emailAddress
  return typeof e === 'string' && e ? e : '(none)'
}

/** Whether a credentials file actually carries a token, without reading one. */
function credState(f) {
  if (!existsSync(f)) return 'none'
  const o = readJson(f)?.claudeAiOauth
  if (!o) return 'unreadable'
  return o.accessToken ? 'token' : 'EMPTY'
}

function describe(root, id) {
  const home = join(root, id)
  return {
    id,
    home: emailOf(join(home, '.claude.json')),
    canonical: emailOf(join(home, 'identity', '.claude.json')),
    cred: credState(join(home, '.claude', '.credentials.json')),
    canonCred: credState(join(home, 'identity', '.credentials.json')),
  }
}

function table(title, root, ids) {
  log(title)
  if (!ids.length) { log('  (none)'); return }
  const pad = (s, n) => String(s).padEnd(n)
  log(`  ${pad('profile', 26)} ${pad('home', 26)} ${pad('canonical', 26)} ${pad('cred', 7)} canonCred`)
  for (const id of ids) {
    const d = describe(root, id)
    log(`  ${pad(d.id, 26)} ${pad(d.home, 26)} ${pad(d.canonical, 26)} ${pad(d.cred, 7)} ${d.canonCred}`)
  }
}

/** Refuse any destination that is not inside the dev data dir. */
function assertUnderDev(target, dev) {
  const t = resolve(target)
  const d = resolve(dev)
  if (t !== d && !t.startsWith(d + sep)) {
    die(`write target escapes the dev data dir:\n    ${t}\n    not under ${d}`)
  }
  return t
}

function copyInto(src, dst, dev, backupDir, relForBackup) {
  assertUnderDev(dst, dev)
  if (DRY) return 'would copy'
  // Preserve whatever dev had, so a bad seed is recoverable.
  if (existsSync(dst)) {
    const b = assertUnderDev(join(backupDir, relForBackup), dev)
    mkdirSync(join(b, '..'), { recursive: true })
    copyFileSync(dst, b)
  }
  mkdirSync(join(dst, '..'), { recursive: true })
  copyFileSync(src, dst)
  return 'copied'
}

async function main() {
  const prodRes = prodResourcesDir()
  const dev = devDataDir()
  const devRes = join(dev, 'resources')
  const prodAcc = join(prodRes, 'account-profiles')
  const devAcc = join(devRes, 'account-profiles')

  log(`prod resources: ${prodRes}`)
  log(`dev data dir:   ${dev}`)

  if (!existsSync(prodAcc)) die(`prod account-profiles not found at ${prodAcc}`)
  if (resolve(prodRes) === resolve(devRes)) {
    die('prod and dev resolve to the SAME resources dir; refusing to copy onto itself')
  }
  if (!existsSync(devRes)) die(`dev resources dir not found at ${devRes}. Start dev once first.`)

  // A dry run writes nothing, so a running dev instance is irrelevant to it —
  // and refusing to even REPORT while dev is up makes the tool useless exactly
  // when someone is trying to work out why dev looks wrong.
  if (!DRY && await devIsRunning()) {
    if (!FORCE) {
      die(`a dev instance appears to be running (port ${DEV_PORT} is open).\n`
        + '    Close it first: it caches auth state in memory and will rewrite these\n'
        + '    files on exit, silently undoing the seed. Use --force to override.')
    }
    log(`WARNING: dev appears to be running and --force was given; the seed may be overwritten.`)
  }

  const prodIds = readdirSync(prodAcc)
    .filter((n) => PROFILE_ID_RE.test(n))
    .filter((n) => { try { return statSync(join(prodAcc, n)).isDirectory() } catch { return false } })
    .sort()
  if (!prodIds.length) die(`no profile directories in ${prodAcc}`)

  const devIds = existsSync(devAcc)
    ? readdirSync(devAcc).filter((n) => PROFILE_ID_RE.test(n)).sort()
    : []

  table('BEFORE — prod:', prodAcc, prodIds)
  table('BEFORE — dev:', devAcc, devIds)

  const onlyInDev = devIds.filter((id) => !prodIds.includes(id))
  if (onlyInDev.length) {
    log(`note: ${onlyInDev.length} profile(s) exist only in dev and are left untouched: ${onlyInDev.join(', ')}`)
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(devRes, '_seed-backups', stamp)

  let copied = 0
  let skipped = 0
  for (const id of prodIds) {
    for (const rel of PROFILE_FILES) {
      const src = join(prodAcc, id, rel)
      if (!existsSync(src)) { skipped++; continue }
      const dst = join(devAcc, id, rel)
      const what = copyInto(src, dst, dev, backupDir, join(id, rel))
      copied++
      log(`  ${what}: ${id}\\${rel}`)
    }
  }

  // profiles.json carries the id -> accountEmail labels. Copying it keeps dev's
  // labels consistent with the credentials just seeded; --no-labels keeps dev's.
  if (!NO_LABELS) {
    const src = join(prodAcc, 'profiles.json')
    if (existsSync(src)) {
      const what = copyInto(src, join(devAcc, 'profiles.json'), dev, backupDir, 'profiles.json')
      log(`  ${what}: profiles.json`)
      copied++
    }
  } else {
    log('note: --no-labels given; dev keeps its own profiles.json')
  }

  if (DRY) {
    log(`DRY RUN — nothing written. ${copied} file(s) would be copied, ${skipped} absent in prod.`)
    return
  }

  log(`copied ${copied} file(s); ${skipped} absent in prod.`)
  log(`dev's previous versions are in: ${backupDir}`)
  table('AFTER — dev:', devAcc, readdirSync(devAcc).filter((n) => PROFILE_ID_RE.test(n)).sort())

  log('')
  log('IMPORTANT: dev and prod now hold the SAME refresh token. Whichever refreshes')
  log('first rotates it and invalidates the other copy, so dev will eventually show')
  log('logged-out accounts again — re-run this script to recover. It can also break')
  log('PROD if dev refreshes first. Nothing here writes to prod.')
}

main().catch((err) => {
  console.error('[seed] failed:', err?.message ?? err)
  process.exit(1)
})
