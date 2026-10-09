/**
 * Phase 7 item B — the main-side "is the Claude CLI installed?" probe.
 *
 * The gate first-run setup hard-stops on. Three things must hold or the stop is
 * either useless, a brick, or a denial of service:
 *  - it must probe the way the setup PTY LAUNCHES (a POSIX login shell, so a
 *    Homebrew/nvm install is seen), otherwise it reports "missing" for a CLI
 *    that works fine;
 *  - it must fail CLOSED, so a probe that throws blocks rather than waves
 *    through;
 *  - it must NOT BLOCK THE MAIN PROCESS (adversarial review, 2026-09-01 — DoS).
 *    The original used `execFileSync`: up to three sequential 8s probes, each
 *    freezing every IPC handler, every PTY pump and the window itself. The
 *    channel that reaches it (`setup:probeCli`) is ungated, so any renderer
 *    could hang the app on demand, and a slow login shell hung it by accident.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** One recorded spawn, with its completion under the test's control. */
interface Call { bin: string; args: string[]; done: (err: unknown, stdout: string) => void }

const exec = vi.hoisted(() => ({ calls: [] as Array<{ bin: string; args: string[]; done: (err: unknown, stdout: string) => void }> }))
const platform = vi.hoisted(() => ({ value: 'win32' as NodeJS.Platform }))

// ASYNC execFile only. If the module reaches for a *Sync spawn this mock does
// not provide one and the import fails loudly — which is the point.
vi.mock('child_process', () => ({
  execFile: (bin: string, args: string[], _opts: unknown, cb: (err: unknown, stdout: string) => void) => {
    exec.calls.push({ bin, args, done: cb })
    return { unref() {} }
  },
}))
vi.mock('os', () => ({ platform: () => platform.value }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {} }))
// Windows: the in-process PATH walk (windows-programs.ts), answered by the test.
const walk = vi.hoisted(() => ({ calls: [] as unknown[][], answer: null as string | null }))
vi.mock('../../../src/main/windows-programs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/windows-programs')>()),
  findOnWindowsPathAsync: async (...a: unknown[]) => { walk.calls.push(a); return walk.answer },
}))

const { probeClaudeCli, _resetClaudeCliProbeForTest, findClaudeOnWindowsAsync, recentClaudeOnWindows, _resetClaudeWindowsLookupForTest, CLAUDE_LOOKUP_REUSE_MS } =
  await import('../../../src/main/claude-cli-probe')

const calls = (): Call[] => exec.calls as Call[]

/** Settle the Nth outstanding spawn the way a real one would. */
function answer(index: number, stdout: string | null): void {
  const call = calls()[index]
  expect(call, `no spawn #${index} was made`).toBeDefined()
  if (stdout === null) call.done(Object.assign(new Error('exit 1'), { code: 1 }), '')
  else call.done(null, stdout)
}

/** Let the awaited microtasks between two sequential probes run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// SHELL is set per case below and put back after, so nothing leaks into the next file's process state.
const savedShell = process.env.SHELL
beforeEach(() => {
  exec.calls.length = 0
  walk.calls.length = 0
  walk.answer = null
  _resetClaudeCliProbeForTest()
  _resetClaudeWindowsLookupForTest()
})
afterEach(() => {
  if (savedShell === undefined) delete process.env.SHELL
  else process.env.SHELL = savedShell
})

describe('probeClaudeCli on Windows: the probe finds Claude Code only in PATH\'s folders', () => {
  beforeEach(() => { platform.value = 'win32' })

  it('reports the full path the in-process PATH walk finds, starting no process', async () => {
    walk.answer = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'
    const p = probeClaudeCli()
    await settle()
    expect(calls(), 'no process (no `where`) is started').toHaveLength(0)
    const result = await p
    expect(result.installed).toBe(true)
    expect(result.path).toBe('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd')
    // claude.exe in any folder first, then claude.cmd, then claude.bat
    expect(walk.calls).toHaveLength(1)
    expect(walk.calls[0][0]).toEqual(['claude.exe', 'claude.cmd', 'claude.bat'])
    expect(walk.calls[0][3]).toBe('name')
  })

  it('nothing in PATH\'s folders -> NOT installed, never a bare name, and no process', async () => {
    const p = probeClaudeCli()
    await settle()
    expect(calls()).toHaveLength(0)
    const result = await p
    expect(result.installed).toBe(false)
    expect(result.path).toBeUndefined()
  })
})

describe('a found Claude Code is reused for the same PATH, briefly', () => {
  const env = { PATH: 'C:\\Tools;C:\\Npm' }

  it('the same PATH within the reuse window: the answer, read with no walk', async () => {
    walk.answer = 'C:\\Tools\\claude.exe'
    expect(await findClaudeOnWindowsAsync(env, undefined, () => 1_000)).toBe('C:\\Tools\\claude.exe')
    walk.calls.length = 0
    expect(recentClaudeOnWindows({ Path: 'C:\\Tools;C:\\Npm' }, () => 1_000 + CLAUDE_LOOKUP_REUSE_MS - 1)).toBe('C:\\Tools\\claude.exe')
    expect(walk.calls).toEqual([])
  })

  it('another PATH, the window passed, or a clock gone backwards: no answer', async () => {
    walk.answer = 'C:\\Tools\\claude.exe'
    await findClaudeOnWindowsAsync(env, undefined, () => 1_000)
    expect(recentClaudeOnWindows({ PATH: 'C:\\Npm;C:\\Tools' }, () => 1_000)).toBeNull()
    expect(recentClaudeOnWindows(env, () => 1_000 + CLAUDE_LOOKUP_REUSE_MS)).toBeNull()
    expect(recentClaudeOnWindows(env, () => 999)).toBeNull()
  })

  it('answers are kept per PATH value: a profile run\'s PATH, which adds its own folder, keeps its own', async () => {
    const profile = { PATH: 'C:\\Tools;C:\\Npm;C:\\profiles\\p1\\.local\\bin' }
    walk.answer = 'C:\\Tools\\claude.exe'
    await findClaudeOnWindowsAsync(env, undefined, () => 1_000)
    walk.answer = 'C:\\profiles\\p1\\.local\\bin\\claude.exe'
    await findClaudeOnWindowsAsync(profile, undefined, () => 1_000)
    expect(recentClaudeOnWindows(env, () => 2_000)).toBe('C:\\Tools\\claude.exe')
    expect(recentClaudeOnWindows(profile, () => 2_000)).toBe('C:\\profiles\\p1\\.local\\bin\\claude.exe')
  })

  it('not found is never reused, and a later miss forgets an earlier find', async () => {
    walk.answer = null
    expect(await findClaudeOnWindowsAsync(env, undefined, () => 1_000)).toBeNull()
    expect(recentClaudeOnWindows(env, () => 1_000)).toBeNull()
    walk.answer = 'C:\\Tools\\claude.exe'
    await findClaudeOnWindowsAsync(env, undefined, () => 2_000)
    walk.answer = null
    await findClaudeOnWindowsAsync(env, undefined, () => 3_000)
    expect(recentClaudeOnWindows(env, () => 3_000)).toBeNull()
  })
})

describe('probeClaudeCli on POSIX', () => {
  beforeEach(() => { platform.value = 'darwin'; process.env.SHELL = '/bin/zsh' })

  it('asks the LOGIN shell first, so a Homebrew/nvm install is seen', async () => {
    const p = probeClaudeCli()
    answer(0, '/opt/homebrew/bin/claude\n')
    const result = await p
    expect(result.installed).toBe(true)
    expect(result.path).toBe('/opt/homebrew/bin/claude')
    expect(calls()[0].bin).toBe('/bin/zsh')
    expect(calls()[0].args).toEqual(['-lc', 'command -v claude'])
  })

  it('falls back to `which` when the login shell probe cannot run', async () => {
    const p = probeClaudeCli()
    answer(0, null)
    await settle()
    answer(1, '/usr/local/bin/claude\n')
    const result = await p
    expect(result.installed).toBe(true)
    expect(calls()[1].bin).toBe('which')
  })

  it('both misses -> NOT installed', async () => {
    const p = probeClaudeCli()
    answer(0, null)
    await settle()
    answer(1, null)
    expect((await p).installed).toBe(false)
  })
})

// ── The DoS fixes (adversarial review, 2026-09-01) ──────────────────────────

describe('probeClaudeCli does not block the main process', () => {
  // Mutation to prove this can fail: restore `execFileSync` in
  // claude-cli-probe.ts — the module then spawns synchronously and this grep
  // finds the call.
  it('the module uses NO synchronous spawn — a *Sync probe freezes every IPC handler for up to 24s', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/main/claude-cli-probe.ts'),
      'utf8',
    )
    // Comments are allowed to NAME the old API (they explain the fix); code is
    // not. Strip comments, then look.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/execFileSync|spawnSync|execSync/)
    expect(code).toMatch(/\bexecFile\b/)
  })

  // The spawn-counting checks run on the POSIX branch, which still starts a
  // probe process; the Windows branch starts none (its walk is in-process).
  it('the probe is genuinely deferred — nothing has resolved while the spawn is outstanding', async () => {
    platform.value = 'darwin'
    process.env.SHELL = '/bin/zsh'
    let settled = false
    void probeClaudeCli().then(() => { settled = true })
    // A sync probe would already have produced a result by here.
    expect(calls()).toHaveLength(1)
    await settle()
    expect(settled).toBe(false)
    answer(0, '/usr/local/bin/claude')
    await settle()
    expect(settled).toBe(true)
  })
})

describe('overlapping probes coalesce onto ONE probe', () => {
  beforeEach(() => { platform.value = 'darwin'; process.env.SHELL = '/bin/zsh' })
  // Mutation to prove this can fail: drop the `inFlight` guard and call
  // runProbe() directly — the spawn count becomes 20 (or 40 on the miss path).
  it('twenty concurrent callers spawn one process and share one answer', async () => {
    const promises = Array.from({ length: 20 }, () => probeClaudeCli())
    expect(calls()).toHaveLength(1)
    answer(0, '/usr/local/bin/claude')
    const results = await Promise.all(promises)
    expect(calls()).toHaveLength(1)
    for (const r of results) expect(r).toEqual(results[0])
  })

  it('the guard COALESCES rather than caches — the next call after it settles re-probes', async () => {
    const first = probeClaudeCli()
    answer(0, '/usr/local/bin/claude')
    expect((await first).installed).toBe(true)

    const second = probeClaudeCli()
    expect(calls()).toHaveLength(2)
    answer(1, '/opt/elsewhere/claude')
    expect((await second).path).toBe('/opt/elsewhere/claude')
  })

  it('on Windows, twenty concurrent callers share one PATH walk', async () => {
    platform.value = 'win32'
    walk.answer = 'C:\\Tools\\claude.exe'
    const results = await Promise.all(Array.from({ length: 20 }, () => probeClaudeCli()))
    expect(walk.calls).toHaveLength(1)
    for (const r of results) expect(r).toEqual(results[0])
  })
})
