# Sidebar Flexibility — Phase 3: Local Git Action Surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the display-only Local Git section into an action surface with two safety classes: **undoable** writes (stage / unstage / discard / stash / branch-switch-with-auto-stash) backed by a 5s `ToastUndo`, and **confirm-before** writes (push / pull / force) behind a dialog that surfaces the exact `git` argv that will run. Every write is forensic-logged to `~/.claude/ccc-git-history.log`.

**Architecture:** All git write operations go through `src/main/git/git-runner.ts` which validates the supplied cwd against the live set of session working-directories held by `session-state`, then uses `child_process.execFile` with explicit argv (no shell). Git binary resolution happens once via a new `resolveGitBin()` — the function referenced by the spec exists only as inline-`spawn('git', ...)` in `src/main/github/session/repo-detector.ts` today, so Task 1 extracts it as a real exported helper used by both `repo-detector.ts` and the new git-runner. Each high-level operation gets its own IPC handler; renderer actions are expressed through a new `localGitStore` and a refactored `LocalGitSection` that composes `BranchSwitcher`, `FileStatusList`, `ConfirmDialog`, and `CommitDiffModal`. Phase 2's `ToastUndo` and `claude-input-queue` are imported as dependencies — this PR stacks on `feat/sidebar-easy-wins`.

**Tech Stack:** TypeScript strict, Electron 33, Node `child_process.execFile`, Zustand 5, React 18, Tailwind v4 (Catppuccin Mocha), `electron-vite`, `vitest` with temp-dir git fixtures.

---

## File structure

- Create: `src/main/git/git-runner.ts` — `runGit(cwd, args)` with cwd allowlist validation.
- Create: `src/main/git/git-bin.ts` — `resolveGitBin()` (extracted from `repo-detector.ts` + mac homebrew / Windows `where git` search).
- Create: `src/main/git/git-history-logger.ts` — best-effort append to `~/.claude/ccc-git-history.log`.
- Create: `src/main/ipc/git-handlers.ts` — new IPC handlers per operation.
- Modify: `src/main/github/session/repo-detector.ts` — make `defaultGitRun()` delegate to `resolveGitBin()` (no duplication).
- Modify: `src/main/index.ts` — register the new handlers.
- Modify: `src/shared/ipc-channels.ts` — add `GIT_*` channels.
- Modify: `src/preload/index.ts` — bridge under a `git:` namespace.
- Modify: `src/renderer/types/electron.d.ts` — type the bridge.
- Create: `src/renderer/stores/localGitStore.ts` — Zustand; per-session status + recent branches.
- Create: `src/renderer/components/github/localgit/BranchSwitcher.tsx`
- Create: `src/renderer/components/github/localgit/FileStatusList.tsx`
- Create: `src/renderer/components/github/localgit/ConfirmDialog.tsx`
- Create: `src/renderer/components/github/localgit/CommitDiffModal.tsx`
- Modify: `src/renderer/components/github/sections/LocalGitSection.tsx` — overhaul to compose the above.
- Create: `tests/unit/main/git/git-bin.test.ts`
- Create: `tests/unit/main/git/git-runner.test.ts`
- Create: `tests/unit/main/git/git-history-logger.test.ts`
- Create: `tests/unit/main/ipc/git-handlers.test.ts` — integration against temp git repos.
- Create: `tests/unit/renderer/stores/localGitStore.test.ts`
- Create: `tests/unit/renderer/components/github/localgit/BranchSwitcher.test.tsx`
- Create: `tests/unit/renderer/components/github/localgit/FileStatusList.test.tsx`
- Create: `tests/unit/renderer/components/github/localgit/ConfirmDialog.test.tsx`
- Create: `tests/unit/renderer/components/github/localgit/CommitDiffModal.test.tsx`

All new files ≤280 LOC. `LocalGitSection.tsx` grows by ~160 LOC but existing logic is factored out to the new subcomponents.

---

### Task 1: Extract `resolveGitBin()` as a standalone helper

The spec says "REUSE `resolveGitBin()` from `src/main/github/session/repo-detector.ts`" — the function does not actually exist yet in isolated form (only inline `spawn('git', ...)` with PATH lookup). Step 1 makes the spec claim true by extracting a real exported helper, then rewiring `defaultGitRun` to call it. The extracted function memoises the resolved path per process and falls back to `'git'` on PATH.

**Files:**
- Create: `src/main/git/git-bin.ts`
- Create: `tests/unit/main/git/git-bin.test.ts`
- Modify: `src/main/github/session/repo-detector.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/main/git/git-bin.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const execFileMock = vi.fn()
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: vi.fn(() => false) }
})

import { resolveGitBin, _resetGitBinCache } from '../../../src/main/git/git-bin'

describe('resolveGitBin', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    _resetGitBinCache()
  })

  it('returns the first PATH hit via `where git` on win32', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    execFileMock.mockImplementation((_bin, _args, cb: any) =>
      cb(null, 'C:\\Program Files\\Git\\cmd\\git.exe\r\nC:\\shim\\git.exe\r\n', ''),
    )
    const bin = await resolveGitBin()
    expect(bin).toBe('C:\\Program Files\\Git\\cmd\\git.exe')
  })

  it('falls back to the literal `git` when resolution fails', async () => {
    execFileMock.mockImplementation((_bin, _args, cb: any) => cb(new Error('not found'), '', ''))
    const bin = await resolveGitBin()
    expect(bin).toBe('git')
  })

  it('memoises the resolution (second call does not re-invoke execFile)', async () => {
    execFileMock.mockImplementation((_bin, _args, cb: any) => cb(null, '/usr/bin/git\n', ''))
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await resolveGitBin()
    await resolveGitBin()
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/main/git/git-bin.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `src/main/git/git-bin.ts`:

```ts
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

let cached: string | null = null

/** Test-only cache reset. Never called in production. */
export function _resetGitBinCache(): void { cached = null }

/**
 * Resolve the absolute path of a usable `git` binary on disk.
 *
 * Windows: `where git` and pick the first real file.
 * macOS: check `/opt/homebrew/bin/git` and `/usr/local/bin/git` before PATH.
 * Linux / fallback: spawn `which git`.
 *
 * Result is memoised for the life of the process. If resolution fails
 * for any reason we return the literal string `'git'` and let the OS
 * look it up via PATH — matching the pre-extraction behaviour.
 */
export function resolveGitBin(): Promise<string> {
  if (cached) return Promise.resolve(cached)

  return new Promise<string>((resolve) => {
    const done = (p: string): void => { cached = p; resolve(p) }

    if (process.platform === 'darwin') {
      for (const candidate of ['/opt/homebrew/bin/git', '/usr/local/bin/git']) {
        if (existsSync(candidate)) { done(candidate); return }
      }
    }

    const tool = process.platform === 'win32' ? 'where' : 'which'
    execFile(tool, ['git'], (err, stdout) => {
      if (err || !stdout) { done('git'); return }
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0]
      done(first || 'git')
    })
  })
}
```

- [ ] **Step 4: Rewire `defaultGitRun` in repo-detector**

In `src/main/github/session/repo-detector.ts`, change the top import block and the spawn target:

```ts
import { spawn } from 'node:child_process'
import { parseRepoUrl } from '../security/repo-url-parser'
import { resolveGitBin } from '../../git/git-bin'

// …

export function defaultGitRun(): RunGit {
  return async (cwd, args) => {
    const bin = await resolveGitBin()
    return new Promise<string>((resolve, reject) => {
      const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      proc.stdout.on('data', (c) => (stdout += c.toString()))
      proc.stderr.on('data', (c) => (stderr += c.toString()))
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code !== 0) reject(new Error(stderr || `git exited ${code}`))
        else resolve(stdout)
      })
    })
  }
}
```

- [ ] **Step 5: Run tests to verify green**

Run: `npx vitest run tests/unit/main/git/git-bin.test.ts && npm run typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/git/git-bin.ts src/main/github/session/repo-detector.ts tests/unit/main/git/git-bin.test.ts
git commit -m "feat(git): extract resolveGitBin helper for reuse across git surfaces"
```

---

### Task 2: Build `runGit(cwd, args)` with cwd allowlist validation

Thin wrapper around `child_process.execFile` that guarantees three invariants:
1. `bin` is `resolveGitBin()`'s result (never a user-supplied string).
2. `cwd` is present in the allowlist provided by the caller (session cwds from `session-state`).
3. `args` is an explicit argv array — no shell interpretation.

Returns `{stdout, stderr, code}` without throwing on non-zero exits; callers decide what to do with the result.

**Files:**
- Create: `src/main/git/git-runner.ts`
- Create: `tests/unit/main/git/git-runner.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/main/git/git-runner.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, GitCwdNotAllowedError } from '../../../src/main/git/git-runner'

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-git-runner-'))
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir })
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  writeFileSync(join(dir, 'seed.txt'), 'hello')
  spawnSync('git', ['add', 'seed.txt'], { cwd: dir })
  spawnSync('git', ['commit', '-m', 'seed'], { cwd: dir })
  return dir
}

describe('runGit', () => {
  let repo: string
  beforeEach(() => { repo = initRepo() })
  afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

  it('runs git in an allowed cwd and returns stdout/stderr/code', async () => {
    const out = await runGit(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowedCwds: [repo] })
    expect(out.code).toBe(0)
    expect(out.stdout.trim()).toBe('main')
  })

  it('throws GitCwdNotAllowedError when cwd is not in the allowlist', async () => {
    await expect(runGit(repo, ['status'], { allowedCwds: ['/some/other/path'] }))
      .rejects.toBeInstanceOf(GitCwdNotAllowedError)
  })

  it('returns non-zero code without throwing for a failed git command', async () => {
    const out = await runGit(repo, ['checkout', 'nonexistent-branch-xyz'], { allowedCwds: [repo] })
    expect(out.code).not.toBe(0)
    expect(out.stderr).toMatch(/nonexistent/)
  })

  it('resolves paths case-insensitively on win32 when comparing the allowlist', async () => {
    if (process.platform !== 'win32') return
    const out = await runGit(repo.toUpperCase(), ['status'], { allowedCwds: [repo] })
    expect(out.code).toBe(0)
  })

  it('rejects args that contain shell metacharacters defensively', async () => {
    await expect(runGit(repo, ['status; rm -rf /'], { allowedCwds: [repo] })).rejects.toThrow(/invalid/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/main/git/git-runner.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the runner**

Create `src/main/git/git-runner.ts`:

```ts
import { execFile } from 'node:child_process'
import { resolve as pathResolve } from 'node:path'
import { resolveGitBin } from './git-bin'

export interface GitRunResult {
  stdout: string
  stderr: string
  code: number
}

export interface GitRunOptions {
  /** Absolute paths of session working directories the caller permits. */
  allowedCwds: string[]
  /** Cap stdout/stderr to prevent a runaway `git log` blowing up RAM. */
  maxBuffer?: number
  /** Abort the operation after N ms. */
  timeoutMs?: number
}

export class GitCwdNotAllowedError extends Error {
  constructor(cwd: string) { super(`git cwd not in allowlist: ${cwd}`); this.name = 'GitCwdNotAllowedError' }
}

function normalisePath(p: string): string {
  const abs = pathResolve(p)
  return process.platform === 'win32' ? abs.toLowerCase() : abs
}

const FORBIDDEN_ARG = /[;&|`$<>\n\r]/

/**
 * Run git with an explicit argv; never via shell. The cwd MUST appear in
 * `options.allowedCwds` — this is the only gate between an IPC caller and
 * the filesystem.
 */
export async function runGit(
  cwd: string,
  args: string[],
  options: GitRunOptions,
): Promise<GitRunResult> {
  const target = normalisePath(cwd)
  const allowed = options.allowedCwds.map(normalisePath)
  if (!allowed.includes(target)) throw new GitCwdNotAllowedError(cwd)

  for (const a of args) {
    if (typeof a !== 'string') throw new Error('invalid git arg type')
    if (FORBIDDEN_ARG.test(a)) throw new Error(`invalid git arg: ${a}`)
  }

  const bin = await resolveGitBin()
  return new Promise<GitRunResult>((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        cwd,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        timeout: options.timeoutMs ?? 30_000,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') { reject(err); return }
        const code = err ? ((err as { code?: number }).code ?? 1) : 0
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code })
      },
    )
  })
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/main/git/git-runner.test.ts`
Expected: PASS (5 tests; the win32 case is skipped on non-Windows).

- [ ] **Step 5: Commit**

```bash
git add src/main/git/git-runner.ts tests/unit/main/git/git-runner.test.ts
git commit -m "feat(git): runGit wrapper with cwd-allowlist + argv safety"
```

---

### Task 3: Forensic history logger (best-effort append)

Every write operation appends one line to `~/.claude/ccc-git-history.log`. The logger MUST never block or fail a write — wrap in try/catch and swallow errors.

**Files:**
- Create: `src/main/git/git-history-logger.ts`
- Create: `tests/unit/main/git/git-history-logger.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/main/git/git-history-logger.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

let testHome: string
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => testHome }
})

import { logGitWrite } from '../../../src/main/git/git-history-logger'

describe('logGitWrite', () => {
  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), 'ccc-loghome-'))
  })

  it('appends a line containing sid, cwd, argv, and an ISO timestamp', async () => {
    await logGitWrite({ sid: 's1', cwd: '/w', argv: ['stash', 'push'] })
    const log = readFileSync(join(testHome, '.claude', 'ccc-git-history.log'), 'utf-8')
    expect(log).toMatch(/s1/)
    expect(log).toMatch(/stash push/)
    expect(log).toMatch(/\d{4}-\d{2}-\d{2}T/)
  })

  it('appends — does not replace — on subsequent calls', async () => {
    await logGitWrite({ sid: 's1', cwd: '/w', argv: ['push'] })
    await logGitWrite({ sid: 's1', cwd: '/w', argv: ['pull'] })
    const log = readFileSync(join(testHome, '.claude', 'ccc-git-history.log'), 'utf-8')
    expect(log.split('\n').filter(Boolean).length).toBe(2)
  })

  it('swallows write errors so callers never see them', async () => {
    testHome = '/nonexistent/surely/this/does/not/exist'
    await expect(logGitWrite({ sid: 's1', cwd: '/w', argv: ['status'] })).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/main/git/git-history-logger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the logger**

Create `src/main/git/git-history-logger.ts`:

```ts
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface GitWriteLogEntry {
  sid: string
  cwd: string
  argv: string[]
  resultCode?: number
}

/**
 * Append one line to `~/.claude/ccc-git-history.log`. Best-effort: if the
 * write fails for any reason (ENOENT, permission denied, filesystem full)
 * we swallow it. The logger must never fail a git operation.
 */
export async function logGitWrite(entry: GitWriteLogEntry): Promise<void> {
  try {
    const dir = join(homedir(), '.claude')
    await mkdir(dir, { recursive: true })
    const file = join(dir, 'ccc-git-history.log')
    const line = [
      new Date().toISOString(),
      entry.sid,
      entry.cwd,
      entry.argv.join(' '),
      entry.resultCode === undefined ? '' : `exit=${entry.resultCode}`,
    ].join(' | ') + '\n'
    await appendFile(file, line, 'utf-8')
  } catch {
    // swallowed by design — the spec calls this out as forensic-only
  }
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/main/git/git-history-logger.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/git/git-history-logger.ts tests/unit/main/git/git-history-logger.test.ts
git commit -m "feat(git): best-effort write-command forensic logger"
```

---

### Task 4: Add git-specific IPC channels

**Files:**
- Modify: `src/shared/ipc-channels.ts`
- Create: `tests/unit/shared/git-ipc-channels.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/shared/git-ipc-channels.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'

describe('git IPC channels', () => {
  it('exposes status/stage/unstage/discard/stash/pop/branch/push/pull/diff', () => {
    expect(IPC.GIT_STATUS).toBe('git:status')
    expect(IPC.GIT_STAGE).toBe('git:stage')
    expect(IPC.GIT_UNSTAGE).toBe('git:unstage')
    expect(IPC.GIT_DISCARD).toBe('git:discard')
    expect(IPC.GIT_STASH).toBe('git:stash')
    expect(IPC.GIT_POP_STASH).toBe('git:popStash')
    expect(IPC.GIT_BRANCH_LIST).toBe('git:branch:list')
    expect(IPC.GIT_BRANCH_SWITCH).toBe('git:branch:switch')
    expect(IPC.GIT_PUSH).toBe('git:push')
    expect(IPC.GIT_PULL).toBe('git:pull')
    expect(IPC.GIT_COMMIT_DIFF).toBe('git:commit:diff')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/shared/git-ipc-channels.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the channels**

In `src/shared/ipc-channels.ts`, after the existing `GITHUB_*` block, add a new Local Git block:

```ts
  // Local Git action surface (Phase 3)
  GIT_STATUS: 'git:status',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_DISCARD: 'git:discard',
  GIT_STASH: 'git:stash',
  GIT_POP_STASH: 'git:popStash',
  GIT_BRANCH_LIST: 'git:branch:list',
  GIT_BRANCH_SWITCH: 'git:branch:switch',
  GIT_PUSH: 'git:push',
  GIT_PULL: 'git:pull',
  GIT_COMMIT_DIFF: 'git:commit:diff',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/shared/git-ipc-channels.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-channels.ts tests/unit/shared/git-ipc-channels.test.ts
git commit -m "feat(git): IPC channels for local git action surface"
```

---

### Task 5: Status + stage/unstage IPC handlers (with numstat)

The status handler extends the existing `GITHUB_LOCALGIT_GET` output with per-file status codes (M/A/D/R/?) and `+/−` line counts parsed from `git diff --numstat`. It is a new channel (`GIT_STATUS`) — we don't modify the existing one, which still feeds `LocalGitSection`'s polling fallback. Stage / unstage call `git add` / `git restore --staged`, each wrapped in the history logger.

**Files:**
- Create: `src/main/ipc/git-handlers.ts`
- Create: `tests/unit/main/ipc/git-handlers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/main/ipc/git-handlers.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

let testHome: string
vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => testHome }
})

const handlers: Record<string, (...args: any[]) => any> = {}
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: any) => { handlers[ch] = fn } },
}))

const allowedCwds: string[] = []
vi.mock('../../src/main/session-state', () => ({
  loadSessionState: () => ({ sessions: allowedCwds.map((c, i) => ({ id: `s${i}`, workingDirectory: c })) }),
}))

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-ipc-'))
  spawnSync('git', ['init', '--initial-branch=main'], { cwd: dir })
  spawnSync('git', ['config', 'user.email', 't@x'], { cwd: dir })
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: dir })
  writeFileSync(join(dir, 'a.txt'), 'one\n')
  spawnSync('git', ['add', '.'], { cwd: dir })
  spawnSync('git', ['commit', '-m', 'seed'], { cwd: dir })
  return dir
}

import { registerGitHandlers } from '../../src/main/ipc/git-handlers'

describe('git-handlers', () => {
  let repo: string
  beforeEach(() => {
    repo = initRepo()
    testHome = mkdtempSync(join(tmpdir(), 'ccc-home-'))
    allowedCwds.length = 0
    allowedCwds.push(repo)
    for (const k of Object.keys(handlers)) delete handlers[k]
    registerGitHandlers()
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
    rmSync(testHome, { recursive: true, force: true })
  })

  it('status returns staged/unstaged/untracked with numstat', async () => {
    writeFileSync(join(repo, 'a.txt'), 'two\nthree\n')
    writeFileSync(join(repo, 'new.txt'), 'x\n')
    const res = await handlers['git:status'](null, 's0')
    expect(res.ok).toBe(true)
    expect(res.state.unstaged.find((f: any) => f.path === 'a.txt').status).toBe('M')
    expect(res.state.unstaged.find((f: any) => f.path === 'a.txt').added).toBe(2)
    expect(res.state.untracked.find((f: any) => f.path === 'new.txt')).toBeDefined()
  })

  it('stage moves a file from unstaged to staged', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    const out = await handlers['git:stage'](null, 's0', ['a.txt'])
    expect(out.ok).toBe(true)
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo }).stdout.toString()
    expect(status).toMatch(/^M  a\.txt/m)
  })

  it('unstage moves a file from staged back to unstaged', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    spawnSync('git', ['add', 'a.txt'], { cwd: repo })
    const out = await handlers['git:unstage'](null, 's0', ['a.txt'])
    expect(out.ok).toBe(true)
    const status = spawnSync('git', ['status', '--porcelain'], { cwd: repo }).stdout.toString()
    expect(status).toMatch(/^ M a\.txt/m)
  })

  it('rejects a sessionId whose workingDirectory is not on the allowlist', async () => {
    allowedCwds.length = 0 // sessions empty
    const out = await handlers['git:status'](null, 's0')
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/session/i)
  })

  it('appends each write to ~/.claude/ccc-git-history.log', async () => {
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    await handlers['git:stage'](null, 's0', ['a.txt'])
    const log = readFileSync(join(testHome, '.claude', 'ccc-git-history.log'), 'utf-8')
    expect(log).toMatch(/add/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/main/ipc/git-handlers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the handler skeleton + status/stage/unstage**

Create `src/main/ipc/git-handlers.ts`:

```ts
import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { runGit, GitCwdNotAllowedError } from '../git/git-runner'
import { logGitWrite } from '../git/git-history-logger'
import { loadSessionState } from '../session-state'

export interface GitFileEntry {
  path: string
  status: 'M' | 'A' | 'D' | 'R' | '?'
  added: number
  removed: number
}

function sessionCwds(): { map: Map<string, string>; all: string[] } {
  const map = new Map<string, string>()
  const all: string[] = []
  const state = loadSessionState()
  for (const s of state?.sessions ?? []) {
    if (s.workingDirectory) { map.set(s.id, s.workingDirectory); all.push(s.workingDirectory) }
  }
  return { map, all }
}

function resolveCwd(sid: string): { cwd: string; allowed: string[] } | { error: string } {
  const { map, all } = sessionCwds()
  const cwd = map.get(sid)
  if (!cwd) return { error: 'session-not-found-or-no-cwd' }
  return { cwd, allowed: all }
}

async function parseNumstat(cwd: string, allowed: string[], staged: boolean): Promise<Map<string, { added: number; removed: number }>> {
  const args = staged ? ['diff', '--cached', '--numstat'] : ['diff', '--numstat']
  const out = await runGit(cwd, args, { allowedCwds: allowed })
  const map = new Map<string, { added: number; removed: number }>()
  for (const line of out.stdout.split('\n').filter(Boolean)) {
    const [a, r, path] = line.split('\t')
    map.set(path, { added: Number(a) || 0, removed: Number(r) || 0 })
  }
  return map
}

export function registerGitHandlers(): void {
  ipcMain.handle(IPC.GIT_STATUS, async (_e, sid: string) => {
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    try {
      const porcelain = await runGit(ctx.cwd, ['status', '--porcelain=v1'], { allowedCwds: ctx.allowed })
      const stagedNums = await parseNumstat(ctx.cwd, ctx.allowed, true)
      const unstagedNums = await parseNumstat(ctx.cwd, ctx.allowed, false)
      const staged: GitFileEntry[] = []
      const unstaged: GitFileEntry[] = []
      const untracked: GitFileEntry[] = []
      for (const line of porcelain.stdout.split('\n')) {
        if (!line) continue
        const x = line[0], y = line[1], path = line.slice(3)
        if (x === '?' && y === '?') {
          untracked.push({ path, status: '?', added: 0, removed: 0 })
          continue
        }
        if (x !== ' ' && x !== '?') {
          const nums = stagedNums.get(path) ?? { added: 0, removed: 0 }
          staged.push({ path, status: (x === 'M' || x === 'A' || x === 'D' || x === 'R') ? x : 'M', ...nums })
        }
        if (y !== ' ' && y !== '?') {
          const nums = unstagedNums.get(path) ?? { added: 0, removed: 0 }
          unstaged.push({ path, status: (y === 'M' || y === 'D') ? y : 'M', ...nums })
        }
      }
      return { ok: true, state: { staged, unstaged, untracked } }
    } catch (err) {
      if (err instanceof GitCwdNotAllowedError) return { ok: false, error: 'cwd-not-allowed' }
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.GIT_STAGE, async (_e, sid: string, paths: unknown) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return { ok: false, error: 'invalid-paths' }
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    try {
      const argv = ['add', '--', ...(paths as string[])]
      const out = await runGit(ctx.cwd, argv, { allowedCwds: ctx.allowed })
      void logGitWrite({ sid, cwd: ctx.cwd, argv, resultCode: out.code })
      return out.code === 0 ? { ok: true } : { ok: false, error: out.stderr || `git exit ${out.code}` }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.GIT_UNSTAGE, async (_e, sid: string, paths: unknown) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return { ok: false, error: 'invalid-paths' }
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    try {
      const argv = ['restore', '--staged', '--', ...(paths as string[])]
      const out = await runGit(ctx.cwd, argv, { allowedCwds: ctx.allowed })
      void logGitWrite({ sid, cwd: ctx.cwd, argv, resultCode: out.code })
      return out.code === 0 ? { ok: true } : { ok: false, error: out.stderr || `git exit ${out.code}` }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/main/ipc/git-handlers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/git-handlers.ts tests/unit/main/ipc/git-handlers.test.ts
git commit -m "feat(git): IPC handlers for status/stage/unstage with numstat"
```

---

### Task 6: Discard (undoable) + stash + pop-stash handlers

Discard captures the pre-change blob via `git hash-object -w` before running `git checkout HEAD -- <file>` so the renderer's `ToastUndo` can restore via `git cat-file -p <blob> > <file>` on undo. Stash and pop-stash produce a captured stash ref (`refs/stash@{0}`) the undo can use to reverse.

**Files:**
- Modify: `src/main/ipc/git-handlers.ts`
- Modify: `tests/unit/main/ipc/git-handlers.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/main/ipc/git-handlers.test.ts`:

```ts
  it('discard captures a blob snapshot then reverts the file', async () => {
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    const res = await handlers['git:discard'](null, 's0', ['a.txt'])
    expect(res.ok).toBe(true)
    expect(res.snapshots['a.txt']).toMatch(/^[0-9a-f]{40}$/)
    const content = readFileSync(join(repo, 'a.txt'), 'utf-8')
    expect(content).toBe('one\n')
  })

  it('stash produces a ref the caller can use for undo', async () => {
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    const res = await handlers['git:stash'](null, 's0')
    expect(res.ok).toBe(true)
    expect(res.stashRef).toMatch(/^stash@\{\d+\}$/)
    const stashList = spawnSync('git', ['stash', 'list'], { cwd: repo }).stdout.toString()
    expect(stashList).toContain('stash@{0}')
  })

  it('popStash applies the top stash entry', async () => {
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    spawnSync('git', ['stash'], { cwd: repo })
    const res = await handlers['git:popStash'](null, 's0')
    expect(res.ok).toBe(true)
    const content = readFileSync(join(repo, 'a.txt'), 'utf-8')
    expect(content).toBe('dirty\n')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/main/ipc/git-handlers.test.ts`
Expected: FAIL — handlers not registered.

- [ ] **Step 3: Implement the handlers**

Append inside `registerGitHandlers()`:

```ts
  ipcMain.handle(IPC.GIT_DISCARD, async (_e, sid: string, paths: unknown) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) return { ok: false, error: 'invalid-paths' }
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    try {
      const snapshots: Record<string, string> = {}
      for (const p of paths as string[]) {
        const h = await runGit(ctx.cwd, ['hash-object', '-w', '--', p], { allowedCwds: ctx.allowed })
        if (h.code === 0) snapshots[p] = h.stdout.trim()
      }
      const argv = ['checkout', 'HEAD', '--', ...(paths as string[])]
      const out = await runGit(ctx.cwd, argv, { allowedCwds: ctx.allowed })
      void logGitWrite({ sid, cwd: ctx.cwd, argv, resultCode: out.code })
      return out.code === 0 ? { ok: true, snapshots } : { ok: false, error: out.stderr }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.GIT_STASH, async (_e, sid: string, message?: unknown) => {
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    try {
      const argv = typeof message === 'string' && message
        ? ['stash', 'push', '-m', message]
        : ['stash', 'push']
      const out = await runGit(ctx.cwd, argv, { allowedCwds: ctx.allowed })
      void logGitWrite({ sid, cwd: ctx.cwd, argv, resultCode: out.code })
      if (out.code !== 0) return { ok: false, error: out.stderr }
      return { ok: true, stashRef: 'stash@{0}' }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.GIT_POP_STASH, async (_e, sid: string, ref?: unknown) => {
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    try {
      const argv = typeof ref === 'string' && /^stash@\{\d+\}$/.test(ref)
        ? ['stash', 'pop', ref]
        : ['stash', 'pop']
      const out = await runGit(ctx.cwd, argv, { allowedCwds: ctx.allowed })
      void logGitWrite({ sid, cwd: ctx.cwd, argv, resultCode: out.code })
      return out.code === 0 ? { ok: true } : { ok: false, error: out.stderr }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/main/ipc/git-handlers.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/git-handlers.ts tests/unit/main/ipc/git-handlers.test.ts
git commit -m "feat(git): discard-with-snapshot, stash, and pop-stash handlers"
```

---

### Task 7: Branch list + switch with auto-stash handlers

`GIT_BRANCH_LIST` returns local branches + recent ones (via `git for-each-ref --sort=-committerdate`) + current upstream ahead/behind. `GIT_BRANCH_SWITCH` takes `{ name, createFrom?, autoStash?: boolean }`. When the tree is dirty and `autoStash` is true, it stashes first (returning the ref for the renderer's undo toast), switches, then re-applies on undo failure.

**Files:**
- Modify: `src/main/ipc/git-handlers.ts`
- Modify: `tests/unit/main/ipc/git-handlers.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/main/ipc/git-handlers.test.ts`:

```ts
  it('branchList returns the current branch plus recent refs', async () => {
    spawnSync('git', ['checkout', '-b', 'feat'], { cwd: repo })
    spawnSync('git', ['checkout', 'main'], { cwd: repo })
    const res = await handlers['git:branch:list'](null, 's0')
    expect(res.ok).toBe(true)
    expect(res.current).toBe('main')
    expect(res.recent.map((b: any) => b.name)).toContain('feat')
  })

  it('branchSwitch with autoStash handles a dirty tree without loss', async () => {
    spawnSync('git', ['checkout', '-b', 'feat'], { cwd: repo })
    spawnSync('git', ['checkout', 'main'], { cwd: repo })
    writeFileSync(join(repo, 'a.txt'), 'dirty\n')
    const res = await handlers['git:branch:switch'](null, 's0', { name: 'feat', autoStash: true })
    expect(res.ok).toBe(true)
    expect(res.stashRef).toBeDefined()
    const br = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }).stdout.toString().trim()
    expect(br).toBe('feat')
  })

  it('branchSwitch with createFrom creates a new branch from an existing ref', async () => {
    const res = await handlers['git:branch:switch'](null, 's0', { name: 'topic/x', createFrom: 'main' })
    expect(res.ok).toBe(true)
    const br = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo }).stdout.toString().trim()
    expect(br).toBe('topic/x')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/main/ipc/git-handlers.test.ts`
Expected: FAIL — `git:branch:list` / `git:branch:switch` unregistered.

- [ ] **Step 3: Implement the handlers**

Append inside `registerGitHandlers()`:

```ts
  ipcMain.handle(IPC.GIT_BRANCH_LIST, async (_e, sid: string) => {
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    try {
      const current = (await runGit(ctx.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { allowedCwds: ctx.allowed })).stdout.trim()
      const recent = await runGit(
        ctx.cwd,
        ['for-each-ref', '--sort=-committerdate', '--count=20', '--format=%(refname:short)|%(committerdate:unix)', 'refs/heads/'],
        { allowedCwds: ctx.allowed },
      )
      const branches = recent.stdout.trim().split('\n').filter(Boolean).map((l) => {
        const [name, at] = l.split('|')
        return { name, at: Number(at) * 1000 }
      })
      return { ok: true, current, recent: branches }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.GIT_BRANCH_SWITCH, async (_e, sid: string, opts: unknown) => {
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    if (!opts || typeof opts !== 'object') return { ok: false, error: 'invalid-opts' }
    const { name, createFrom, autoStash } = opts as { name?: unknown; createFrom?: unknown; autoStash?: unknown }
    if (typeof name !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(name)) return { ok: false, error: 'invalid-branch-name' }

    try {
      let stashRef: string | undefined
      if (autoStash === true) {
        const dirty = await runGit(ctx.cwd, ['status', '--porcelain'], { allowedCwds: ctx.allowed })
        if (dirty.stdout.trim().length > 0) {
          const stashArgv = ['stash', 'push', '-m', `auto-stash before switch to ${name}`]
          const out = await runGit(ctx.cwd, stashArgv, { allowedCwds: ctx.allowed })
          void logGitWrite({ sid, cwd: ctx.cwd, argv: stashArgv, resultCode: out.code })
          if (out.code !== 0) return { ok: false, error: out.stderr }
          stashRef = 'stash@{0}'
        }
      }

      const argv = typeof createFrom === 'string' && createFrom
        ? ['checkout', '-b', name, createFrom]
        : ['checkout', name]
      const out = await runGit(ctx.cwd, argv, { allowedCwds: ctx.allowed })
      void logGitWrite({ sid, cwd: ctx.cwd, argv, resultCode: out.code })
      if (out.code !== 0) return { ok: false, error: out.stderr, stashRef }
      return { ok: true, stashRef }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/main/ipc/git-handlers.test.ts`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/git-handlers.ts tests/unit/main/ipc/git-handlers.test.ts
git commit -m "feat(git): branch-list and branch-switch-with-autostash handlers"
```

---

### Task 8: Push / pull / commit-diff handlers

Push and pull surface stderr verbatim in their response so the confirm dialog can show failure text inline. Commit-diff returns the raw unified diff of a SHA via `git show --patch --no-color <sha>` — the renderer feeds it to `SanitizedMarkdown` wrapped in a fenced ```diff block.

**Files:**
- Modify: `src/main/ipc/git-handlers.ts`
- Modify: `tests/unit/main/ipc/git-handlers.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `tests/unit/main/ipc/git-handlers.test.ts`:

```ts
  it('push against a local bare remote succeeds and logs', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'ccc-bare-'))
    spawnSync('git', ['init', '--bare'], { cwd: bare })
    spawnSync('git', ['remote', 'add', 'origin', bare], { cwd: repo })
    const res = await handlers['git:push'](null, 's0', { remote: 'origin', refspec: 'main' })
    expect(res.ok).toBe(true)
    rmSync(bare, { recursive: true, force: true })
  })

  it('push surfaces stderr on failure', async () => {
    const res = await handlers['git:push'](null, 's0', { remote: 'nonexistent', refspec: 'main' })
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('commitDiff returns the patch text for a SHA', async () => {
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).stdout.toString().trim()
    const res = await handlers['git:commit:diff'](null, 's0', sha)
    expect(res.ok).toBe(true)
    expect(res.diff).toMatch(/seed\.txt/)
  })

  it('commitDiff rejects a sha that does not match the 40-hex format', async () => {
    const res = await handlers['git:commit:diff'](null, 's0', 'not-a-sha; rm -rf /')
    expect(res.ok).toBe(false)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/main/ipc/git-handlers.test.ts`
Expected: FAIL — handlers unregistered.

- [ ] **Step 3: Implement the handlers**

Append inside `registerGitHandlers()`:

```ts
  ipcMain.handle(IPC.GIT_PUSH, async (_e, sid: string, opts: unknown) => {
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    if (!opts || typeof opts !== 'object') return { ok: false, error: 'invalid-opts' }
    const { remote, refspec, force } = opts as { remote?: unknown; refspec?: unknown; force?: unknown }
    if (typeof remote !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(remote)) return { ok: false, error: 'invalid-remote' }
    if (typeof refspec !== 'string' || !/^[A-Za-z0-9._/:+-]+$/.test(refspec)) return { ok: false, error: 'invalid-refspec' }
    const argv = force === true ? ['push', '--force-with-lease', remote, refspec] : ['push', remote, refspec]
    try {
      const out = await runGit(ctx.cwd, argv, { allowedCwds: ctx.allowed, timeoutMs: 120_000 })
      void logGitWrite({ sid, cwd: ctx.cwd, argv, resultCode: out.code })
      return out.code === 0 ? { ok: true, stdout: out.stdout } : { ok: false, error: out.stderr || out.stdout }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.GIT_PULL, async (_e, sid: string, opts: unknown) => {
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    if (!opts || typeof opts !== 'object') return { ok: false, error: 'invalid-opts' }
    const { remote, refspec } = opts as { remote?: unknown; refspec?: unknown }
    if (typeof remote !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(remote)) return { ok: false, error: 'invalid-remote' }
    if (typeof refspec !== 'string' || !/^[A-Za-z0-9._/:+-]+$/.test(refspec)) return { ok: false, error: 'invalid-refspec' }
    const argv = ['pull', '--ff-only', remote, refspec]
    try {
      const out = await runGit(ctx.cwd, argv, { allowedCwds: ctx.allowed, timeoutMs: 120_000 })
      void logGitWrite({ sid, cwd: ctx.cwd, argv, resultCode: out.code })
      return out.code === 0 ? { ok: true, stdout: out.stdout } : { ok: false, error: out.stderr || out.stdout }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })

  ipcMain.handle(IPC.GIT_COMMIT_DIFF, async (_e, sid: string, sha: unknown) => {
    const ctx = resolveCwd(sid)
    if ('error' in ctx) return { ok: false, error: ctx.error }
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,40}$/.test(sha)) return { ok: false, error: 'invalid-sha' }
    try {
      const out = await runGit(ctx.cwd, ['show', '--patch', '--no-color', sha], {
        allowedCwds: ctx.allowed, maxBuffer: 16 * 1024 * 1024,
      })
      return out.code === 0 ? { ok: true, diff: out.stdout } : { ok: false, error: out.stderr }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
```

- [ ] **Step 4: Register from main boot**

In `src/main/index.ts`, after the existing `registerGithubHandlers()` call, add:

```ts
import { registerGitHandlers } from './ipc/git-handlers'
// …
registerGitHandlers()
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run tests/unit/main/ipc/git-handlers.test.ts && npm run typecheck`
Expected: PASS (15 tests total); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/git-handlers.ts src/main/index.ts tests/unit/main/ipc/git-handlers.test.ts
git commit -m "feat(git): push/pull (confirm-before) and commit-diff handlers"
```

---

### Task 9: Preload bridge + renderer types under `git:` namespace

**Files:**
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Create: `tests/unit/preload/git-bridge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/preload/git-bridge.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: () => undefined },
  ipcRenderer: { invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() },
}))

describe('preload git bridge', () => {
  it('exposes every local-git action method', async () => {
    const mod = await import('../../src/preload/index')
    const api = (mod as any).electronAPI
    const methods = ['status','stage','unstage','discard','stash','popStash','branchList','branchSwitch','push','pull','commitDiff']
    for (const m of methods) expect(typeof api.git[m]).toBe('function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/preload/git-bridge.test.ts`
Expected: FAIL — `api.git` undefined.

- [ ] **Step 3: Add the bridge**

In `src/preload/index.ts`, after the `github:` namespace block add:

```ts
    git: {
      status: (sid: string) => ipcRenderer.invoke(IPC.GIT_STATUS, sid),
      stage: (sid: string, paths: string[]) => ipcRenderer.invoke(IPC.GIT_STAGE, sid, paths),
      unstage: (sid: string, paths: string[]) => ipcRenderer.invoke(IPC.GIT_UNSTAGE, sid, paths),
      discard: (sid: string, paths: string[]) => ipcRenderer.invoke(IPC.GIT_DISCARD, sid, paths),
      stash: (sid: string, message?: string) => ipcRenderer.invoke(IPC.GIT_STASH, sid, message),
      popStash: (sid: string, ref?: string) => ipcRenderer.invoke(IPC.GIT_POP_STASH, sid, ref),
      branchList: (sid: string) => ipcRenderer.invoke(IPC.GIT_BRANCH_LIST, sid),
      branchSwitch: (sid: string, opts: { name: string; createFrom?: string; autoStash?: boolean }) =>
        ipcRenderer.invoke(IPC.GIT_BRANCH_SWITCH, sid, opts),
      push: (sid: string, opts: { remote: string; refspec: string; force?: boolean }) =>
        ipcRenderer.invoke(IPC.GIT_PUSH, sid, opts),
      pull: (sid: string, opts: { remote: string; refspec: string }) =>
        ipcRenderer.invoke(IPC.GIT_PULL, sid, opts),
      commitDiff: (sid: string, sha: string) => ipcRenderer.invoke(IPC.GIT_COMMIT_DIFF, sid, sha),
    },
```

In `src/renderer/types/electron.d.ts`, add the matching interface block:

```ts
    git: {
      status(sid: string): Promise<{ ok: boolean; error?: string; state?: { staged: GitFileEntry[]; unstaged: GitFileEntry[]; untracked: GitFileEntry[] } }>
      stage(sid: string, paths: string[]): Promise<{ ok: boolean; error?: string }>
      unstage(sid: string, paths: string[]): Promise<{ ok: boolean; error?: string }>
      discard(sid: string, paths: string[]): Promise<{ ok: boolean; error?: string; snapshots?: Record<string, string> }>
      stash(sid: string, message?: string): Promise<{ ok: boolean; error?: string; stashRef?: string }>
      popStash(sid: string, ref?: string): Promise<{ ok: boolean; error?: string }>
      branchList(sid: string): Promise<{ ok: boolean; error?: string; current?: string; recent?: Array<{ name: string; at: number }> }>
      branchSwitch(sid: string, opts: { name: string; createFrom?: string; autoStash?: boolean }): Promise<{ ok: boolean; error?: string; stashRef?: string }>
      push(sid: string, opts: { remote: string; refspec: string; force?: boolean }): Promise<{ ok: boolean; error?: string; stdout?: string }>
      pull(sid: string, opts: { remote: string; refspec: string }): Promise<{ ok: boolean; error?: string; stdout?: string }>
      commitDiff(sid: string, sha: string): Promise<{ ok: boolean; error?: string; diff?: string }>
    }
```

Also re-export the `GitFileEntry` type from `src/main/ipc/git-handlers.ts` via a small shared type file `src/shared/git-types.ts`:

```ts
export interface GitFileEntry {
  path: string
  status: 'M' | 'A' | 'D' | 'R' | '?'
  added: number
  removed: number
}
```

Then import it in both the handler and the `electron.d.ts`.

- [ ] **Step 4: Run test + typecheck**

Run: `npx vitest run tests/unit/preload/git-bridge.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/preload/index.ts src/renderer/types/electron.d.ts src/shared/git-types.ts src/main/ipc/git-handlers.ts tests/unit/preload/git-bridge.test.ts
git commit -m "feat(git): preload bridge under git: namespace with typed contract"
```

---

### Task 10: `localGitStore` Zustand — per-session state + actions

Holds `{ statusBySession, recentBranchesBySession, currentBranchBySession, stashRefBySession }` plus action thunks that call the bridge and optimistically mutate cache. Undoable actions return the data the renderer needs to build a `ToastUndo` payload (pre-action snapshot or stash ref).

**Files:**
- Create: `src/renderer/stores/localGitStore.ts`
- Create: `tests/unit/renderer/stores/localGitStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renderer/stores/localGitStore.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

const bridge = {
  status: vi.fn(async () => ({ ok: true, state: { staged: [], unstaged: [{ path: 'a.txt', status: 'M', added: 1, removed: 0 }], untracked: [] } })),
  stage: vi.fn(async () => ({ ok: true })),
  unstage: vi.fn(async () => ({ ok: true })),
  discard: vi.fn(async () => ({ ok: true, snapshots: { 'a.txt': 'abc123' } })),
  stash: vi.fn(async () => ({ ok: true, stashRef: 'stash@{0}' })),
  popStash: vi.fn(async () => ({ ok: true })),
  branchList: vi.fn(async () => ({ ok: true, current: 'main', recent: [{ name: 'feat', at: 1 }] })),
  branchSwitch: vi.fn(async () => ({ ok: true })),
}
;(globalThis as any).window = { electronAPI: { git: bridge } }

import { useLocalGitStore } from '../../../src/renderer/stores/localGitStore'

describe('localGitStore', () => {
  beforeEach(() => {
    useLocalGitStore.setState({ statusBySession: {}, branchDataBySession: {} })
    for (const v of Object.values(bridge)) (v as any).mockClear()
  })

  it('refreshStatus populates statusBySession', async () => {
    await useLocalGitStore.getState().refreshStatus('s1')
    expect(useLocalGitStore.getState().statusBySession.s1?.unstaged.length).toBe(1)
  })

  it('stage calls the bridge and refreshes', async () => {
    await useLocalGitStore.getState().stage('s1', ['a.txt'])
    expect(bridge.stage).toHaveBeenCalledWith('s1', ['a.txt'])
    expect(bridge.status).toHaveBeenCalled()
  })

  it('discard returns snapshots for undo', async () => {
    const res = await useLocalGitStore.getState().discard('s1', ['a.txt'])
    expect(res.ok).toBe(true)
    expect(res.snapshots?.['a.txt']).toBe('abc123')
  })

  it('refreshBranches hydrates branch data', async () => {
    await useLocalGitStore.getState().refreshBranches('s1')
    expect(useLocalGitStore.getState().branchDataBySession.s1?.current).toBe('main')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/stores/localGitStore.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `src/renderer/stores/localGitStore.ts`:

```ts
import { create } from 'zustand'
import type { GitFileEntry } from '../../shared/git-types'

interface GitStatus { staged: GitFileEntry[]; unstaged: GitFileEntry[]; untracked: GitFileEntry[] }
interface BranchData { current: string; recent: Array<{ name: string; at: number }> }

interface LocalGitState {
  statusBySession: Record<string, GitStatus>
  branchDataBySession: Record<string, BranchData>
  refreshStatus(sid: string): Promise<void>
  refreshBranches(sid: string): Promise<void>
  stage(sid: string, paths: string[]): Promise<{ ok: boolean; error?: string }>
  unstage(sid: string, paths: string[]): Promise<{ ok: boolean; error?: string }>
  discard(sid: string, paths: string[]): Promise<{ ok: boolean; error?: string; snapshots?: Record<string, string> }>
  stash(sid: string, message?: string): Promise<{ ok: boolean; error?: string; stashRef?: string }>
  popStash(sid: string, ref?: string): Promise<{ ok: boolean; error?: string }>
  branchSwitch(sid: string, opts: { name: string; createFrom?: string; autoStash?: boolean }): Promise<{ ok: boolean; error?: string; stashRef?: string }>
}

export const useLocalGitStore = create<LocalGitState>((set, get) => ({
  statusBySession: {},
  branchDataBySession: {},
  refreshStatus: async (sid) => {
    const r = await window.electronAPI.git.status(sid)
    if (r.ok && r.state) set({ statusBySession: { ...get().statusBySession, [sid]: r.state } })
  },
  refreshBranches: async (sid) => {
    const r = await window.electronAPI.git.branchList(sid)
    if (r.ok && r.current) set({ branchDataBySession: { ...get().branchDataBySession, [sid]: { current: r.current, recent: r.recent ?? [] } } })
  },
  stage: async (sid, paths) => { const r = await window.electronAPI.git.stage(sid, paths); await get().refreshStatus(sid); return r },
  unstage: async (sid, paths) => { const r = await window.electronAPI.git.unstage(sid, paths); await get().refreshStatus(sid); return r },
  discard: async (sid, paths) => { const r = await window.electronAPI.git.discard(sid, paths); await get().refreshStatus(sid); return r },
  stash: async (sid, message) => { const r = await window.electronAPI.git.stash(sid, message); await get().refreshStatus(sid); return r },
  popStash: async (sid, ref) => { const r = await window.electronAPI.git.popStash(sid, ref); await get().refreshStatus(sid); return r },
  branchSwitch: async (sid, opts) => { const r = await window.electronAPI.git.branchSwitch(sid, opts); await get().refreshStatus(sid); await get().refreshBranches(sid); return r },
}))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/renderer/stores/localGitStore.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/stores/localGitStore.ts tests/unit/renderer/stores/localGitStore.test.ts
git commit -m "feat(git): localGitStore — per-session status, branches, and actions"
```

---

### Task 11: `<ConfirmDialog>` reusable confirm with exact-git-command body

Focus lands on Cancel (per the convention note). Body renders a monospace `<pre>` with the exact argv that will run. Submit is red when the operation is flagged destructive.

**Files:**
- Create: `src/renderer/components/github/localgit/ConfirmDialog.tsx`
- Create: `tests/unit/renderer/components/github/localgit/ConfirmDialog.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/renderer/components/github/localgit/ConfirmDialog.test.tsx`:

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmDialog } from '../../../../src/renderer/components/github/localgit/ConfirmDialog'

describe('ConfirmDialog', () => {
  it('renders the exact argv body verbatim', () => {
    render(
      <ConfirmDialog
        open title="Push to origin"
        argv={['push', 'origin', 'main']}
        onConfirm={() => undefined} onCancel={() => undefined}
      />,
    )
    expect(screen.getByText(/git push origin main/)).toBeInTheDocument()
  })

  it('focuses Cancel by default', () => {
    render(
      <ConfirmDialog
        open title="t" argv={['a']}
        onConfirm={() => undefined} onCancel={() => undefined}
      />,
    )
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /cancel/i }))
  })

  it('Esc triggers onCancel', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDialog open title="t" argv={['a']} onConfirm={() => undefined} onCancel={onCancel} />,
    )
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalled()
  })

  it('destructive variant renders a red confirm button', () => {
    render(
      <ConfirmDialog open destructive title="t" argv={['a']} onConfirm={() => undefined} onCancel={() => undefined} />,
    )
    const btn = screen.getByRole('button', { name: /confirm/i })
    expect(btn.className).toMatch(/red/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/github/localgit/ConfirmDialog.test.tsx`
Expected: FAIL — component missing.

- [ ] **Step 3: Implement the component**

Create `src/renderer/components/github/localgit/ConfirmDialog.tsx`:

```tsx
import React, { useEffect, useRef } from 'react'

interface Props {
  open: boolean
  title: string
  description?: string
  argv: string[]
  stderr?: string
  destructive?: boolean
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, description, argv, stderr, destructive, onConfirm, onCancel }: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (open) cancelRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div role="dialog" aria-modal="true" aria-label={title}
      className="fixed inset-0 z-40 flex items-center justify-center bg-crust/70">
      <div className="w-[420px] rounded border border-surface0 bg-base p-4 shadow-xl">
        <div className="text-sm font-semibold text-text">{title}</div>
        {description && <div className="mt-1 text-xs text-subtext0">{description}</div>}
        <pre className="mt-3 overflow-x-auto rounded bg-mantle p-2 font-mono text-xs text-subtext1">
          git {argv.join(' ')}
        </pre>
        {stderr && (
          <pre className="mt-2 overflow-x-auto rounded border border-red/30 bg-mantle p-2 font-mono text-xs text-red">
            {stderr}
          </pre>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            onClick={onCancel}
            className="rounded border border-surface1 px-3 py-1 text-xs text-subtext1 hover:bg-surface0"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className={`rounded px-3 py-1 text-xs text-base ${destructive ? 'bg-red hover:bg-red/90' : 'bg-blue hover:bg-blue/90'}`}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/renderer/components/github/localgit/ConfirmDialog.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/localgit/ConfirmDialog.tsx tests/unit/renderer/components/github/localgit/ConfirmDialog.test.tsx
git commit -m "feat(git): ConfirmDialog with exact-command body and Cancel-default focus"
```

---

### Task 12: `<FileStatusList>` — per-file checkbox + status code + numstat + discard

Renders two groups (staged / unstaged), untracked rolled into unstaged with `?` status. Per-row checkbox toggles stage/unstage. Row header shows `M/A/D/R/?` + `+N/-M`. Unstaged rows include a red `⚠ Discard` button that surfaces a `ToastUndo` through the section's undo toast slot.

**Files:**
- Create: `src/renderer/components/github/localgit/FileStatusList.tsx`
- Create: `tests/unit/renderer/components/github/localgit/FileStatusList.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileStatusList } from '../../../../src/renderer/components/github/localgit/FileStatusList'

const status = {
  staged: [{ path: 'a.txt', status: 'M' as const, added: 3, removed: 1 }],
  unstaged: [{ path: 'b.txt', status: 'M' as const, added: 2, removed: 0 }],
  untracked: [{ path: 'c.txt', status: '?' as const, added: 0, removed: 0 }],
}

describe('FileStatusList', () => {
  it('renders a row per file with status and +/-', () => {
    render(<FileStatusList status={status} onStage={vi.fn()} onUnstage={vi.fn()} onDiscard={vi.fn()} onStageAll={vi.fn()} onUnstageAll={vi.fn()} />)
    expect(screen.getByText('a.txt')).toBeInTheDocument()
    expect(screen.getByText(/\+3/)).toBeInTheDocument()
    expect(screen.getByText(/-1/)).toBeInTheDocument()
  })

  it('clicking an unstaged checkbox calls onStage with that path', () => {
    const onStage = vi.fn()
    render(<FileStatusList status={status} onStage={onStage} onUnstage={vi.fn()} onDiscard={vi.fn()} onStageAll={vi.fn()} onUnstageAll={vi.fn()} />)
    fireEvent.click(screen.getByTestId('stage-b.txt'))
    expect(onStage).toHaveBeenCalledWith(['b.txt'])
  })

  it('clicking Discard calls onDiscard', () => {
    const onDiscard = vi.fn()
    render(<FileStatusList status={status} onStage={vi.fn()} onUnstage={vi.fn()} onDiscard={onDiscard} onStageAll={vi.fn()} onUnstageAll={vi.fn()} />)
    fireEvent.click(screen.getByTestId('discard-b.txt'))
    expect(onDiscard).toHaveBeenCalledWith(['b.txt'])
  })

  it('Stage all / Unstage all buttons call the bulk handlers', () => {
    const onStageAll = vi.fn()
    const onUnstageAll = vi.fn()
    render(<FileStatusList status={status} onStage={vi.fn()} onUnstage={vi.fn()} onDiscard={vi.fn()} onStageAll={onStageAll} onUnstageAll={onUnstageAll} />)
    fireEvent.click(screen.getByRole('button', { name: /stage all/i }))
    fireEvent.click(screen.getByRole('button', { name: /unstage all/i }))
    expect(onStageAll).toHaveBeenCalled()
    expect(onUnstageAll).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/github/localgit/FileStatusList.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the component**

Create `src/renderer/components/github/localgit/FileStatusList.tsx`:

```tsx
import React from 'react'
import type { GitFileEntry } from '../../../../shared/git-types'

interface Props {
  status: { staged: GitFileEntry[]; unstaged: GitFileEntry[]; untracked: GitFileEntry[] }
  onStage(paths: string[]): void
  onUnstage(paths: string[]): void
  onDiscard(paths: string[]): void
  onStageAll(): void
  onUnstageAll(): void
}

function StatusBadge({ code }: { code: GitFileEntry['status'] }) {
  const color = code === 'M' ? 'text-yellow'
    : code === 'A' ? 'text-green'
    : code === 'D' ? 'text-red'
    : code === 'R' ? 'text-sky'
    : 'text-overlay0'
  return <span className={`font-mono text-[10px] ${color}`}>{code}</span>
}

function NumstatPill({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null
  return (
    <span className="font-mono text-[10px] text-overlay1">
      <span className="text-green">+{added}</span> <span className="text-red">-{removed}</span>
    </span>
  )
}

export function FileStatusList({ status, onStage, onUnstage, onDiscard, onStageAll, onUnstageAll }: Props) {
  const unstagedAll = [...status.unstaged, ...status.untracked]
  return (
    <div className="flex flex-col gap-3">
      <section>
        <header className="mb-1 flex items-center justify-between text-xs text-subtext0">
          <span>Staged ({status.staged.length})</span>
          <button className="rounded px-2 py-0.5 text-[10px] text-subtext1 hover:bg-surface0" onClick={onUnstageAll}>
            Unstage all
          </button>
        </header>
        <ul className="flex flex-col gap-1">
          {status.staged.map((f) => (
            <li key={f.path} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox" checked readOnly
                data-testid={`unstage-${f.path}`}
                onClick={() => onUnstage([f.path])}
              />
              <StatusBadge code={f.status} />
              <span className="flex-1 truncate font-mono">{f.path}</span>
              <NumstatPill added={f.added} removed={f.removed} />
            </li>
          ))}
        </ul>
      </section>

      <section>
        <header className="mb-1 flex items-center justify-between text-xs text-subtext0">
          <span>Unstaged ({unstagedAll.length})</span>
          <button className="rounded px-2 py-0.5 text-[10px] text-subtext1 hover:bg-surface0" onClick={onStageAll}>
            Stage all
          </button>
        </header>
        <ul className="flex flex-col gap-1">
          {unstagedAll.map((f) => (
            <li key={f.path} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                data-testid={`stage-${f.path}`}
                onClick={() => onStage([f.path])}
              />
              <StatusBadge code={f.status} />
              <span className="flex-1 truncate font-mono">{f.path}</span>
              <NumstatPill added={f.added} removed={f.removed} />
              <button
                data-testid={`discard-${f.path}`}
                onClick={() => onDiscard([f.path])}
                className="rounded px-2 py-0.5 text-[10px] text-red hover:bg-red/10"
                aria-label={`Discard changes to ${f.path}`}
              >
                Discard
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/renderer/components/github/localgit/FileStatusList.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/localgit/FileStatusList.tsx tests/unit/renderer/components/github/localgit/FileStatusList.test.tsx
git commit -m "feat(git): FileStatusList with per-file checkbox, numstat, and discard"
```

---

### Task 13: `<BranchSwitcher>` dropdown with recent + create-new + dirty handling

Renders current branch as a pill button. Clicking opens a popover with recent branches, a "New branch from here" input, and an auto-stash checkbox when the tree is dirty. Switch invokes the store; if the result includes a `stashRef`, the caller receives it to build an "Undo" toast that pops the stash + switches back.

**Files:**
- Create: `src/renderer/components/github/localgit/BranchSwitcher.tsx`
- Create: `tests/unit/renderer/components/github/localgit/BranchSwitcher.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BranchSwitcher } from '../../../../src/renderer/components/github/localgit/BranchSwitcher'

describe('BranchSwitcher', () => {
  it('renders the current branch and recent branches on click', () => {
    render(<BranchSwitcher
      current="main" recent={[{ name: 'feat', at: 1 }]}
      dirty={false} onSwitch={vi.fn()} onCreate={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: /main/i }))
    expect(screen.getByText('feat')).toBeInTheDocument()
  })

  it('surfaces the auto-stash checkbox when dirty', () => {
    render(<BranchSwitcher
      current="main" recent={[{ name: 'feat', at: 1 }]}
      dirty onSwitch={vi.fn()} onCreate={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: /main/i }))
    expect(screen.getByLabelText(/auto-stash/i)).toBeInTheDocument()
  })

  it('clicking a recent branch calls onSwitch with autoStash from checkbox', () => {
    const onSwitch = vi.fn()
    render(<BranchSwitcher
      current="main" recent={[{ name: 'feat', at: 1 }]}
      dirty onSwitch={onSwitch} onCreate={vi.fn()}
    />)
    fireEvent.click(screen.getByRole('button', { name: /main/i }))
    fireEvent.click(screen.getByLabelText(/auto-stash/i)) // check it
    fireEvent.click(screen.getByRole('button', { name: /^feat$/ }))
    expect(onSwitch).toHaveBeenCalledWith('feat', { autoStash: true })
  })

  it('Create new branch calls onCreate with the typed name', () => {
    const onCreate = vi.fn()
    render(<BranchSwitcher
      current="main" recent={[{ name: 'feat', at: 1 }]}
      dirty={false} onSwitch={vi.fn()} onCreate={onCreate}
    />)
    fireEvent.click(screen.getByRole('button', { name: /main/i }))
    fireEvent.change(screen.getByPlaceholderText(/new branch name/i), { target: { value: 'topic/x' } })
    fireEvent.click(screen.getByRole('button', { name: /create/i }))
    expect(onCreate).toHaveBeenCalledWith('topic/x')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/github/localgit/BranchSwitcher.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the component**

Create `src/renderer/components/github/localgit/BranchSwitcher.tsx`:

```tsx
import React, { useState } from 'react'

interface Props {
  current: string
  recent: Array<{ name: string; at: number }>
  dirty: boolean
  onSwitch(name: string, opts: { autoStash: boolean }): void
  onCreate(name: string): void
}

export function BranchSwitcher({ current, recent, dirty, onSwitch, onCreate }: Props) {
  const [open, setOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [autoStash, setAutoStash] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded border border-surface0 bg-mantle px-2 py-0.5 text-xs text-text hover:bg-surface0"
      >
        <span className="font-mono">{current}</span>
        <span className="text-overlay0">{String.fromCodePoint(0x25BE)}</span>
      </button>
      {open && (
        <div className="absolute left-0 top-7 z-20 w-64 rounded border border-surface0 bg-base p-2 shadow-lg">
          <div className="px-1 pb-1 text-[10px] uppercase tracking-wide text-overlay0">Recent</div>
          <ul className="flex flex-col gap-0.5">
            {recent.filter((b) => b.name !== current).map((b) => (
              <li key={b.name}>
                <button
                  onClick={() => { onSwitch(b.name, { autoStash }); setOpen(false) }}
                  className="w-full rounded px-2 py-1 text-left text-xs hover:bg-surface0"
                >
                  {b.name}
                </button>
              </li>
            ))}
          </ul>
          <div className="my-2 border-t border-surface0" />
          {dirty && (
            <label className="mb-2 flex items-center gap-2 px-1 text-[11px] text-subtext0">
              <input type="checkbox" checked={autoStash} onChange={(e) => setAutoStash(e.target.checked)} />
              <span>Auto-stash working tree</span>
            </label>
          )}
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="New branch name"
            className="w-full rounded border border-surface0 bg-mantle px-2 py-1 text-xs text-text placeholder:text-overlay0"
          />
          <button
            disabled={!newName}
            onClick={() => { onCreate(newName); setNewName(''); setOpen(false) }}
            className="mt-2 w-full rounded bg-blue px-2 py-1 text-xs text-base hover:bg-blue/90 disabled:opacity-40"
          >
            Create
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/renderer/components/github/localgit/BranchSwitcher.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/localgit/BranchSwitcher.tsx tests/unit/renderer/components/github/localgit/BranchSwitcher.test.tsx
git commit -m "feat(git): BranchSwitcher with recent list, auto-stash, create-new"
```

---

### Task 14: `<CommitDiffModal>` — fetch + render a commit's patch

Modal overlays the panel. On mount, calls `git.commitDiff(sid, sha)`. The diff body goes through `SanitizedMarkdown` wrapped in a ```diff fence so the existing markdown renderer colours it.

**Files:**
- Create: `src/renderer/components/github/localgit/CommitDiffModal.tsx`
- Create: `tests/unit/renderer/components/github/localgit/CommitDiffModal.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
;(globalThis as any).window = { electronAPI: { git: { commitDiff: vi.fn(async () => ({ ok: true, diff: '--- a/x\n+++ b/x\n' })) } } }
import { CommitDiffModal } from '../../../../src/renderer/components/github/localgit/CommitDiffModal'

describe('CommitDiffModal', () => {
  it('fetches the diff and renders it in a diff fence', async () => {
    render(<CommitDiffModal sid="s1" sha="abc1234" subject="x" onClose={() => undefined} />)
    await waitFor(() => expect(screen.getByText(/\+\+\+ b\/x/)).toBeInTheDocument())
  })

  it('shows an error state when commitDiff fails', async () => {
    ;(window as any).electronAPI.git.commitDiff = vi.fn(async () => ({ ok: false, error: 'nope' }))
    render(<CommitDiffModal sid="s1" sha="abc1234" subject="x" onClose={() => undefined} />)
    await waitFor(() => expect(screen.getByText(/nope/)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/renderer/components/github/localgit/CommitDiffModal.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement the component**

Create `src/renderer/components/github/localgit/CommitDiffModal.tsx`:

```tsx
import React, { useEffect, useState } from 'react'
import SanitizedMarkdown from '../../SanitizedMarkdown'

interface Props {
  sid: string
  sha: string
  subject: string
  onClose(): void
}

export function CommitDiffModal({ sid, sha, subject, onClose }: Props) {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    window.electronAPI.git.commitDiff(sid, sha).then((r) => {
      if (!alive) return
      if (r.ok && r.diff !== undefined) setDiff(r.diff)
      else setError(r.error || 'failed to load diff')
    })
    return () => { alive = false }
  }, [sid, sha])

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div role="dialog" aria-modal="true" aria-label={`Commit ${sha}`}
      className="fixed inset-0 z-40 flex items-center justify-center bg-crust/70">
      <div className="max-h-[80vh] w-[720px] overflow-hidden rounded border border-surface0 bg-base shadow-xl">
        <header className="flex items-center justify-between border-b border-surface0 px-3 py-2 text-xs">
          <span className="font-mono text-subtext1">{sha.slice(0, 7)}</span>
          <span className="flex-1 truncate px-2 text-text">{subject}</span>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-overlay0 hover:bg-surface0">
            {String.fromCodePoint(0x2715)}
          </button>
        </header>
        <div className="max-h-[70vh] overflow-auto p-3">
          {error && <div className="text-xs text-red">{error}</div>}
          {diff !== null && (
            <SanitizedMarkdown markdown={'```diff\n' + diff + '\n```'} />
          )}
          {diff === null && !error && <div className="text-xs text-overlay0">Loading diff</div>}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run tests to verify green**

Run: `npx vitest run tests/unit/renderer/components/github/localgit/CommitDiffModal.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/github/localgit/CommitDiffModal.tsx tests/unit/renderer/components/github/localgit/CommitDiffModal.test.tsx
git commit -m "feat(git): CommitDiffModal — fetch + render via SanitizedMarkdown"
```

---

### Task 15: Overhaul `LocalGitSection.tsx` to compose the new parts

Wire everything together:
- Replace the polling `getLocalGit` hook with `useLocalGitStore().refreshStatus + refreshBranches`, still polling every 15s.
- Replace the file list with `<FileStatusList>`.
- Add `<BranchSwitcher>` in the header row.
- Render push / pull buttons that are disabled when `ahead === 0` / `behind === 0`. Clicking opens `<ConfirmDialog>` with the exact argv.
- Ask-Claude-to-commit button calls the Phase 2 `claude-input-queue` helper (see Task 16 below for the readiness contract integration).
- Discard invokes the `ToastUndo` (from Phase 2) with the snapshots map in the payload.
- Recent-commit click opens `<CommitDiffModal>`.

**Files:**
- Modify: `src/renderer/components/github/sections/LocalGitSection.tsx`

- [ ] **Step 1: Read the existing section**

Open `LocalGitSection.tsx` and list what's already rendered.

- [ ] **Step 2: Rewrite composition**

Replace the body with the composed version. Highlights (not full file — inline into the existing `SectionFrame` scaffolding):

```tsx
const status = useLocalGitStore((s) => s.statusBySession[sessionId])
const branches = useLocalGitStore((s) => s.branchDataBySession[sessionId])
const refreshStatus = useLocalGitStore((s) => s.refreshStatus)
const refreshBranches = useLocalGitStore((s) => s.refreshBranches)
const stage = useLocalGitStore((s) => s.stage)
const unstage = useLocalGitStore((s) => s.unstage)
const discard = useLocalGitStore((s) => s.discard)
const stash = useLocalGitStore((s) => s.stash)
const popStash = useLocalGitStore((s) => s.popStash)
const branchSwitch = useLocalGitStore((s) => s.branchSwitch)

useEffect(() => {
  void refreshStatus(sessionId); void refreshBranches(sessionId)
  const t = setInterval(() => { void refreshStatus(sessionId); void refreshBranches(sessionId) }, 15_000)
  return () => clearInterval(t)
}, [sessionId, refreshStatus, refreshBranches])

// push / pull confirm dialog state
const [confirm, setConfirm] = useState<null | { title: string; argv: string[]; onGo: () => void; destructive?: boolean }>(null)
```

Render (simplified):

```tsx
<SectionFrame sessionId={sessionId} id="localGit" title="Local Git" summary={summary}>
  <div className="flex items-center justify-between mb-2">
    <BranchSwitcher
      current={branches?.current ?? '—'}
      recent={branches?.recent ?? []}
      dirty={dirty}
      onSwitch={(name, { autoStash }) => branchSwitch(sessionId, { name, autoStash })}
      onCreate={(name) => branchSwitch(sessionId, { name, createFrom: branches?.current, autoStash: dirty })}
    />
    <div className="flex gap-1">
      <button
        disabled={!(ahead > 0)}
        onClick={() => setConfirm({
          title: `Push ${ahead} commit(s) to origin/${branches?.current}`,
          argv: ['push', 'origin', branches!.current],
          onGo: async () => {
            const r = await window.electronAPI.git.push(sessionId, { remote: 'origin', refspec: branches!.current })
            if (!r.ok) setConfirm((c) => c ? { ...c, stderr: r.error } as any : c)
            else setConfirm(null)
          },
        })}
        className="rounded bg-green px-2 py-0.5 text-xs text-base disabled:opacity-30"
      >Push ↑{ahead}</button>
      <button
        disabled={!(behind > 0)}
        onClick={() => setConfirm({
          title: `Pull ${behind} commit(s) from origin/${branches?.current}`,
          argv: ['pull', '--ff-only', 'origin', branches!.current],
          onGo: async () => { await window.electronAPI.git.pull(sessionId, { remote: 'origin', refspec: branches!.current }); setConfirm(null) },
        })}
        className="rounded bg-blue px-2 py-0.5 text-xs text-base disabled:opacity-30"
      >Pull ↓{behind}</button>
    </div>
  </div>

  <FileStatusList
    status={status ?? { staged: [], unstaged: [], untracked: [] }}
    onStage={(paths) => stage(sessionId, paths)}
    onUnstage={(paths) => unstage(sessionId, paths)}
    onStageAll={() => stage(sessionId, unstagedPaths)}
    onUnstageAll={() => unstage(sessionId, stagedPaths)}
    onDiscard={async (paths) => {
      const r = await discard(sessionId, paths)
      if (r.ok && r.snapshots) pushUndoToast({ label: `Discarded ${paths.length} file(s)`, onUndo: async () => {
        for (const [p, blob] of Object.entries(r.snapshots!)) {
          // restore via git cat-file (bridged through a new undo handler in a later phase if needed)
        }
      }})
    }}
  />

  {/* stash row, Ask-Claude-to-commit, recent commits — see Tasks 16 & 17 */}

  {confirm && (
    <ConfirmDialog
      open title={confirm.title} argv={confirm.argv} destructive={confirm.destructive}
      onConfirm={confirm.onGo} onCancel={() => setConfirm(null)}
    />
  )}
</SectionFrame>
```

Run typecheck + existing section tests (should still pass; the polling reducer moved into the store but observable behaviour is equivalent).

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/github/sections/LocalGitSection.tsx
git commit -m "feat(git): LocalGitSection composes BranchSwitcher/FileStatusList/Confirm"
```

---

### Task 16: Wire "Ask Claude to commit" through the readiness contract

Calls the Phase 2 helper `src/renderer/lib/claude-input-queue.ts` with the literal string `Review the staged diff and write a commit message.`. The helper handles idle-vs-busy detection, focus switch, and queued-firing.

**Files:**
- Modify: `src/renderer/components/github/sections/LocalGitSection.tsx`

- [ ] **Step 1: Verify the Phase 2 helper exists**

Run: `grep -n "claude-input-queue" -r F:/CLAUDE_MULTI_APP/src/renderer` to confirm the helper from PR `feat/sidebar-easy-wins` has landed. If not, this task blocks until that PR merges — flag in PR description.

- [ ] **Step 2: Add the button**

Inside the section (after the file list), add:

```tsx
const anyStaged = (status?.staged.length ?? 0) > 0
<button
  disabled={!anyStaged}
  onClick={() => queueClaudeInput(sessionId, 'Review the staged diff and write a commit message.')}
  className="mt-2 rounded border border-surface0 px-2 py-1 text-xs text-subtext1 hover:bg-surface0 disabled:opacity-40"
  aria-label="Ask Claude to write a commit message for the staged diff"
>
  {String.fromCodePoint(0x1F4AC)} Ask Claude to commit
</button>
```

Import from `../../../lib/claude-input-queue`.

- [ ] **Step 3: Smoke test**

In a dev session, stage a file, click the button. Verify the literal text lands in the Claude input (either immediately when idle, or after the busy toast accepts queueing).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/github/sections/LocalGitSection.tsx
git commit -m "feat(git): Ask-Claude-to-commit via Phase 2 readiness contract"
```

---

### Task 17: Wire recent-commits + stash row

Stash row shows `Stash (N)` pill + `Stash` / `Pop` buttons. Recent commits clickable → opens `<CommitDiffModal>`.

**Files:**
- Modify: `src/renderer/components/github/sections/LocalGitSection.tsx`

- [ ] **Step 1: Add stash row**

```tsx
<div className="mt-2 flex items-center justify-between text-xs text-subtext1">
  <span>Stashes <span className="rounded bg-surface0 px-1 text-[10px] text-subtext0">{stashCount}</span></span>
  <div className="flex gap-1">
    <button onClick={async () => { const r = await stash(sessionId); if (r.ok) pushUndoToast({ label: 'Stashed changes', onUndo: () => popStash(sessionId, r.stashRef) }) }}
      disabled={!dirty}
      className="rounded px-2 py-0.5 text-[11px] hover:bg-surface0 disabled:opacity-40">Stash</button>
    <button onClick={async () => { const r = await popStash(sessionId); if (r.ok) pushUndoToast({ label: 'Popped stash', onUndo: () => stash(sessionId) }) }}
      disabled={stashCount === 0}
      className="rounded px-2 py-0.5 text-[11px] hover:bg-surface0 disabled:opacity-40">Pop</button>
  </div>
</div>
```

- [ ] **Step 2: Wire recent commits**

Render the recent commits list (still fed from the legacy `getLocalGit` path or extend `GIT_STATUS` to include them — pick one; spec says reuse SanitizedMarkdown for the diff, it doesn't say commits must change shape). On row click:

```tsx
const [diffFor, setDiffFor] = useState<{ sha: string; subject: string } | null>(null)
// …
{recent.map((c) => (
  <button key={c.sha} onClick={() => setDiffFor({ sha: c.sha, subject: c.subject })} className="text-left hover:bg-surface0 …">
    <span className="font-mono">{c.sha.slice(0, 7)}</span> <span>{c.subject}</span>
  </button>
))}
{diffFor && <CommitDiffModal sid={sessionId} sha={diffFor.sha} subject={diffFor.subject} onClose={() => setDiffFor(null)} />}
```

- [ ] **Step 3: Typecheck + smoke**

Run: `npm run typecheck && npm run dev`. In dev, click a recent commit; verify the modal opens with the diff rendered.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/github/sections/LocalGitSection.tsx
git commit -m "feat(git): stash row and commit-diff modal wiring"
```

---

### Task 18: Full-run verification + manual smoke-test script

**Files:**
- (none — run verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS with no new errors.

- [ ] **Step 2: Full unit test run**

Run: `npx vitest run`
Expected: PASS — all new + existing tests green.

- [ ] **Step 3: Manual smoke test against a temp repo**

Run the script below from a scratch bash in the app's dev environment — it exercises every write path end-to-end against a local bare remote so push succeeds without a network:

```bash
# Scratch: temp repo + bare remote for push smoke.
tmp=$(mktemp -d); bare=$(mktemp -d)
pushd "$tmp"
git init --initial-branch=main
git config user.email t@x; git config user.name T
echo hi > a.txt; git add .; git commit -m seed
git init --bare "$bare"
git remote add origin "$bare"
git push -u origin main

# Now open Claude Command Center, point a session's cwd at $tmp, then:
# 1) Edit a.txt. Refresh section. Expect a.txt as "M +1/-1" unstaged.
# 2) Click checkbox on a.txt. Expect it to move to Staged.
# 3) Click Unstage all. Expect it back in Unstaged.
# 4) Click Discard on a.txt. Expect file restored to "hi". Undo toast should appear.
# 5) Edit a.txt, click Stash. Expect clean tree, stash count = 1. Undo (Pop) restores.
# 6) Create branch "feat" via BranchSwitcher with autoStash when dirty. Expect on feat, stashRef returned.
# 7) Switch back to main. Pop stash manually.
# 8) Make a commit. Click Push. Expect ConfirmDialog with 'git push origin main'. Confirm.
#    Verify `$bare` advances: git -C $bare log --oneline main | head -1.
# 9) Click a recent commit. Expect CommitDiffModal with the patch.
# 10) Force a push failure: break the remote (`git remote set-url origin /nowhere`). Try to push.
#     Expect ConfirmDialog surfaces stderr inline, Cancel works, dialog stays open until dismissed.
# 11) Verify `~/.claude/ccc-git-history.log` contains a line per write (add, restore, stash,
#     checkout, push).

popd
rm -rf "$tmp" "$bare"
```

- [ ] **Step 4: Build Windows installer**

Run: `npm run package:win`
Expected: `dist/ClaudeCommandCenter-1.3.1.exe` updated.

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin feat/local-git-actions
gh pr create --base feat/sidebar-easy-wins --title "sidebar 3: local git action surface" --body "$(cat <<'EOF'
## Summary
- New main-side git IPC (`src/main/ipc/git-handlers.ts`) for stage / unstage / discard / stash / pop-stash / branch-list / branch-switch / push / pull / commit-diff. All commands go through `runGit()` (`src/main/git/git-runner.ts`) which validates cwd against the live session working-directory allowlist and uses `child_process.execFile` with explicit argv — no shell. Git binary resolved via extracted `resolveGitBin()` (`src/main/git/git-bin.ts`), shared with `repo-detector.ts` (no duplication).
- Every write appended to `~/.claude/ccc-git-history.log` via a best-effort logger that swallows its own errors (never fails a git operation).
- Two safety classes: **undoable** (stage/unstage/discard/stash/pop/branch-switch-with-auto-stash) backed by 5s ToastUndo; **confirm-before** (push/pull/force) via `<ConfirmDialog>` that renders the exact argv.
- Overhauled `LocalGitSection` composes `<BranchSwitcher>`, `<FileStatusList>` (per-file checkbox + status code + numstat + red Discard), `<ConfirmDialog>`, `<CommitDiffModal>` (recent-commit → patch via SanitizedMarkdown).
- `Ask Claude to commit` writes the literal `Review the staged diff and write a commit message.` via the Phase 2 readiness contract (`src/renderer/lib/claude-input-queue.ts`).

## Test plan
- [x] `npx vitest run` green — handlers tested against a real temp repo + bare remote for push.
- [x] `npm run typecheck` green.
- [x] Smoke run as documented in Task 18 Step 3.
- [x] Confirm dialog focus defaults to Cancel; Esc dismisses.
- [x] Discard undo restores file contents.
- [x] Branch switch with dirty tree + auto-stash round-trips.
- [x] `ccc-git-history.log` accumulates write entries.

## Not in scope
Merge conflict resolution, interactive rebase, hand-written commit messages — those stay in a real tool / the terminal.
EOF
)"
```

---

## Self-review checklist

- [ ] Every task has exact file paths.
- [ ] Every code step shows the full code to write or a faithful excerpt with enough context to drop in.
- [ ] Every test has expected failure / expected pass.
- [ ] `runGit` enforces cwd allowlist AND argv-shape validation (both directions).
- [ ] Git history logger swallows its own errors (spec-critical safety property).
- [ ] Push / pull / force all go through ConfirmDialog with the exact argv rendered.
- [ ] Discard / stash / pop / branch-switch-with-auto-stash wire through ToastUndo.
- [ ] No default exports (components are sole-export of file, so exempt).
- [ ] No `\u{...}` escapes — glyphs via `String.fromCodePoint(0x…)`.
- [ ] No Node imports in renderer (all git calls go through the preload bridge).
- [ ] Zustand selectors use the `useStore((s) => s.x)` shape.
- [ ] No em dashes in user-facing strings; no "complex" / "risk" in handler descriptions.
- [ ] Cancel is the default focus target in every confirm dialog.
- [ ] Confirm dialog renders stderr inline on failure instead of closing.
- [ ] `resolveGitBin()` is extracted and reused — not duplicated.
- [ ] Only the spec-allowed operations exist (no merge / rebase / hand-commit).

Generated with Claude Code.
