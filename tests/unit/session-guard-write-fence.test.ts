// scripts/session-guard.mjs — the PreToolUse write-location fence (#557).
//
// Sessions must not scatter files across the machine: outside this repo's
// worktrees, a write is allowed only under a sanctioned root (OS temp, the
// primary checkout's `<name>_RESOURCES` sibling, the worktree base,
// CCC_WRITE_ROOTS extras). Inside the repo's worktrees the lease rules decide,
// unchanged. Existing FOREIGN repos stay writable. Runs the real script's
// `hook` subcommand against a throwaway repo.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const GUARD = path.resolve(__dirname, '..', '..', 'scripts', 'session-guard.mjs')

const CC_ME = '11111111-1111-4111-8111-111111111111'
const CC_OTHER = '22222222-2222-4222-8222-222222222222'

let root: string // throwaway world
let repo: string // primary checkout <root>/project
let wtMine: string // my claimed worktree <root>/ccc-wt/mine
let wtOther: string // another live session's worktree
let tmpx: string // the world's "OS temp" (TMP/TEMP/TMPDIR point here)
let resources: string // <root>/project_RESOURCES
let foreign: string // an unrelated existing repo
let stray: (name: string) => string

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Run the real hook. Returns '' on allow, or the deny reason. */
function hook(toolName: string, toolInput: Record<string, unknown>, envOverride: Record<string, string> = {}): string {
  const merged: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') merged[k] = v
  delete merged.CCC_SESSION_GUARD
  delete merged.CCC_WRITE_ROOTS
  Object.assign(merged, {
    CLAUDE_CODE_SESSION_ID: CC_ME,
    TMP: tmpx,
    TEMP: tmpx,
    TMPDIR: tmpx,
    CCC_WT_ROOT: path.join(root, 'ccc-wt'),
  }, envOverride)
  const out = execFileSync(process.execPath, [GUARD, 'hook'], {
    cwd: wtMine,
    encoding: 'utf8',
    env: merged,
    input: JSON.stringify({ tool_name: toolName, tool_input: toolInput, cwd: wtMine }),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (!out.trim()) return ''
  return JSON.parse(out).hookSpecificOutput.permissionDecisionReason as string
}

function writeLease(sessionId: string, worktree: string, branch: string, pid: number) {
  const dir = path.join(repo, '.git', 'ccc-sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({ sessionId, pid, worktree, branch, base: 'main', host: 'test', createdAt: new Date().toISOString(), renewedAt: new Date().toISOString() }),
  )
}

beforeAll(() => {
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-fence-')))
  repo = path.join(root, 'project')
  tmpx = path.join(root, 'tmpx')
  resources = path.join(root, 'project_RESOURCES')
  foreign = path.join(root, 'foreign')
  for (const d of [repo, tmpx, resources, foreign]) fs.mkdirSync(d, { recursive: true })
  stray = (name) => path.join(root, name)

  git(['init', '-q', '-b', 'main'], repo)
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  wtMine = path.join(root, 'ccc-wt', 'mine')
  wtOther = path.join(root, 'ccc-wt', 'other')
  git(['worktree', 'add', '-q', '-b', 'session/mine', wtMine, 'main'], repo)
  git(['worktree', 'add', '-q', '-b', 'session/other', wtOther, 'main'], repo)
  writeLease(CC_ME, wtMine, 'session/mine', process.pid)
  writeLease(CC_OTHER, wtOther, 'session/other', process.pid) // "alive": this very process

  git(['init', '-q', '-b', 'main'], foreign)
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'], foreign)
})

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best-effort */ }
})

describe('file-write tools (Write/Edit)', () => {
  it('allows writes inside my claimed worktree', () => {
    expect(hook('Write', { file_path: path.join(wtMine, 'src', 'new.ts') })).toBe('')
  })

  it('still denies writes into another live session worktree', () => {
    const r = hook('Write', { file_path: path.join(wtOther, 'x.ts') })
    expect(r).toContain('BLOCKED')
    expect(r).toContain('do not own')
  })

  it('still denies writes into the shared primary checkout', () => {
    const r = hook('Edit', { file_path: path.join(repo, 'src', 'x.ts') })
    expect(r).toContain('BLOCKED')
  })

  it('DENIES a write to a stray location outside every sanctioned root', () => {
    const r = hook('Write', { file_path: path.join(stray('ccc-attack-999'), 'exploit.ts') })
    expect(r).toContain('outside every sanctioned write location')
  })

  it('allows writes under OS temp (the session scratchpad)', () => {
    expect(hook('Write', { file_path: path.join(tmpx, 'scratch', 'a.txt') })).toBe('')
  })

  it('allows writes under the <primary>_RESOURCES sibling', () => {
    expect(hook('Write', { file_path: path.join(resources, 'resume.md') })).toBe('')
  })

  it('allows writes inside an existing foreign repo', () => {
    expect(hook('Write', { file_path: path.join(foreign, 'their-file.ts') })).toBe('')
  })

  it('honours CCC_WRITE_ROOTS extras', () => {
    const extra = stray('extra-root')
    fs.mkdirSync(extra, { recursive: true })
    expect(hook('Write', { file_path: path.join(extra, 'ok.txt') }, { CCC_WRITE_ROOTS: extra })).toBe('')
    expect(hook('Write', { file_path: path.join(extra, 'no.txt') })).toContain('outside every sanctioned')
  })

  it('is disabled by CCC_SESSION_GUARD=off', () => {
    expect(hook('Write', { file_path: path.join(stray('ccc-hatch'), 'x.txt') }, { CCC_SESSION_GUARD: 'off' })).toBe('')
  })
})

describe('shell creation commands', () => {
  it('DENIES mkdir of a stray root (bash)', () => {
    expect(hook('Bash', { command: `mkdir -p "${stray('ccc-probe-x')}"` })).toContain('outside every sanctioned')
  })

  it('allows mkdir inside the worktree and under temp', () => {
    expect(hook('Bash', { command: 'mkdir -p sub/dir' })).toBe('')
    expect(hook('Bash', { command: `mkdir "${path.join(tmpx, 'p')}"` })).toBe('')
  })

  it('DENIES New-Item directory at a stray root (PowerShell)', () => {
    expect(hook('PowerShell', { command: `New-Item -ItemType Directory -Path "${stray('ccc-ps-stray')}"` })).toContain('outside every sanctioned')
  })

  it('DENIES git clone to a stray root, allows clone under temp', () => {
    expect(hook('Bash', { command: `git clone https://example.invalid/r.git "${stray('ccc-sec-2')}"` })).toContain('outside every sanctioned')
    expect(hook('Bash', { command: `git clone https://example.invalid/r.git "${path.join(tmpx, 'clone')}"` })).toBe('')
  })

  it('DENIES git worktree add outside the worktree base, allows inside it', () => {
    expect(hook('Bash', { command: `git worktree add "${stray('rogue-wt')}" -b rogue` })).toContain('outside every sanctioned')
    expect(hook('Bash', { command: `git worktree add "${path.join(root, 'ccc-wt', 'wt-next')}" -b next` })).toBe('')
  })

  it('DENIES a redirect to a stray absolute path, allows redirects in-worktree and to the null device', () => {
    expect(hook('Bash', { command: `echo hi > "${stray('ccc-log')}.txt"` })).toContain('outside every sanctioned')
    expect(hook('Bash', { command: 'echo hi > local.txt' })).toBe('')
    expect(hook('Bash', { command: 'echo hi > /dev/null' })).toBe('')
    expect(hook('Bash', { command: 'node x.mjs 2>&1' })).toBe('')
  })

  it('DENIES the POSIX-path drive mangle (`/tmp/...` from a Windows cwd)', () => {
    // path.resolve maps /tmp/x onto the cwd's drive — F:\tmp\x, the observed stray.
    const r = hook('Bash', { command: 'echo data > /tmp/ccc-mangle.txt' })
    if (process.platform === 'win32') expect(r).toContain('outside every sanctioned')
    else expect(typeof r).toBe('string') // non-Windows: /tmp IS temp-adjacent; no assertion on verdict
  })

  it('fails open on unresolvable (variable) targets', () => {
    expect(hook('Bash', { command: 'mkdir "$SOME_DIR"' })).toBe('')
    expect(hook('Bash', { command: 'echo x > "%TARGET%"' })).toBe('')
  })

  it('MSYS drive paths are translated before fencing', () => {
    if (process.platform !== 'win32') return
    const driveLetter = root[0].toLowerCase()
    const msys = `/${driveLetter}${root.slice(2).replace(/\\/g, '/')}/ccc-msys-stray`
    expect(hook('Bash', { command: `mkdir ${msys}` })).toContain('outside every sanctioned')
  })
})
