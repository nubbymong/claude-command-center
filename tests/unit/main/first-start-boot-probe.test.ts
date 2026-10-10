// [host] ADR-025: the boot [claude-version] probe is often the app's first
// start of a Claude Code that updated itself while the app was closed. On
// Windows it awaits the first-start warm-up of the claude.exe its PATH walk
// found, with Claude's --version environment, before its own start. The
// process start is faked (node:child_process) and so is the warm-up; the only
// file is an empty claude.exe in a temp folder, which nothing runs.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type ExecCb = (err: Error | null, stdout?: string) => void
const h = vi.hoisted(() => ({
  order: [] as string[],
  gate: null as null | Promise<void>,
  warm: [] as Array<{ program: string; env: () => unknown }>,
}))
vi.mock('node:child_process', () => ({
  execFile: (bin: string, args: string[], _opts: unknown, cb: ExecCb) => {
    h.order.push(`exec ${bin} ${args.join(' ')}`)
    cb(null, '2.1.296 (Claude Code)\n')
    return { exitCode: 0, signalCode: null }
  },
}))
vi.mock('../../../src/main/claude-cli-probe', () => ({ probeClaudeCli: async () => { throw new Error('not on Windows') } }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/first-start-warmup', () => ({
  warmFirstStart: async (program: string, env: () => unknown) => {
    h.warm.push({ program, env })
    h.order.push(`warm ${program}`)
    if (h.gate) await h.gate
    return { outcome: 'ran', exitCode: 0, timedOut: false }
  },
}))

const { probeClaudeCliVersion, ensureClaudeCliVersion, setClaudeCliProbeAllowed, _resetClaudeCliVersionForTest } = await import('../../../src/main/claude-cli-version')

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
let root = ''
let savedPath: string | undefined
beforeEach(() => {
  _resetClaudeCliVersionForTest()
  h.order.length = 0
  h.warm.length = 0
  h.gate = null
  root = mkdtempSync(join(tmpdir(), 'ccc-boot-probe-'))
  savedPath = process.env.PATH
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM)
  if (savedPath === undefined) delete process.env.PATH
  else process.env.PATH = savedPath
  delete process.env.CCC_FIRST_START_MARK
  rmSync(root, { recursive: true, force: true })
})

describe.runIf(process.platform === 'win32')('the boot Claude Code version probe (ADR-025)', () => {
  it('awaits the warm-up of the claude.exe it found before it starts it', async () => {
    const dir = join(root, 'bin')
    mkdirSync(dir)
    const exe = join(dir, 'claude.exe')
    writeFileSync(exe, '')
    process.env.PATH = dir
    process.env.CCC_FIRST_START_MARK = 'never reaches a CLI run'
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const probe = probeClaudeCliVersion()
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(h.order).toEqual([`warm ${exe}`])
    release()
    expect(await probe).toBe('2.1.296')
    expect(h.order).toEqual([`warm ${exe}`, `exec ${exe} --version`])
    // Claude's --version environment, built from this process's: no
    // Conductor variable, and the working folder kept out of program lookup.
    const env = (await (h.warm[0].env as () => Promise<{ env: Record<string, string> }> | { env: Record<string, string> })()).env
    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith('CCC_'))).toBe(false)
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
  })

  it('Claude Code switched off while the warm-up ran: no probe runs, and the next one is not held back', async () => {
    const dir = join(root, 'bin')
    mkdirSync(dir)
    const exe = join(dir, 'claude.exe')
    writeFileSync(exe, '')
    process.env.PATH = dir
    let allowed = true
    setClaudeCliProbeAllowed(() => allowed)
    let release!: () => void
    h.gate = new Promise<void>((r) => { release = r })
    const probe = probeClaudeCliVersion()
    await vi.waitFor(() => expect(h.warm).toHaveLength(1))
    allowed = false
    release()
    expect(await probe).toBeNull()
    expect(h.order).toEqual([`warm ${exe}`])
    // Back on: the next probe runs at once (a skip is not a failure to back off from).
    allowed = true
    h.gate = null
    ensureClaudeCliVersion()
    await vi.waitFor(() => expect(h.order).toContain(`exec ${exe} --version`))
  })
})
