#!/usr/bin/env node
// Session-integration ("loop") tree.
//
// The autonomous loop (see .claude/skills/SessionLoop) works one ticket per
// worktree via session-guard, then AGGREGATES the finished ticket branches into
// ONE human-facing PR. This script is the aggregation half: it mints a durable
// `loop/<base>/<slug>` integration branch, merges completed ticket branches INTO
// it, opens a single squash PR to the base, and cleans up after the human merges.
//
// It is deliberately SEPARATE from session-guard.mjs and DOES NOT touch the
// PreToolUse ownership hook. It needs no carve-out: the orchestrator OWNS the
// integration worktree (a normal session-guard claim/adopt), and the guard
// already permits a `git merge` inside a worktree you own. The one new safety
// property lives HERE, at the command: every mutating verb refuses to run unless
// the current branch is a `loop/*` integration branch -- so an operator error can
// never fold work into, or open a self-merging PR against, beta/main/release.
//
//   node scripts/loop-tree.mjs open --base <ref> --slug <s>   (mint branch+worktree)
//   node scripts/loop-tree.mjs integrate --branch <ticket>    (merge a ticket branch IN)
//   node scripts/loop-tree.mjs submit [--base <ref>] [--title <t>]  (one PR -> base)
//   node scripts/loop-tree.mjs status | folded
//   node scripts/loop-tree.mjs close [--remove-worktree]      (after the human merges)
//   node scripts/loop-tree.mjs branch-name --base <ref> --slug <s>  (pure; for scripts/tests)
//
// The AI has authority to `integrate` and `submit` (it owns the loop branch); it
// NEVER merges the loop PR to base -- a human does, through every gate
// (desktop-tested, ci-run, adversarial, owner review). See ADR-020.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const INTEGRATION_PREFIX = 'loop/'

// A base or slug segment: lowercase alnum + dashes, no leading dash, bounded.
// The value is interpolated into a git ref and a shell-run `gh`/`git` argv, so it
// is charset-gated at construction; `git check-ref-format` is the belt below it.
const SEGMENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Branches a loop PR may target, and that `integrate`/`submit`/`close` must
 *  NEVER run against as the current branch. `release/*` matched by prefix. */
export function isProtectedRef(branch) {
  if (!branch) return true
  if (branch === 'beta' || branch === 'main' || branch === 'master') return true
  if (branch.startsWith('release/')) return true
  return false
}

/** True for a well-formed integration branch: `loop/<base>/<slug>`. */
export function isLoopBranch(branch) {
  return typeof branch === 'string' && branch.startsWith(INTEGRATION_PREFIX) && branch.split('/').length >= 3
}

export function validateSegment(name, value) {
  if (!value || !SEGMENT_RE.test(value)) {
    throw new Error(`invalid ${name} "${value}": expected lowercase letters, digits and dashes (no leading dash), <=64 chars`)
  }
  return value
}

/** Pure: the integration branch name for a base + slug. Both segments validated. */
export function integrationBranchName(base, slug) {
  validateSegment('base', base)
  validateSegment('slug', slug)
  return `${INTEGRATION_PREFIX}${base}/${slug}`
}

/**
 * THE authority guard. Throws unless `branch` is a `loop/*` integration branch.
 * Every mutating command calls this on the CURRENT branch first, so aggregation
 * and the submit-PR can only ever act on a loop branch -- never beta/main/release
 * (which `isProtectedRef` would also catch) and never a per-ticket `feat/*`.
 */
export function assertLoopBranch(branch) {
  if (isProtectedRef(branch)) {
    throw new Error(`refusing to operate on protected branch "${branch}" -- loop-tree only ever mutates a loop/* integration branch.`)
  }
  if (!isLoopBranch(branch)) {
    throw new Error(`current branch "${branch}" is not a loop/* integration branch. Run this from the worktree that holds one (loop-tree open ...).`)
  }
  return branch
}

/**
 * A ticket branch being merged IN. It must be a real branch, must NOT be a
 * protected ref, and must NOT be the loop branch itself (a self-merge). It may be
 * any working branch (feat/*, fix/*, session/*).
 */
export function assertMergeableTicketBranch(ticket, currentLoopBranch) {
  if (!ticket || typeof ticket !== 'string') throw new Error('no ticket branch given (--branch <name>).')
  // Pin the SHAPE, not just the charset (adversarial review, ADR-020): a
  // fully-qualified or remote-tracking ref (`refs/heads/beta`, `origin/beta`) is
  // NOT a plain local branch and must never be foldable -- `refs/heads/beta`
  // slips past the protected-name check, and `origin/beta` would merge all of
  // beta into the loop branch. The command additionally requires the value to
  // exist as `refs/heads/<ticket>` (a local branch), which rejects any remote
  // ref; here we reject the qualified/relative forms outright and up front.
  if (ticket.startsWith('refs/') || ticket.startsWith('remotes/')) {
    throw new Error(`refusing a qualified ref "${ticket}" -- name a plain local branch (e.g. feat/<n>-...).`)
  }
  if (/[~^:?*[\\\x00-\x20]|\.\.|@\{/.test(ticket)) {
    throw new Error(`refusing a branch name with ref-metacharacters or whitespace: "${ticket}".`)
  }
  if (isProtectedRef(ticket)) throw new Error(`refusing to merge a protected branch "${ticket}" into the loop branch.`)
  if (ticket === currentLoopBranch) throw new Error('cannot merge the loop branch into itself.')
  // A ref that is itself another loop branch would nest integration trees.
  if (isLoopBranch(ticket)) throw new Error(`refusing to merge one loop branch (${ticket}) into another.`)
  return ticket
}

// ---------------------------------------------------------------- git plumbing

function git(args, opts = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'pipe'],
    cwd: opts.cwd || process.cwd(),
  }).trim()
}
function gitSafe(args, opts = {}) {
  try { return git(args, { ...opts, quiet: true }) } catch { return null }
}
function currentBranch(cwd = process.cwd()) {
  return gitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })
}
function refExists(ref) {
  return !!gitSafe(['rev-parse', '--verify', '--quiet', ref])
}
/** Belt below the charset gate: git's own opinion on a ref name. */
function assertValidRefName(branch) {
  if (!gitSafe(['check-ref-format', '--branch', branch])) {
    throw new Error(`git rejects "${branch}" as a branch name.`)
  }
}

/**
 * Working-tree changes that MATTER for an integrate/submit — everything except
 * loop-tree's own `.loop/` bookkeeping. `.loop/` is gitignored, but a repo without
 * that ignore (a fresh clone, a test fixture) would otherwise see folded.json as
 * "dirty" and refuse the SECOND integrate; filtering it here makes the command
 * correct regardless of the ignore file.
 */
function dirtyPorcelain(cwd) {
  const out = gitSafe(['status', '--porcelain'], { cwd }) || ''
  // Porcelain v1 is `XY <path>` (XY = 2 status chars, then a space). Anchor the
  // filter to the PATH field so it only ever excludes the repo-root `.loop/`
  // bookkeeping -- never a working file that merely CONTAINS ".loop/" in its
  // name/content (adversarial review, fail-open lens). A rename `R  old -> new`
  // keeps its arrow in the path field; a `.loop/` rename is not a case we produce.
  const pathIsLoop = (line) => {
    let p = line.slice(3)                    // drop the "XY " prefix
    if (p.startsWith('"')) p = p.slice(1)    // unquote a path with odd chars
    return p.startsWith('.loop/')
  }
  return out
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .filter((l) => !pathIsLoop(l))
    .join('\n')
}

function print(s, stream = 'stdout') { process[stream].write(s + '\n') }
function fail(msg) { print(`loop-tree: ${msg}`, 'stderr'); process.exit(1) }

/**
 * loop-tree runs `node scripts/loop-tree.mjs …`, which the session-guard PreToolUse
 * hook does NOT see (it only pattern-matches raw `git`). So a mutating loop-tree
 * command in a worktree this session does not own would perform merges/removals the
 * guard would otherwise deny (adversarial review). Reuse session-guard's OWN
 * `verify` to close that: it exits 0 only when this session leases `cwd`. Inert
 * outside a guarded session (no CLAUDE_CODE_SESSION_ID -- tests, a plain checkout),
 * so it adds a boundary in the loop, never a hard failure elsewhere.
 */
function assertOwnedWorktree(cwd) {
  if (!process.env.CLAUDE_CODE_SESSION_ID) return
  const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), 'session-guard.mjs')
  if (!fs.existsSync(guard)) return
  try {
    execFileSync('node', [guard, 'verify', '--path', cwd], { stdio: 'ignore' })
  } catch {
    fail(`this worktree is not leased to your session -- adopt it first:\n  node scripts/session-guard.mjs adopt --path "${cwd}"\n(refusing so loop-tree cannot mutate another session's worktree).`)
  }
}
function argValue(args, flag) { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null }

/** Where the loop records which ticket branches it has folded (per worktree). */
function foldedFile(cwd = process.cwd()) {
  const top = gitSafe(['rev-parse', '--show-toplevel'], { cwd })
  return top ? path.join(top, '.loop', 'folded.json') : null
}
function readFolded(cwd) {
  const f = foldedFile(cwd)
  if (!f || !fs.existsSync(f)) return []
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).folded || [] } catch { return [] }
}
function recordFolded(cwd, entry) {
  const f = foldedFile(cwd)
  if (!f) return
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const folded = readFolded(cwd)
  folded.push(entry)
  fs.writeFileSync(f, JSON.stringify({ folded }, null, 2))
}

// ---------------------------------------------------------------- commands

function cmdBranchName(args) {
  print(integrationBranchName(argValue(args, '--base') || 'beta', argValue(args, '--slug')))
}

function cmdOpen(args) {
  const base = argValue(args, '--base') || 'beta'
  const slug = argValue(args, '--slug')
  const branch = integrationBranchName(base, slug) // validates both segments
  assertValidRefName(branch)

  const startPoint = refExists(`origin/${base}`) ? `origin/${base}` : base
  if (!refExists(startPoint)) fail(`base ref '${base}' does not exist.`)

  const commonDir = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const primaryRoot = commonDir ? path.dirname(commonDir) : gitSafe(['rev-parse', '--show-toplevel'])
  const wtRoot = process.env.CCC_WT_ROOT || path.join(path.dirname(primaryRoot), 'ccc-wt')
  const dir = path.join(wtRoot, `loop-${slug}`)

  if (fs.existsSync(dir)) {
    print(`loop-tree: integration worktree already exists at ${dir} (branch ${branch}). Reusing.`)
  } else {
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    try {
      if (refExists(`refs/heads/${branch}`)) git(['worktree', 'add', dir, branch])
      else git(['worktree', 'add', '-b', branch, dir, startPoint])
    } catch (e) {
      fail(`could not create the integration worktree/branch '${branch}':\n${e.stderr || e.message}`)
    }
  }
  print(
    [
      `loop-tree: integration tree ready`,
      `  branch    ${branch}   (from ${startPoint})`,
      `  worktree  ${dir}`,
      '',
      'Adopt it so the guard leases it to this session, then work from it:',
      `  node scripts/session-guard.mjs adopt --path "${dir}"`,
      `  git -C "${dir}" status`,
    ].join('\n'),
  )
}

function cmdIntegrate(args) {
  const cwd = process.cwd()
  const cur = currentBranch(cwd)
  assertLoopBranch(cur) // AUTHORITY GUARD: only a loop/* branch may aggregate.
  assertOwnedWorktree(cwd)

  const ticket = argValue(args, '--branch')
  assertMergeableTicketBranch(ticket, cur)
  assertValidRefName(ticket)
  // MUST be a LOCAL branch. Requiring `refs/heads/<ticket>` (not `refExists(ticket)`)
  // is what rejects a remote-tracking ref like `origin/beta`: there is no local
  // branch by that name, so it fails here even though the ref resolves.
  if (!refExists(`refs/heads/${ticket}`)) {
    fail(`no local branch '${ticket}'. loop-tree folds a LOCAL ticket branch only (never a remote-tracking ref); check the name or fetch+checkout it first.`)
  }
  // Append-only fold log with dedupe: re-integrating the same branch would double
  // its diff into the session PR (adversarial review).
  if (readFolded(cwd).some((e) => e.branch === ticket)) {
    fail(`'${ticket}' is already folded into ${cur}. Nothing to do.`)
  }

  const dirty = dirtyPorcelain(cwd)
  if (dirty) fail('the integration worktree has uncommitted changes -- commit or stash before integrating.')

  const squash = args.includes('--squash')
  // Merge the fully-qualified LOCAL ref, so the name can never resolve to a
  // remote-tracking ref or a tag at merge time.
  const ref = `refs/heads/${ticket}`
  const before = gitSafe(['rev-parse', 'HEAD'], { cwd })
  try {
    if (squash) {
      git(['merge', '--squash', ref], { cwd })
      git(['commit', '--no-edit', '-m', `loop: squash-integrate ${ticket}`], { cwd })
    } else {
      git(['merge', '--no-ff', '--no-edit', ref], { cwd })
    }
  } catch (e) {
    // Leave the tree clean: abort the half-done merge so the loop can proceed to
    // the next ticket and this one is reported as a conflict for a human.
    gitSafe(['merge', '--abort'], { cwd })
    fail(`merge conflict integrating '${ticket}' into ${cur}; aborted (tree restored).\n  A human must resolve this ticket by hand.\n${(e.stderr || e.message || '').trim().split(/\r?\n/)[0]}`)
  }
  const after = gitSafe(['rev-parse', 'HEAD'], { cwd })
  recordFolded(cwd, { branch: ticket, at: new Date().toISOString(), from: before, to: after, squash })
  print(`loop-tree: integrated ${ticket} into ${cur}${squash ? ' (squashed)' : ''}.`)
}

function cmdSubmit(args) {
  const cwd = process.cwd()
  const cur = currentBranch(cwd)
  assertLoopBranch(cur)
  // The PR base is the base this loop branch was cut from -- `loop/<base>/<slug>`.
  // A `--base` override is validated AND must match that embedded base (adversarial
  // review): otherwise `submit --base main` on a beta-cut loop would open beta work
  // as a PR against main -- a mislabelled, human-gated merge trap. gh consumes the
  // value as an argv token (no shell), so this is a correctness gate, not injection.
  const embeddedBase = cur.split('/')[1] || 'beta'
  const base = argValue(args, '--base') || embeddedBase
  validateSegment('base', base)
  if (base !== embeddedBase) {
    fail(`--base ${base} does not match this loop branch's base (${embeddedBase}); refusing to open ${embeddedBase}-based work against ${base}.`)
  }

  const folded = readFolded(cwd)
  if (!folded.length) fail('nothing folded into this integration branch yet -- integrate at least one ticket first.')

  const dirty = dirtyPorcelain(cwd)
  if (dirty) fail('the integration worktree has uncommitted changes.')

  git(['push', '-u', 'origin', cur], { cwd })

  const title = argValue(args, '--title') || `loop: integrated ${folded.length} ticket branch(es) (${cur})`
  const bodyLines = [
    'Aggregated session-integration PR (ADR-020).',
    '',
    'Folded ticket branches:',
    ...folded.map((e) => `- \`${e.branch}\`${e.squash ? ' (squashed)' : ''}`),
    '',
    'The AI merged each ticket branch into this loop branch; a HUMAN merges this PR to',
    `\`${base}\` after it clears every gate (desktop-tested, ci-run, adversarial, owner review).`,
    '',
    'NOT desktop-tested by the loop -- apply `desktop-tested` after verifying in the app.',
  ]
  const bodyFile = path.join(cwd, '.loop', 'pr-body.md')
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true })
  fs.writeFileSync(bodyFile, bodyLines.join('\n'))

  try {
    const out = execFileSync('gh', ['pr', 'create', '--base', base, '--head', cur, '--title', title, '--body-file', bodyFile, '--label', 'ci-run'], {
      encoding: 'utf8', cwd,
    }).trim()
    print(`loop-tree: opened session PR -> ${base}\n  ${out}`)
  } catch (e) {
    fail(`push succeeded but 'gh pr create' failed:\n${(e.stderr || e.message || '').trim()}`)
  }
}

function cmdStatus() {
  const cur = currentBranch()
  const folded = readFolded(process.cwd())
  print(`loop-tree: branch ${cur || '?'} ${isLoopBranch(cur) ? '(integration)' : '(NOT a loop branch)'}`)
  print(`  folded: ${folded.length} ticket branch(es)`)
  for (const e of folded) print(`    - ${e.branch}${e.squash ? ' (squashed)' : ''}  ${e.at}`)
}

function cmdClose(args) {
  const cwd = process.cwd()
  const cur = currentBranch(cwd)
  assertLoopBranch(cur)
  assertOwnedWorktree(cwd)
  const base = cur.split('/')[1] || 'beta'
  // Only close once the aggregate actually landed: HEAD must be an ancestor of
  // origin/<base> (i.e. the human merged the PR). `merge-base --is-ancestor` exits
  // 0 when it is, non-zero otherwise -- so a thrown call means "not merged".
  // Refuse otherwise, so work is never pruned before it is safely in base.
  gitSafe(['fetch', 'origin', base], { cwd })
  let isMerged = false
  try { git(['merge-base', '--is-ancestor', 'HEAD', `origin/${base}`], { cwd, quiet: true }); isMerged = true } catch { isMerged = false }
  if (!isMerged) {
    fail(`refusing to close: ${cur} is not yet merged into origin/${base}. A human merges the session PR first.`)
  }
  if (!args.includes('--remove-worktree')) {
    print(`loop-tree: ${cur} is merged into origin/${base}. Re-run with --remove-worktree to prune the worktree + branch.`)
    return
  }
  const dirty = dirtyPorcelain(cwd)
  if (dirty) fail(`refusing to remove ${cwd} -- it has uncommitted changes.`)
  const commonDir = gitSafe(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  const primaryRoot = commonDir ? path.dirname(commonDir) : cwd
  gitSafe(['worktree', 'remove', cwd], { cwd: primaryRoot })
  gitSafe(['branch', '-D', cur], { cwd: primaryRoot })
  print(`loop-tree: pruned integration worktree and branch ${cur}. (Ticket worktrees are released via session-guard.)`)
}

// ---------------------------------------------------------------- dispatch

const INVOKED_AS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (INVOKED_AS_MAIN) {
  const [, , cmd, ...rest] = process.argv
  try {
    switch (cmd) {
      case 'branch-name': cmdBranchName(rest); break
      case 'open': cmdOpen(rest); break
      case 'integrate': cmdIntegrate(rest); break
      case 'submit': cmdSubmit(rest); break
      case 'status': cmdStatus(); break
      case 'folded': cmdStatus(); break
      case 'close': cmdClose(rest); break
      default:
        print('usage: loop-tree.mjs open|integrate|submit|status|close|branch-name')
        process.exit(cmd ? 1 : 0)
    }
  } catch (e) {
    fail(e.message || String(e))
  }
}
