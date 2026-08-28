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
//
// Under CCC (AI Code Conductor), CCC_SESSION_WORKTREE names the directory the
// app has designated for THIS session's worktree -- the one path the Agent
// Canvas will serve, so a mockup written there is renderable by htmlPath
// (ADR-016). `claim` creates the worktree there, or adopts the one an earlier
// conversation of the same CCC session left there. Unset outside CCC.

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

/** True when dirA and dirB are worktrees of the SAME repository (shared object
 *  store). A foreign repo's worktree at a designated path would have no lease in
 *  this repo's registry, so every ownership check would pass and it would be
 *  wrongly adopted -- this is the guard against that. */
function sameRepo(dirA, dirB) {
  const a = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dirA })
  const b = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: dirB })
  return !!a && !!b && samePath(a, b)
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
  // Our previous worktree is gone (deleted by hand / release --remove-worktree):
  // drop the stale own-lease so the writes below don't hit EEXIST ('wx').
  if (existing) { try { fs.unlinkSync(existing._file) } catch { /* already gone */ } }

  const mainRoot = gitSafe(['rev-parse', '--path-format=absolute', '--show-toplevel'])
  if (!mainRoot) fail('run this from inside the repository (or a worktree of it).')

  const branch = slug ? `session/${base}/${short}-${slug}` : `session/${base}/${short}`
  // Anchor sibling worktrees to the PRIMARY checkout, never to whatever worktree
  // we happen to be standing in -- otherwise claiming from inside one nests
  // ccc-wt/ccc-wt/... one level deeper every time.
  const commonDir = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const primaryRoot = commonDir ? path.dirname(commonDir) : mainRoot
  const wtRoot = process.env.CCC_WT_ROOT || path.join(path.dirname(primaryRoot), 'ccc-wt')
  const defaultDir = path.join(wtRoot, slug ? `${short}-${slug}` : short)
  let dir = defaultDir

  // CCC designated a location for this session's worktree (the path the canvas
  // serves). Use it: create there, or adopt what an earlier conversation of the
  // same CCC session left there. When it is unusable, say so and fall back to
  // the default location -- the worktree then simply is not canvas-served.
  const designated = designatedWorktreeDir()
  if (designated) {
    const d = claimDesignated(designated, me, base)
    if (d && d.adopt) {
      const lease = {
        sessionId: me,
        multiSessionId: process.env.CLAUDE_MULTI_SESSION_ID || null,
        pid: Number(process.env.CLAUDE_PID) || process.ppid,
        worktree: d.adopt.root,
        branch: d.adopt.branch,
        base,
        startPoint: null,
        host: os.hostname(),
        createdAt: new Date().toISOString(),
        adopted: true,
        designated: true,
      }
      fs.writeFileSync(path.join(leaseDir(process.cwd()), `${me}.json`), JSON.stringify(lease, null, 2), { flag: 'wx' })
      print(renderClaim(lease, 'adopted (this CCC session\'s existing worktree)'))
      if (d.adopt.dirty > 0) {
        print(`  note: ${d.adopt.dirty} uncommitted change(s) from the previous conversation are still in it.`)
      }
      print(`  note: it is on branch ${d.adopt.branch}; branch off ${base} yourself if you want a fresh start.`)
      return
    }
    if (d && d.dir) dir = d.dir
  }

  // Prefer the remote base so a session never inherits another session's local drift.
  const startPoint = gitSafe(['rev-parse', '--verify', '--quiet', `origin/${base}`]) ? `origin/${base}` : base
  if (!gitSafe(['rev-parse', '--verify', '--quiet', startPoint])) fail(`base ref '${base}' does not exist.`)

  // Create the worktree. `-b <branch>` from the base for a fresh claim; a branch
  // that already exists (a re-claim after `release --remove-worktree` left it
  // behind) is REUSED at the new path, never recreated -- recreating would either
  // double-fail on '-b' or discard the commits still on it. The whole step,
  // including the parent mkdir, is one try so a bad DESIGNATED location (a file
  // parent, a race, leftover content) falls back to the default location rather
  // than fail the claim or throw a raw stack trace.
  const addWorktreeAt = (targetDir) => {
    fs.mkdirSync(path.dirname(targetDir), { recursive: true })
    const branchExists = !!gitSafe(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    if (branchExists) git(['worktree', 'add', targetDir, branch])
    else git(['worktree', 'add', '-b', branch, targetDir, startPoint])
  }
  try {
    addWorktreeAt(dir)
  } catch (e) {
    // A CCC-designated location that could not be created must not fail the whole
    // claim -- fall back to the default location (unserved by the canvas) rather
    // than leave the session with no worktree at all.
    if (designated && samePath(dir, designated) && !samePath(dir, defaultDir)) {
      print(`  note: could not create the worktree at the CCC-designated location (${(e.stderr || e.message || '').trim().split(/\r?\n/)[0]}); using the default location (the canvas will not serve this worktree).`)
      dir = defaultDir
      try {
        addWorktreeAt(dir)
      } catch (e2) {
        fail(`could not create worktree/branch '${branch}':\n${e2.stderr || e2.message}`)
      }
    } else {
      fail(`could not create worktree/branch '${branch}':\n${e.stderr || e.message}`)
    }
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
    designated: !!(designated && samePath(designated, dir)),
  }
  // 'wx' => fail if a lease for this session already exists (no silent clobber).
  fs.writeFileSync(path.join(leaseDir(process.cwd()), `${me}.json`), JSON.stringify(lease, null, 2), { flag: 'wx' })

  print(renderClaim(lease, 'claimed'))
}

/** The directory CCC designated for this session's worktree, or null. Must be
 *  absolute; anything else is ignored (this is a hint from the app, not a
 *  security boundary -- the canvas store enforces its own on the app side). */
function designatedWorktreeDir() {
  const raw = process.env.CCC_SESSION_WORKTREE
  if (!raw || typeof raw !== 'string' || !path.isAbsolute(raw)) return null
  return path.resolve(raw)
}

function isEmptyDir(p) {
  try {
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).length === 0
  } catch {
    return false
  }
}

/**
 * Decide what `claim` does with a CCC-designated directory:
 *   { dir }              -- nothing (or an empty dir) is there: create the worktree at `dir`
 *   { adopt: {...} }     -- a linked worktree of THIS repo is there and is free
 *                           to take (unowned, its owner is dead, or its owner
 *                           was an earlier conversation of this same CCC
 *                           session): adopt it in place
 *   null                 -- unusable: fall back to the default location
 */
function claimDesignated(designated, me, base) {
  if (!fs.existsSync(designated) || isEmptyDir(designated)) {
    // A worktree used to live here and its directory was removed by hand: git
    // still has it registered and would refuse `worktree add`. Prune the stale
    // registration first (safe + idempotent: prune only drops admin files for
    // worktrees whose directory is gone) so a fixed per-tile path never wedges.
    const registered = (gitSafe(['worktree', 'list', '--porcelain']) || '')
      .split(/\r?\n/)
      .some((l) => l.startsWith('worktree ') && samePath(l.slice('worktree '.length).trim(), designated))
    if (registered) gitSafe(['worktree', 'prune'])
    return { dir: designated }
  }
  const root = worktreeRoot(designated)
  if (!root || !samePath(root, designated) || isPrimaryWorktree(root)) {
    print(`  note: CCC designated ${designated} for this session, but something else is there; using the default location (the canvas will not serve this worktree).`)
    return null
  }
  // Must be a worktree of THIS repository. A foreign repo's worktree here has no
  // lease in this repo's registry, so every check below would pass and we would
  // adopt -- and be told to git -C -- the wrong repository (adversarial review).
  if (!sameRepo(root, process.cwd())) {
    print(`  note: CCC designated ${designated} for this session, but a worktree of a DIFFERENT repository is there; using the default location (the canvas will not serve this worktree).`)
    return null
  }
  const lease = readLeases(process.cwd()).find((l) => samePath(l.worktree, root))
  const myCccSession = process.env.CLAUDE_MULTI_SESSION_ID || null
  const sameCccSession = !!(lease && myCccSession && lease.multiSessionId === myCccSession)
  const myPid = Number(process.env.CLAUDE_PID) || process.ppid
  // Adopt an earlier conversation of the SAME tile ONLY when its process is gone
  // (or is me). A DIFFERENT live process with the same tile id -- a nested claude
  // launched from inside the session, which inherits CLAUDE_MULTI_SESSION_ID but
  // gets its own CLAUDE_CODE_SESSION_ID/pid -- must NOT steal the parent's live
  // worktree; that re-creates the two-live-processes-one-branch collision the
  // guard exists to prevent (adversarial review). pid reuse can only make this
  // MORE conservative (fall back rather than adopt), never less.
  const priorProcessGone = !lease || lease.sessionId === me || lease.pid === myPid || !pidAlive(lease.pid)
  if (lease && lease.sessionId !== me && lease._alive && !(sameCccSession && priorProcessGone)) {
    const who = sameCccSession
      ? `a concurrent process of this CCC session (pid ${lease.pid}) holds it -- a nested claude? use that worktree, or the default here`
      : `session ${shortId(lease.sessionId)} still holds it`
    print(`  note: CCC designated ${designated} for this session, but ${who}; using the default location (the canvas will not serve this worktree).`)
    return null
  }
  const branch = gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root }) || 'HEAD'
  if (branch === 'HEAD') {
    print(`  note: CCC designated ${designated} for this session, but the worktree there is on a detached HEAD (finish/abort the rebase or check out a branch there, or set CCC_SESSION_GUARD=off to work in it); using the default location.`)
    return null
  }
  if (lease && lease.sessionId !== me) {
    print(`  clearing lease of session ${shortId(lease.sessionId)} (${sameCccSession ? 'a previous conversation of this CCC session, exited' : `pid ${lease.pid}, not running`})`)
    fs.unlinkSync(lease._file)
  }
  const dirty = (gitSafe(['status', '--porcelain'], { cwd: root }) || '').split(/\r?\n/).filter((l) => l.trim().length > 0).length
  return { adopt: { root, branch, dirty }, base }
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

// ---------------------------------------------------- write-location fence
//
// Sessions must not scatter files across the machine. Observed strays: hand
// rolled roots (F:\ccc-attack-*, F:\ccc-sec advisory clones), and POSIX paths
// mangled onto the cwd's drive (`/tmp/x` handed to a Windows-native tool with
// cwd on F: materialises F:\tmp\x; same for F:\c and F:\Users). Outside this
// repo's worktrees a write is allowed only under a sanctioned root; inside
// them the lease rules decide, as before. An EXISTING foreign repo stays
// writable -- editing another project is a task, a new drive root is clutter.
// The fence denies only literal paths it can resolve statically; anything
// with an expansion passes through (fail open). CCC_SESSION_GUARD=off is the
// deliberate-exception hatch, as everywhere else in this guard.

/** Case-folded (win/mac) prefix test: p is root or inside it. */
function isUnderDir(p, root) {
  const norm = (x) => {
    let r = path.resolve(x).replace(/[\\/]+$/, '')
    try {
      r = fs.realpathSync.native(r)
    } catch {
      /* not on disk (yet) -- lexical form */
    }
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r
  }
  const a = norm(p)
  const b = norm(root)
  return a === b || a.startsWith(b + path.sep)
}

/** Where a session may create things OUTSIDE the repo's own worktrees. All
 *  derived (never personal paths): OS temp (the session scratchpad lives
 *  there), the primary checkout's `<name>_RESOURCES` sibling, the worktree
 *  base itself, plus any roots the user lists in CCC_WRITE_ROOTS. */
function sanctionedWriteRoots(cwd) {
  const roots = []
  const add = (p) => {
    if (!p || typeof p !== 'string' || !p.trim()) return
    try {
      roots.push(path.resolve(p.trim()))
    } catch {
      /* ignore */
    }
  }
  add(os.tmpdir())
  add(process.env.TMP)
  add(process.env.TEMP)
  add(process.env.TMPDIR)
  const common = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  if (common) {
    const primary = path.dirname(common)
    add(`${primary}_RESOURCES`)
    add(process.env.CCC_WT_ROOT || path.join(path.dirname(primary), 'ccc-wt'))
  }
  for (const p of (process.env.CCC_WRITE_ROOTS || '').split(path.delimiter)) add(p)
  return roots
}

/**
 * The absolute path a Windows-native tool would actually touch for a command
 * token, or null when it cannot be resolved statically. `/f/x` (MSYS) becomes
 * F:\x; a bare `/tmp/x` resolves against the cwd's DRIVE -- which is exactly
 * the drive-root mangling this fence exists to stop.
 */
function resolveWriteTarget(token, cwd) {
  if (!token || typeof token !== 'string') return null
  const t = token.replace(/^["']|["']$/g, '')
  if (!t || /[$%`]/.test(t)) return null // shell/PS expansion -- fail open
  const msys = t.match(/^\/([A-Za-z])(\/|$)/)
  if (msys) return path.resolve(`${msys[1].toUpperCase()}:${t.slice(2) || '/'}`)
  try {
    return path.resolve(cwd, t)
  } catch {
    return null
  }
}

function explainOutsideRoots(target, roots) {
  return [
    `session-guard: BLOCKED -- ${target} is outside every sanctioned write location.`,
    '',
    'Create files only in your claimed worktree or under one of:',
    ...roots.map((r) => `  - ${r}`),
    '',
    'Stray drive roots (ccc-attack-*, ccc-sec, \\tmp, ...) are what this fence',
    'stops. Add a root via CCC_WRITE_ROOTS (path-list), or set',
    'CCC_SESSION_GUARD=off for a deliberate exception.',
  ].join('\n')
}

/** null = allowed; string = deny reason. `roots` from sanctionedWriteRoots.
 *  Ownership is checked FIRST: a sanctioned root (the worktree base
 *  especially) must never launder a write into another session's worktree. */
function writeFence(rawTarget, cwd, roots) {
  const abs = resolveWriteTarget(rawTarget, cwd)
  if (!abs) return null
  const o = ownership(abs, cwd)
  if (o.kind === 'mine') return null
  if (o.kind === 'not-a-repo') {
    return roots.some((r) => isUnderDir(abs, r)) ? null : explainOutsideRoots(abs, roots)
  }
  // An existing worktree of a DIFFERENT repository: someone else's project,
  // not our clutter -- leave it to that repo's own rules.
  if (o.kind === 'unmanaged' && !isRepoWorktree(o.root, cwd)) return null
  return explain(o, abs)
}

/** Git invocations that materialise a NEW tree on disk get the fence too. */
const GIT_VALUE_FLAGS = /^-(b|B|o|u|c|-branch|-origin|-upstream|-depth|-reference|-reference-if-able|-template|-separate-git-dir|-shallow-since|-shallow-exclude|-filter|-jobs|-config)$/

function gitCreationTarget(inv) {
  const argv = inv.argv
  let i = argv.indexOf(inv.verb)
  if (i < 0) return null
  if (inv.verb === 'worktree') {
    i = argv.indexOf('add', i + 1)
    if (i < 0) return null
  }
  const rest = []
  for (let j = i + 1; j < argv.length; j++) {
    const a = argv[j]
    if (a.startsWith('-')) {
      if (GIT_VALUE_FLAGS.test(a)) j++
      continue
    }
    rest.push(a)
  }
  if (inv.verb === 'clone') return rest[1] || null // no explicit dir -> lands under cwd
  if (inv.verb === 'init') return rest[0] || '.'
  return rest[0] || null // worktree add <path>
}

/** Creation targets in one shell segment: mkdir/md/New-Item and >/>> redirects. */
function segmentWriteTargets(seg) {
  const out = []
  const toks = seg.match(/"[^"]*"|'[^']*'|\S+/g) || []
  const bare = toks.map((t) => t.replace(/^["']|["']$/g, ''))
  const head = bare.findIndex((t) => /^(mkdir|md|new-item)(\.exe)?$/i.test(t))
  if (head >= 0) {
    for (let j = head + 1; j < toks.length; j++) {
      const flag = bare[j]
      if (flag.startsWith('-')) {
        if (/^-{1,2}path$/i.test(flag)) continue // its value is a target
        if (/^-(itemtype|name|value|m|-mode)$/i.test(flag)) j++ // skip the flag's value
        continue
      }
      out.push(toks[j])
    }
  }
  // > target / >> target -- skip fd duplication and the null devices. A `>`
  // inside a quoted argument can still match; harmless when the token resolves
  // inside an allowed root, and the escape hatch covers the rest.
  const re = /(?:^|[^-=<>&|])>{1,2}\s*("[^"]+"|'[^']+'|[^\s&|;]+)/g
  let m
  while ((m = re.exec(seg))) {
    const c = m[1].replace(/^["']|["']$/g, '')
    if (/^(&\d+|\/dev\/null|nul)$/i.test(c)) continue
    out.push(m[1])
  }
  return out
}

const SHELL_SPLIT = /\|\||&&|[;|\n]/

function hookDecision(input) {
  const tool = input.tool_name || ''
  const ti = input.tool_input || {}
  const cwd = input.cwd || process.cwd()

  if (GUARD_OFF) return null

  // Never block the guard's own bootstrap commands.
  const raw = typeof ti.command === 'string' ? ti.command : ''
  if (/session-guard\.mjs/.test(raw)) return null

  // sanctionedWriteRoots shells out to git once -- compute only when needed.
  let rootsMemo = null
  const roots = () => (rootsMemo ??= sanctionedWriteRoots(cwd))

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit') {
    const f = ti.file_path || ti.notebook_path || ti.path
    if (!f) return null
    // mine -> allow; other/stale/unmanaged worktree of this repo -> deny (as
    // before); outside every repo -> allowed only under a sanctioned root.
    return writeFence(f, cwd, roots())
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    if (!raw) return null
    for (const inv of parseGitInvocations(raw)) {
      if (inv.verb === 'clone' || inv.verb === 'init' || (inv.verb === 'worktree' && inv.sub === 'add')) {
        const base = inv.dashC ? resolveWriteTarget(inv.dashC, cwd) || cwd : cwd
        const t = gitCreationTarget(inv)
        const r = t ? writeFence(t, base, roots()) : null
        if (r) return r
        continue
      }
      if (gitInvocationRisk(inv) !== 'mutating') continue
      const target = inv.dashC || cwd
      const o = ownership(target, cwd)
      if (o.kind === 'not-a-repo' || o.kind === 'mine') continue
      if (o.kind === 'unmanaged' && !isRepoWorktree(o.root, cwd)) continue
      return explain(o, target)
    }
    for (const seg of raw.split(SHELL_SPLIT)) {
      for (const t of segmentWriteTargets(seg)) {
        const r = writeFence(t, cwd, roots())
        if (r) return r
      }
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
