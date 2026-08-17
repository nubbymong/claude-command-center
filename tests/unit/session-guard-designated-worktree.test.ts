// scripts/session-guard.mjs — `claim` honours the worktree location CCC
// designates through CCC_SESSION_WORKTREE (ADR-016), so the Agent Canvas can
// serve the session's worktree. Runs the real script against a throwaway repo.
//
//   - set → the worktree is created exactly there (lease.designated = true)
//   - set, and an earlier conversation of the SAME CCC session left a worktree
//     there → adopted in place (its lease is cleared, ours written)
//   - set, but another live session (a different CCC session) holds it, or
//     something that is not a worktree is there → falls back to the default
//     location with a note; nothing is clobbered
//   - unset → the default location, unchanged

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn as spawnProc } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const GUARD = path.resolve(__dirname, '..', '..', 'scripts', 'session-guard.mjs')

let root: string
let repo: string
let wtBase: string
const CCC_A = 'aaaa1111aaaa1111aaaa1111'
const CCC_B = 'bbbb2222bbbb2222bbbb2222'
const CC_1 = '11111111-1111-4111-8111-111111111111'
const CC_2 = '22222222-2222-4222-8222-222222222222'
const CC_3 = '33333333-3333-4333-8333-333333333333'

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function claim(env: Record<string, string | undefined>, args: string[] = ['claim', '--base', 'main']): { out: string; code: number } {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (typeof v === 'string') merged[k] = v
  // Never let the developer's own session leak into the throwaway repo.
  delete merged.CCC_SESSION_GUARD
  delete merged.CCC_WT_ROOT // the throwaway repo's own <parent>/ccc-wt, whatever the developer's box says
  try {
    const out = execFileSync(process.execPath, [GUARD, ...args], { cwd: repo, encoding: 'utf8', env: merged, stdio: ['ignore', 'pipe', 'pipe'] })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}

function execRun(cmd: [string, string[], string], env: Record<string, string | undefined>): { out: string; code: number } {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...process.env, ...env })) if (typeof v === 'string') merged[k] = v
  delete merged.CCC_SESSION_GUARD
  delete merged.CCC_WT_ROOT
  try {
    const out = execFileSync(cmd[0], cmd[1], { cwd: cmd[2], encoding: 'utf8', env: merged, stdio: ['ignore', 'pipe', 'pipe'] })
    return { out, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number }
    return { out: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.status ?? 1 }
  }
}

function leases(): Array<Record<string, unknown>> {
  const dir = path.join(repo, '.git', 'ccc-sessions')
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-guard-wt-')))
  repo = path.join(root, 'project')
  wtBase = path.join(root, 'ccc-wt')
  fs.mkdirSync(repo)
  git(['init', '-q', '-b', 'main'])
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'])
})

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('session-guard claim with a CCC-designated worktree', () => {
  it('creates the worktree exactly where CCC_SESSION_WORKTREE points and marks the lease designated', () => {
    const designated = path.join(wtBase, CCC_A.slice(0, 8))
    const r = claim({ CLAUDE_CODE_SESSION_ID: CC_1, CLAUDE_MULTI_SESSION_ID: CCC_A, CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('session-guard: claimed')
    expect(fs.existsSync(path.join(designated, '.git'))).toBe(true) // a linked worktree lives there
    const l = leases().find((x) => x.sessionId === CC_1)!
    expect(l, r.out).toBeTruthy()
    expect(path.resolve(String(l.worktree)).toLowerCase()).toBe(designated.toLowerCase())
    expect(l.designated).toBe(true)
    expect(l.multiSessionId).toBe(CCC_A)
    expect(String(l.branch)).toBe('session/main/11111111')
  }, 30_000)

  it('a later conversation of the SAME CCC session adopts that worktree in place (old lease cleared)', () => {
    const designated = path.join(wtBase, CCC_A.slice(0, 8))
    // Leave uncommitted work behind so the note about it is exercised.
    fs.writeFileSync(path.join(designated, 'wip.txt'), 'unfinished')
    const r = claim({ CLAUDE_CODE_SESSION_ID: CC_2, CLAUDE_MULTI_SESSION_ID: CCC_A, CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('adopted')
    expect(r.out).toContain('1 uncommitted change')
    const all = leases()
    expect(all.find((x) => x.sessionId === CC_1)).toBeUndefined() // earlier conversation's lease cleared
    const l = all.find((x) => x.sessionId === CC_2)!
    expect(l, r.out).toBeTruthy()
    expect(path.resolve(String(l.worktree)).toLowerCase()).toBe(designated.toLowerCase())
    expect(l.adopted).toBe(true)
    expect(l.designated).toBe(true)
    // No second worktree was created for it.
    expect(fs.existsSync(path.join(wtBase, '22222222'))).toBe(false)
  }, 30_000)

  it('a DIFFERENT live CCC session pointed at the same directory falls back to the default location', () => {
    const designated = path.join(wtBase, CCC_A.slice(0, 8)) // still held by CC_2 (alive: our pid)
    const r = claim({ CLAUDE_CODE_SESSION_ID: CC_3, CLAUDE_MULTI_SESSION_ID: CCC_B, CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('still holds it')
    expect(r.out).toContain('the canvas will not serve this worktree')
    const l = leases().find((x) => x.sessionId === CC_3)!
    expect(l, r.out).toBeTruthy()
    expect(path.resolve(String(l.worktree)).toLowerCase()).toBe(path.join(wtBase, '33333333').toLowerCase())
    expect(l.designated).toBe(false)
    // CC_2 still owns the designated worktree.
    const l2 = leases().find((x) => x.sessionId === CC_2)!
    expect(path.resolve(String(l2.worktree)).toLowerCase()).toBe(designated.toLowerCase())
  }, 30_000)

  it('something that is not a worktree at the designated path → default location, nothing clobbered', () => {
    const designated = path.join(wtBase, CCC_B.slice(0, 8))
    fs.mkdirSync(designated, { recursive: true })
    fs.writeFileSync(path.join(designated, 'precious.txt'), 'do not touch')
    const cc = '44444444-4444-4444-8444-444444444444'
    const r = claim({ CLAUDE_CODE_SESSION_ID: cc, CLAUDE_MULTI_SESSION_ID: CCC_B, CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('something else is there')
    expect(fs.readFileSync(path.join(designated, 'precious.txt'), 'utf8')).toBe('do not touch')
    expect(fs.existsSync(path.join(designated, '.git'))).toBe(false)
    const l = leases().find((x) => x.sessionId === cc)!
    expect(path.resolve(String(l.worktree)).toLowerCase()).toBe(path.join(wtBase, '44444444').toLowerCase())
  }, 30_000)

  it('an EMPTY directory at the designated path is fine to create into', () => {
    const designated = path.join(wtBase, 'emptyone')
    fs.mkdirSync(designated, { recursive: true })
    const cc = '55555555-5555-4555-8555-555555555555'
    const r = claim({ CLAUDE_CODE_SESSION_ID: cc, CLAUDE_MULTI_SESSION_ID: 'cccc3333cccc3333cccc3333', CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    expect(r.code, r.out).toBe(0)
    expect(fs.existsSync(path.join(designated, '.git'))).toBe(true)
    const l = leases().find((x) => x.sessionId === cc)!
    expect(l.designated).toBe(true)
  }, 30_000)

  it('without CCC_SESSION_WORKTREE the default location is used, as before', () => {
    const cc = '66666666-6666-4666-8666-666666666666'
    const r = claim({ CLAUDE_CODE_SESSION_ID: cc, CLAUDE_MULTI_SESSION_ID: undefined, CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: undefined })
    expect(r.code, r.out).toBe(0)
    const l = leases().find((x) => x.sessionId === cc)!
    expect(path.resolve(String(l.worktree)).toLowerCase()).toBe(path.join(wtBase, '66666666').toLowerCase())
    expect(l.designated).toBe(false)
  }, 30_000)

  it('a relative CCC_SESSION_WORKTREE is ignored (hint must be absolute)', () => {
    const cc = '77777777-7777-4777-8777-777777777777'
    const r = claim({ CLAUDE_CODE_SESSION_ID: cc, CLAUDE_MULTI_SESSION_ID: 'dddd4444dddd4444dddd4444', CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: 'relative/place' })
    expect(r.code, r.out).toBe(0)
    const l = leases().find((x) => x.sessionId === cc)!
    expect(path.resolve(String(l.worktree)).toLowerCase()).toBe(path.join(wtBase, '77777777').toLowerCase())
    expect(l.designated).toBe(false)
  }, 30_000)

  // --- Adversarial-review regressions -------------------------------------

  it('does NOT adopt a worktree of a DIFFERENT repository at the designated path', () => {
    // A second repo, and one of ITS worktrees parked at our designated path.
    const otherRepo = path.join(root, 'other-repo')
    fs.mkdirSync(otherRepo)
    git(['init', '-q', '-b', 'main'], otherRepo)
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], otherRepo)
    const designated = path.join(wtBase, 'foreignrepo01')
    git(['worktree', 'add', '-q', designated], otherRepo)   // a worktree of otherRepo, not ours
    fs.writeFileSync(path.join(designated, 'their-secret.txt'), 'do not touch')

    const cc = '88888888-8888-4888-8888-888888888888'
    const r = claim({ CLAUDE_CODE_SESSION_ID: cc, CLAUDE_MULTI_SESSION_ID: 'eeee5555eeee5555eeee5555', CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('DIFFERENT repository')
    // We got the DEFAULT location, not the foreign worktree.
    const l = leases().find((x) => x.sessionId === cc)!
    expect(path.resolve(String(l.worktree)).toLowerCase()).toBe(path.join(wtBase, '88888888').toLowerCase())
    expect(l.designated).toBe(false)
    // The foreign worktree is untouched (still otherRepo's, file intact).
    expect(fs.readFileSync(path.join(designated, 'their-secret.txt'), 'utf8')).toBe('do not touch')
  }, 30_000)

  it('does NOT steal a worktree held by a CONCURRENT LIVE process of the same CCC session (nested claude)', async () => {
    // A live child process to stand in for the parent conversation whose lease is
    // alive with a DIFFERENT pid than the claimer. Same tile id, still running.
    const child = spawnProc(process.execPath, ['-e', 'setTimeout(()=>{}, 60000)'], { stdio: 'ignore' })
    try {
      await new Promise((r) => setTimeout(r, 50))
      const tile = 'ffff6666ffff6666ffff6666'
      const designated = path.join(wtBase, 'nestedlive01')
      const parent = 'aa000001-0000-4000-8000-000000000001'
      // Parent conversation claims and OWNS the designated worktree, pid = child.
      const rp = claim({ CLAUDE_CODE_SESSION_ID: parent, CLAUDE_MULTI_SESSION_ID: tile, CLAUDE_PID: String(child.pid), CCC_SESSION_WORKTREE: designated })
      expect(rp.code, rp.out).toBe(0)
      expect(fs.existsSync(path.join(designated, '.git'))).toBe(true)
      // A nested claude: same tile, a DIFFERENT (this test's) live pid.
      const nested = 'aa000002-0000-4000-8000-000000000002'
      const rn = claim({ CLAUDE_CODE_SESSION_ID: nested, CLAUDE_MULTI_SESSION_ID: tile, CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
      expect(rn.code, rn.out).toBe(0)
      expect(rn.out).toContain('concurrent process of this CCC session')
      // The nested session got the DEFAULT location; the parent's lease is intact.
      const ln = leases().find((x) => x.sessionId === nested)!
      expect(path.resolve(String(ln.worktree)).toLowerCase()).toBe(path.join(wtBase, 'aa000002').toLowerCase())
      const lp = leases().find((x) => x.sessionId === parent)!
      expect(lp, 'parent lease still present').toBeTruthy()
      expect(path.resolve(String(lp.worktree)).toLowerCase()).toBe(designated.toLowerCase())
    } finally {
      child.kill()
    }
  }, 30_000)

  it('re-claims a designated worktree after release --remove-worktree, reusing the leftover branch (no double-fail)', () => {
    const tile = 'ac340000ac340000ac340000'
    const designated = path.join(wtBase, 'reclaimbrch1')
    const conv1 = 'ca000001-0000-4000-8000-000000000001'
    const r1 = claim({ CLAUDE_CODE_SESSION_ID: conv1, CLAUDE_MULTI_SESSION_ID: tile, CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    expect(r1.code, r1.out).toBe(0)
    // A commit lands on the worktree's branch, then it is released WITH the dir
    // removed (the branch survives — that is what used to wedge the reclaim).
    fs.writeFileSync(path.join(designated, 'work.txt'), 'in progress')
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], designated)
    git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'wip'], designated)
    const rel = execRun([process.execPath, [GUARD, 'release', '--remove-worktree'], repo], { CLAUDE_CODE_SESSION_ID: conv1, CLAUDE_MULTI_SESSION_ID: tile, CLAUDE_PID: String(process.pid) })
    expect(rel.code, rel.out).toBe(0)
    expect(fs.existsSync(designated)).toBe(false)
    // The SAME session re-claims (its branch survived the release). Pre-fix this
    // double-failed on 'branch already exists' (both the designated add and the
    // fallback used -b). Now the existing branch is REUSED at the same path.
    const r2 = claim({ CLAUDE_CODE_SESSION_ID: conv1, CLAUDE_MULTI_SESSION_ID: tile, CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    expect(r2.code, r2.out).toBe(0)
    expect(fs.existsSync(path.join(designated, '.git'))).toBe(true)
    // The commit is still there (the branch was reused, not recreated).
    expect(fs.existsSync(path.join(designated, 'work.txt'))).toBe(true)
    const l = leases().find((x) => x.sessionId === conv1)!
    expect(l.designated).toBe(true)
  }, 30_000)

  it('falls back to the default location when the designated path has a FILE parent (no raw mkdir throw)', () => {
    const parentFile = path.join(wtBase, 'notadir')
    fs.mkdirSync(wtBase, { recursive: true })
    fs.writeFileSync(parentFile, 'i am a file')
    const designated = path.join(parentFile, 'wt')   // parent is a file
    const cc = 'da000001-0000-4000-8000-000000000001'
    const r = claim({ CLAUDE_CODE_SESSION_ID: cc, CLAUDE_MULTI_SESSION_ID: 'ad560000ad560000ad560000', CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    // Pre-fix: an uncaught EEXIST stack trace and no worktree. Now: fall back.
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('using the default location')
    const l = leases().find((x) => x.sessionId === cc)!
    expect(l, r.out).toBeTruthy()
    expect(path.resolve(String(l.worktree)).toLowerCase()).toBe(path.join(wtBase, 'da000001').toLowerCase())
    expect(l.designated).toBe(false)
    expect(fs.readFileSync(parentFile, 'utf8')).toBe('i am a file')  // untouched
  }, 30_000)

  it('prunes a stale worktree registration so a hand-deleted designated dir does not wedge the tile', () => {
    const tile = 'ab120000ab120000ab120000'
    const designated = path.join(wtBase, 'prunewedge01')
    const conv1 = 'ba000001-0000-4000-8000-000000000001'
    const r1 = claim({ CLAUDE_CODE_SESSION_ID: conv1, CLAUDE_MULTI_SESSION_ID: tile, CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    expect(r1.code, r1.out).toBe(0)
    expect(fs.existsSync(path.join(designated, '.git'))).toBe(true)
    // The directory is removed by hand; git still has it registered. Its lease
    // (conv1) is also cleared, standing in for a later conversation.
    fs.rmSync(designated, { recursive: true, force: true })
    const leaseFile = path.join(repo, '.git', 'ccc-sessions', `${conv1}.json`)
    if (fs.existsSync(leaseFile)) fs.rmSync(leaseFile)
    const conv2 = 'ba000002-0000-4000-8000-000000000002'
    const r2 = claim({ CLAUDE_CODE_SESSION_ID: conv2, CLAUDE_MULTI_SESSION_ID: tile, CLAUDE_PID: String(process.pid), CCC_SESSION_WORKTREE: designated })
    // Pre-fix this failed hard ("missing but already registered worktree").
    expect(r2.code, r2.out).toBe(0)
    expect(fs.existsSync(path.join(designated, '.git'))).toBe(true)
    const l = leases().find((x) => x.sessionId === conv2)!
    expect(path.resolve(String(l.worktree)).toLowerCase()).toBe(designated.toLowerCase())
    expect(l.designated).toBe(true)
  }, 30_000)
})
