#!/usr/bin/env node
// Session isolation guard.
//
// Problem: several Claude Code sessions run against this repo at once. Left
// alone they land in the same checkout, switch its branch under each other,
// and commit onto a ref another session is mid-way through. That has already
// happened here (a PR branch that carried three commits belonging to nobody).
//
// Model: one session = one worktree = one branch, all branched from a shared
// base. Git already refuses to check out one branch in two worktrees, so the
// branch ref is the hard interlock; this script adds the bookkeeping git has
// no opinion about -- who owns which worktree, and whether that owner is still
// alive.
//
// Leases live in <git-common-dir>/ccc-sessions/, which every linked worktree
// shares and git never tracks. Identity is CLAUDE_CODE_SESSION_ID; liveness is
// CLAUDE_PID.
//
//   node scripts/session-guard.mjs claim [--base <ref>] [--slug <s>]
//   node scripts/session-guard.mjs verify [--path <dir>]
//   node scripts/session-guard.mjs status | list | reap
//   node scripts/session-guard.mjs release [--remove-worktree]
//   node scripts/session-guard.mjs hook            (PreToolUse; JSON on stdin)
//
// Escape hatch: CCC_SESSION_GUARD=off disables the hook's blocking.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const GUARD_OFF = (process.env.CCC_SESSION_GUARD || '').toLowerCase() === 'off'

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'pipe'],
    cwd: opts.cwd || process.cwd(),
  }).trim()
}

function gitSafe(args, opts = {}) {
  try {
    return git(args, { ...opts, quiet: true })
  } catch {
    return null
  }
}

/** Compare paths the way the filesystem does: real case-insensitively on win/mac. */
function samePath(a, b) {
  if (!a || !b) return false
  const norm = (p) => {
    let r = path.resolve(p).replace(/[\\/]+$/, '')
    try {
      r = fs.realpathSync.native(r)
    } catch {
      /* not on disk (yet) -- fall back to the lexical form */
    }
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

function sessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || null
}

function shortId(id) {
  return (id || '').split('-')[0] || 'unknown'
}

/** Alive-check that never signals. Verified on Windows: signal 0 does not terminate. */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM = exists but owned by another user, which still counts as alive.
    return e.code === 'EPERM'
  }
}

function leaseDir(cwd) {
  const common = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  if (!common) return null
  const dir = path.join(common, 'ccc-sessions')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * How long a lease stays credible after its last heartbeat, once its recorded
 * pid is gone. CLAUDE_PID is NOT stable for the life of a session -- resuming
 * after /exit keeps CLAUDE_CODE_SESSION_ID but gets a new process -- so a pid
 * check alone declares live sessions dead. Every guard invocation refreshes the
 * caller's own lease (touchLease), which makes the hook a natural heartbeat.
 */
const HEARTBEAT_GRACE_MS = 30 * 60 * 1000

function readLeases(cwd) {
  const dir = leaseDir(cwd)
  if (!dir) return []
  const out = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    try {
      const lease = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
      lease._file = path.join(dir, f)
      lease._pidAlive = pidAlive(lease.pid)
      const beat = Date.parse(lease.renewedAt || lease.createdAt || '')
      lease._fresh = Number.isFinite(beat) && Date.now() - beat < HEARTBEAT_GRACE_MS
      // Live if the recorded process is still there OR the lease was touched
      // recently -- the latter covers a session that changed pid on resume.
      lease._alive = lease._pidAlive || lease._fresh
      // A worktree the user deleted by hand leaves an orphan lease behind.
      lease._present = !!lease.worktree && fs.existsSync(lease.worktree)
      out.push(lease)
    } catch {
      /* a torn or hand-edited lease is treated as absent */
    }
  }
  return out
}

/**
 * Re-stamp this session's own lease with the current pid and timestamp. Called
 * at the top of every command so any activity keeps the lease credible. Never
 * touches another session's lease.
 */
function touchLease(cwd) {
  const me = sessionId()
  if (!me) return
  try {
    const dir = leaseDir(cwd)
    if (!dir) return
    const file = path.join(dir, `${me}.json`)
    if (!fs.existsSync(file)) return
    const lease = JSON.parse(fs.readFileSync(file, 'utf8'))
    const pid = Number(process.env.CLAUDE_PID) || process.ppid
    lease.pid = pid
    lease.renewedAt = new Date().toISOString()
    fs.writeFileSync(file, JSON.stringify(lease, null, 2))
  } catch {
    /* a heartbeat failure must never break the caller */
  }
}

/** The worktree root containing p, or null when p is not in a work tree. */
function worktreeRoot(p) {
  let probe = path.resolve(p)
  // Walk up to the nearest existing dir -- a file_path may not exist yet.
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe)
  if (!fs.existsSync(probe)) return null
  if (fs.statSync(probe).isFile()) probe = path.dirname(probe)
  const top = gitSafe(['rev-parse', '--path-format=absolute', '--show-toplevel'], { cwd: probe })
  return top || null
}

/**
 * Ownership of the worktree containing targetPath.
 * kind: mine | other | stale | unmanaged | not-a-repo
 */
function ownership(targetPath, cwdForGit) {
  const root = worktreeRoot(targetPath)
  if (!root) return { kind: 'not-a-repo', root: null }
  const me = sessionId()
  const leases = readLeases(cwdForGit || root)
  const lease = leases.find((l) => samePath(l.worktree, root))
  if (!lease) return { kind: 'unmanaged', root }
  if (me && lease.sessionId === me) return { kind: 'mine', root, lease }
  if (!lease._alive) return { kind: 'stale', root, lease }
  return { kind: 'other', root, lease }
}

// ---------------------------------------------------------------- commands

/** True when dir is the repo's primary checkout rather than a linked worktree. */
function isPrimaryWorktree(dir) {
  const gitDir = gitSafe(['rev-parse', '--path-format=absolute', '--git-dir'], { cwd: dir })
  const common = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dir })
  return !!gitDir && !!common && samePath(gitDir, common)
}

/**
 * Take ownership of a worktree that already exists -- one made by hand, or by
 * Claude Code's own --worktree / EnterWorktree. Without this those arrive
 * "unmanaged" and the hook blocks them forever.
 */
function cmdAdopt(args) {
  const me = sessionId()
  if (!me) fail('CLAUDE_CODE_SESSION_ID is not set -- cannot identify this session.')

  const target = argValue(args, '--path') || process.cwd()
  const root = worktreeRoot(target)
  if (!root) fail(`${target} is not inside a git work tree.`)
  if (isPrimaryWorktree(root)) {
    fail(
      `refusing to adopt ${root} -- that is the repository's primary checkout.\n` +
        '  Shared checkouts must stay unowned so no session can fence others out of them.\n' +
        '  Create an isolated one instead:  node scripts/session-guard.mjs claim --base beta',
    )
  }

  const existingForMe = readLeases(process.cwd()).find((l) => l.sessionId === me)
  if (existingForMe && !samePath(existingForMe.worktree, root)) {
    fail(`this session already holds ${existingForMe.worktree}. Release it first:\n  node scripts/session-guard.mjs release`)
  }

  const o = ownership(root, process.cwd())
  if (o.kind === 'mine') {
    print(renderClaim(o.lease, 'already yours'))
    return
  }
  if (o.kind === 'other') fail(explain(o, root))
  if (o.kind === 'stale') {
    print(`  clearing stale lease from session ${shortId(o.lease.sessionId)} (pid ${o.lease.pid}, not running)`)
    fs.unlinkSync(o.lease._file)
  }

  const branch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }) || 'HEAD'
  if (branch === 'HEAD') fail(`${root} is on a detached HEAD -- check out a session branch there first.`)

  const lease = {
    sessionId: me,
    multiSessionId: process.env.CLAUDE_MULTI_SESSION_ID || null,
    pid: Number(process.env.CLAUDE_PID) || process.ppid,
    worktree: root,
    branch,
    base: argValue(args, '--base') || null,
    startPoint: null,
    host: os.hostname(),
    createdAt: new Date().toISOString(),
    adopted: true,
  }
  fs.writeFileSync(path.join(leaseDir(process.cwd()), `${me}.json`), JSON.stringify(lease, null, 2), { flag: 'wx' })
  print(renderClaim(lease, 'adopted'))
}

function cmdClaim(args) {
  const me = sessionId()
  if (!me) fail('CLAUDE_CODE_SESSION_ID is not set -- cannot identify this session.')
  if (args.includes('--adopt')) return cmdAdopt(args)

  const base = argValue(args, '--base') || 'beta'
  const slug = argValue(args, '--slug') || ''
  const short = shortId(me)

  // Re-claim is a no-op: report the existing worktree instead of making a second.
  const existing = readLeases(process.cwd()).find((l) => l.sessionId === me)
  if (existing && existing._present) {
    print(renderClaim(existing, 'already claimed'))
    return
  }

  const mainRoot = gitSafe(['rev-parse', '--path-format=absolute', '--show-toplevel'])
  if (!mainRoot) fail('run this from inside the repository (or a worktree of it).')

  const branch = slug ? `session/${base}/${short}-${slug}` : `session/${base}/${short}`
  // Anchor sibling worktrees to the PRIMARY checkout, never to whatever worktree
  // we happen to be standing in -- otherwise claiming from inside one nests
  // ccc-wt/ccc-wt/... one level deeper every time.
  const commonDir = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const primaryRoot = commonDir ? path.dirname(commonDir) : mainRoot
  const wtRoot = process.env.CCC_WT_ROOT || path.join(path.dirname(primaryRoot), 'ccc-wt')
  const dir = path.join(wtRoot, slug ? `${short}-${slug}` : short)

  // Prefer the remote base so a session never inherits another session's local drift.
  const startPoint = gitSafe(['rev-parse', '--verify', '--quiet', `origin/${base}`]) ? `origin/${base}` : base
  if (!gitSafe(['rev-parse', '--verify', '--quiet', startPoint])) fail(`base ref '${base}' does not exist.`)

  fs.mkdirSync(wtRoot, { recursive: true })
  // `git worktree add -b` is the atomic step: if two sessions race the same
  // branch, exactly one succeeds and the other lands here.
  try {
    git(['worktree', 'add', '-b', branch, dir, startPoint])
  } catch (e) {
    fail(`could not create worktree/branch '${branch}':\n${e.stderr || e.message}`)
  }

  const lease = {
    sessionId: me,
    multiSessionId: process.env.CLAUDE_MULTI_SESSION_ID || null,
    pid: Number(process.env.CLAUDE_PID) || process.ppid,
    worktree: dir,
    branch,
    base,
    startPoint,
    host: os.hostname(),
    createdAt: new Date().toISOString(),
  }
  // 'wx' => fail if a lease for this session already exists (no silent clobber).
  fs.writeFileSync(path.join(leaseDir(process.cwd()), `${me}.json`), JSON.stringify(lease, null, 2), { flag: 'wx' })

  print(renderClaim(lease, 'claimed'))
}

function renderClaim(lease, verb) {
  return [
    `session-guard: ${verb}`,
    `  worktree  ${lease.worktree}`,
    `  branch    ${lease.branch}${lease.startPoint || lease.base ? `  (from ${lease.startPoint || lease.base})` : ''}`,
    `  session   ${shortId(lease.sessionId)}  pid ${lease.pid}`,
    '',
    'Work only in that directory. Address git at it explicitly:',
    `  git -C "${lease.worktree}" status`,
  ].join('\n')
}

function cmdVerify(args) {
  const target = argValue(args, '--path') || process.cwd()
  const o = ownership(target, process.cwd())
  const me = shortId(sessionId())
  if (o.kind === 'mine') {
    print(`session-guard: OK -- ${o.root} is leased to session ${me} (branch ${o.lease.branch}).`)
    return
  }
  print(explain(o, target), 'stderr')
  process.exit(1)
}

function explain(o, target) {
  const me = shortId(sessionId())
  const lines = [`session-guard: BLOCKED -- you (session ${me}) do not own this location.`, `  target  ${target}`]
  if (o.root) lines.push(`  worktree  ${o.root}`)
  if (o.kind === 'other') {
    const why = o.lease._pidAlive ? `pid ${o.lease.pid}, ALIVE` : `heartbeat ${o.lease.renewedAt || o.lease.createdAt}`
    lines.push(
      `  leased to  session ${shortId(o.lease.sessionId)} (${why}) on branch ${o.lease.branch}`,
      '',
      'That session is active right now. Editing here would collide with it.',
    )
  } else if (o.kind === 'stale') {
    lines.push(
      `  leased to  session ${shortId(o.lease.sessionId)} (pid ${o.lease.pid}, gone; last heartbeat ${o.lease.renewedAt || o.lease.createdAt || 'unknown'})`,
      '',
      'The lease is stale. Clear dead leases with:',
      '  node scripts/session-guard.mjs reap',
    )
  } else if (o.kind === 'unmanaged') {
    lines.push(
      '  leased to  nobody -- this is a shared checkout, not a session worktree',
      '',
      'Shared checkouts are off limits: another session or the app may switch',
      'their branch at any moment, and they can hold uncommitted work.',
    )
  } else {
    lines.push('  not inside a git work tree')
  }
  lines.push('', 'Claim your own isolated worktree, then work there:', '  node scripts/session-guard.mjs claim --base beta')
  return lines.join('\n')
}

function cmdList() {
  const leases = readLeases(process.cwd())
  const me = sessionId()
  if (!leases.length) {
    print('session-guard: no active session leases.')
    return
  }
  const rows = leases
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((l) => {
      const live = l._pidAlive ? 'alive' : l._fresh ? 'alive(beat)' : 'DEAD'
      const flags = [l.sessionId === me ? 'you' : null, live, l._present ? null : 'MISSING-WT']
        .filter(Boolean)
        .join(',')
      return `  ${shortId(l.sessionId).padEnd(10)} ${String(l.pid).padEnd(8)} ${(l.branch || '?').padEnd(34)} ${flags}\n      ${l.worktree}`
    })
  print(['session-guard: leases', '  SESSION    PID      BRANCH                             FLAGS', ...rows].join('\n'))
}

function cmdStatus() {
  const o = ownership(process.cwd(), process.cwd())
  print(`cwd        ${process.cwd()}`)
  print(`session    ${shortId(sessionId())}  pid ${process.env.CLAUDE_PID || '?'}`)
  print(`ownership  ${o.kind}${o.lease ? `  (${o.lease.branch})` : ''}`)
  print(`guard      ${GUARD_OFF ? 'DISABLED (CCC_SESSION_GUARD=off)' : 'enforcing'}`)
  cmdList()
}

function cmdReap() {
  const leases = readLeases(process.cwd())
  let n = 0
  for (const l of leases) {
    // _alive already folds in the heartbeat grace, so a session that merely
    // changed pid on resume is never reaped out from under itself.
    if (l._alive) continue
    if (l.sessionId === sessionId()) continue // never reap your own
    // Never reap a dead session that still has uncommitted work on disk --
    // dropping the lease would invite another session to take the directory.
    if (l._present) {
      const dirty = gitSafe(['status', '--porcelain'], { cwd: l.worktree })
      if (dirty) {
        print(`  keeping ${shortId(l.sessionId)} -- dead, but its worktree has uncommitted changes:\n      ${l.worktree}`)
        continue
      }
    }
    fs.unlinkSync(l._file)
    n++
    print(`  reaped ${shortId(l.sessionId)} (pid ${l.pid}) ${l.branch}`)
  }
  print(`session-guard: reaped ${n} dead lease(s).`)
}

function cmdRelease(args) {
  const me = sessionId()
  const lease = readLeases(process.cwd()).find((l) => l.sessionId === me)
  if (!lease) {
    print('session-guard: nothing to release (no lease for this session).')
    return
  }
  if (args.includes('--remove-worktree')) {
    const dirty = gitSafe(['status', '--porcelain'], { cwd: lease.worktree })
    if (dirty) fail(`refusing to remove ${lease.worktree} -- it has uncommitted changes.`)
    const main = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    gitSafe(['worktree', 'remove', lease.worktree], { cwd: main ? path.dirname(main) : process.cwd() })
  }
  fs.unlinkSync(lease._file)
  print(`session-guard: released ${lease.branch}.`)
}

// ------------------------------------------------------------------- hook

// Read-only git verbs are always fine, wherever they run.
const GIT_READONLY = new Set([
  'status', 'log', 'diff', 'show', 'rev-parse', 'rev-list', 'ls-files', 'ls-tree', 'cat-file',
  'branch', 'tag', 'describe', 'blame', 'shortlog', 'config', 'remote', 'grep', 'check-ignore',
  'range-diff', 'merge-base', 'name-rev', 'reflog', 'whatchanged', 'count-objects', 'var', 'help',
])
// Verbs that write to the repo, the index, or the working tree.
const GIT_MUTATING = new Set([
  'commit', 'add', 'rm', 'mv', 'restore', 'checkout', 'switch', 'reset', 'merge', 'rebase',
  'cherry-pick', 'revert', 'stash', 'clean', 'push', 'apply', 'am', 'update-ref', 'update-index',
  'gc', 'prune', 'filter-branch', 'replace', 'notes', 'submodule', 'sparse-checkout', 'clone', 'init',
])

function parseGitInvocations(cmd) {
  const found = []
  // Split on shell separators so `cd x && git commit` is seen.
  for (const seg of cmd.split(/\|\||&&|[;|\n]/)) {
    const m = seg.match(/(?:^|\s)git(?:\.exe)?\s+(.+)/i)
    if (!m) continue
    const toks = m[1].match(/"[^"]*"|'[^']*'|\S+/g) || []
    const clean = toks.map((t) => t.replace(/^["']|["']$/g, ''))
    let dashC = null
    let verb = null
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] === '-C' && clean[i + 1]) {
        dashC = clean[i + 1]
        i++
        continue
      }
      if (clean[i].startsWith('-')) continue
      verb = clean[i]
      // `git worktree add` / `git branch -D` need the sub-verb too.
      const sub = clean.slice(i + 1).find((t) => !t.startsWith('-')) || null
      found.push({ verb, sub, dashC, argv: clean })
      break
    }
  }
  return found
}

function gitInvocationRisk(inv) {
  const { verb, sub, argv } = inv
  if (verb === 'worktree') {
    // Creating and listing are how a session bootstraps itself -- always allow.
    if (sub === 'add' || sub === 'list' || sub === 'lock' || sub === 'unlock') return 'allow'
    return 'mutating' // remove / prune / move can destroy another session's tree
  }
  if (verb === 'branch') return argv.some((a) => /^-(D|d|m|M|f)$/.test(a)) ? 'mutating' : 'allow'
  if (verb === 'tag') return argv.some((a) => /^-(d|f)$/.test(a)) ? 'mutating' : 'allow'
  if (verb === 'fetch') return 'allow' // updates remote refs only
  if (verb === 'stash' && (sub === 'list' || sub === 'show')) return 'allow'
  if (GIT_MUTATING.has(verb)) return 'mutating'
  if (GIT_READONLY.has(verb)) return 'allow'
  return 'allow'
}

function hookDecision(input) {
  const tool = input.tool_name || ''
  const ti = input.tool_input || {}
  const cwd = input.cwd || process.cwd()

  if (GUARD_OFF) return null

  // Never block the guard's own bootstrap commands.
  const raw = typeof ti.command === 'string' ? ti.command : ''
  if (/session-guard\.mjs/.test(raw)) return null

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    const f = ti.file_path || ti.notebook_path || ti.path
    if (!f) return null
    const o = ownership(f, cwd)
    // Only guard files that live inside this repo's worktrees.
    if (o.kind === 'not-a-repo' || o.kind === 'mine') return null
    if (o.kind === 'unmanaged' && !isRepoWorktree(o.root, cwd)) return null
    return explain(o, f)
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    if (!raw) return null
    for (const inv of parseGitInvocations(raw)) {
      if (gitInvocationRisk(inv) !== 'mutating') continue
      const target = inv.dashC || cwd
      const o = ownership(target, cwd)
      if (o.kind === 'not-a-repo' || o.kind === 'mine') continue
      if (o.kind === 'unmanaged' && !isRepoWorktree(o.root, cwd)) continue
      return explain(o, target)
    }
  }
  return null
}

/** True when root is a worktree of the same repo the session is operating on. */
function isRepoWorktree(root, cwd) {
  if (!root) return false
  const a = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root })
  const b = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  return !!a && !!b && samePath(a, b)
}

async function cmdHook() {
  let buf = ''
  for await (const chunk of process.stdin) buf += chunk
  let input = {}
  try {
    input = JSON.parse(buf || '{}')
  } catch {
    process.exit(0) // never wedge the session on malformed input
  }
  let reason = null
  try {
    reason = hookDecision(input)
  } catch {
    process.exit(0) // fail open: a guard bug must not brick the session
  }
  if (!reason) process.exit(0)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  )
  process.exit(0)
}

// ------------------------------------------------------------------ plumbing

function argValue(args, flag) {
  const i = args.indexOf(flag)
  return i >= 0 ? args[i + 1] : null
}
function print(s, stream = 'stdout') {
  process[stream].write(s + '\n')
}
function fail(msg) {
  print(`session-guard: ${msg}`, 'stderr')
  process.exit(1)
}

const [, , cmd, ...rest] = process.argv
// Any invocation is proof of life for this session -- keep its lease credible
// before anything reads ownership. Cheap, and never touches another lease.
if (cmd) {
  try {
    touchLease(process.cwd())
  } catch {
    /* ignore */
  }
}
switch (cmd) {
  case 'claim': cmdClaim(rest); break
  case 'adopt': cmdAdopt(rest); break
  case 'verify': cmdVerify(rest); break
  case 'list': cmdList(); break
  case 'status': cmdStatus(); break
  case 'reap': cmdReap(); break
  case 'release': cmdRelease(rest); break
  case 'hook': await cmdHook(); break
  default:
    print('usage: session-guard.mjs claim|verify|status|list|reap|release|hook')
    process.exit(cmd ? 1 : 0)
}
