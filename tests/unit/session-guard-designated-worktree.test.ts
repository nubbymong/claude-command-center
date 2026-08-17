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
import { execFileSync } from 'child_process'
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
})
