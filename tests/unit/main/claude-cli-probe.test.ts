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
import { describe, it, expect, vi, beforeEach } from 'vitest'
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

const { probeClaudeCli, _resetClaudeCliProbeForTest } =
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

beforeEach(() => {
  exec.calls.length = 0
  _resetClaudeCliProbeForTest()
})

describe('probeClaudeCli on Windows', () => {
  beforeEach(() => { platform.value = 'win32' })

  it('reports the first `where` hit', async () => {
    const p = probeClaudeCli()
    answer(0, 'C:\\Users\\me\\AppData\\npm\\claude.cmd\r\n')
    const result = await p
    expect(result.installed).toBe(true)
    expect(result.path).toBe('C:\\Users\\me\\AppData\\npm\\claude.cmd')
    expect(calls()[0].bin).toBe('where')
    expect(calls()[0].args).toEqual(['claude.exe'])
  })

  it('walks .exe -> .cmd -> bare, then reports NOT installed', async () => {
    const p = probeClaudeCli()
    for (let i = 0; i < 3; i++) {
      await settle()
      answer(i, null)
    }
    const result = await p
    expect(result.installed).toBe(false)
    expect(calls().map((c) => c.args[0])).toEqual(['claude.exe', 'claude.cmd', 'claude'])
  })

  it('an empty/whitespace answer is NOT a hit', async () => {
    const p = probeClaudeCli()
    for (let i = 0; i < 3; i++) {
      await settle()
      answer(i, '   \r\n')
    }
    expect((await p).installed).toBe(false)
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

  it('the probe is genuinely deferred — nothing has resolved while the spawn is outstanding', async () => {
    platform.value = 'win32'
    let settled = false
    void probeClaudeCli().then(() => { settled = true })
    // A sync probe would already have produced a result by here.
    expect(calls()).toHaveLength(1)
    await settle()
    expect(settled).toBe(false)
    answer(0, 'C:\\claude.cmd')
    await settle()
    expect(settled).toBe(true)
  })
})

describe('overlapping probes coalesce onto ONE probe', () => {
  // Mutation to prove this can fail: drop the `inFlight` guard and call
  // runProbe() directly — the spawn count becomes 20 (or 60 on the miss path).
  it('twenty concurrent callers spawn one process and share one answer', async () => {
    platform.value = 'win32'
    const promises = Array.from({ length: 20 }, () => probeClaudeCli())
    expect(calls()).toHaveLength(1)
    answer(0, 'C:\\claude.cmd')
    const results = await Promise.all(promises)
    expect(calls()).toHaveLength(1)
    for (const r of results) expect(r).toEqual(results[0])
  })

  it('the guard COALESCES rather than caches — the next call after it settles re-probes', async () => {
    platform.value = 'win32'
    const first = probeClaudeCli()
    answer(0, 'C:\\claude.cmd')
    expect((await first).installed).toBe(true)

    const second = probeClaudeCli()
    expect(calls()).toHaveLength(2)
    answer(1, 'C:\\somewhere-else\\claude.cmd')
    expect((await second).path).toBe('C:\\somewhere-else\\claude.cmd')
  })
})
