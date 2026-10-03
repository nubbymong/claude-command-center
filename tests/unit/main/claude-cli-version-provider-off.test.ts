// WP2: no probe runs the Claude CLI while Claude Code is switched off -- not
// the `claude --version` probe at start, and not the one a launch path starts
// on demand (ensureClaudeCliVersion, from the managed-launch preflight, which
// a shell pinned to an account also reaches). The condition lives in the
// probe itself (claude-cli-version.ts); main hands it its launch rule at
// start (setClaudeCliProbeAllowed, from index.ts). A skipped probe records
// nothing, so the first probe once Claude Code is back on runs at once.
//
// Host-safe: child_process and the CLI resolver are mocked (the sibling
// claude-cli-version.test.ts also drives a real cmd.exe, so it is not run on
// the host).
import { describe, it, expect, beforeEach, vi } from 'vitest'

type ExecCb = (err: Error | null, stdout?: string) => void
const execFile = vi.fn((_bin: string, _args: string[], _opts: unknown, cb: ExecCb) => { cb(null, '2.1.281 (Claude Code)\n') })
const probeClaudeCli = vi.fn(async () => ({ installed: true, path: '/usr/local/bin/claude', probe: 'test' }))
vi.mock('node:child_process', () => ({ execFile: (b: string, a: string[], o: unknown, cb: ExecCb) => execFile(b, a, o, cb) }))
vi.mock('../../../src/main/claude-cli-probe', () => ({ probeClaudeCli: () => probeClaudeCli() }))

const {
  probeClaudeCliVersion, ensureClaudeCliVersion, peekClaudeCliVersion, setClaudeCliProbeAllowed, claudeCliProbeAllowed, _resetClaudeCliVersionForTest,
} = await import('../../../src/main/claude-cli-version')

const ORIGINAL_PLATFORM = Object.getOwnPropertyDescriptor(process, 'platform')!
let claudeOn = true

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  _resetClaudeCliVersionForTest()
  execFile.mockClear()
  probeClaudeCli.mockClear()
  claudeOn = true
  setClaudeCliProbeAllowed(() => claudeOn)
  return () => { Object.defineProperty(process, 'platform', ORIGINAL_PLATFORM) }
})

describe('the Claude CLI probe while Claude Code is off', () => {
  it('the probe at start runs nothing and answers null', async () => {
    claudeOn = false
    await expect(probeClaudeCliVersion()).resolves.toBeNull()
    expect(probeClaudeCli).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
    expect(peekClaudeCliVersion()).toBeNull()
  })

  it('the probe a launch path starts on demand runs nothing either', async () => {
    claudeOn = false
    ensureClaudeCliVersion()
    await new Promise<void>((r) => setTimeout(r, 0))
    expect(probeClaudeCli).not.toHaveBeenCalled()
    expect(execFile).not.toHaveBeenCalled()
  })

  it('once Claude Code is back on, the next probe runs at once (a skip is not a failure to back off from)', async () => {
    claudeOn = false
    ensureClaudeCliVersion()
    expect(execFile).not.toHaveBeenCalled()
    claudeOn = true
    ensureClaudeCliVersion()
    for (let i = 0; i < 5 && peekClaudeCliVersion() === null; i++) await new Promise<void>((r) => setTimeout(r, 0))
    expect(execFile).toHaveBeenCalledTimes(1)
    expect(peekClaudeCliVersion()).toBe('2.1.281')
  })

  it('with Claude Code on, the probe runs as before (the control)', async () => {
    await expect(probeClaudeCliVersion()).resolves.toBe('2.1.281')
    expect(execFile).toHaveBeenCalledTimes(1)
  })

  it('a gate that cannot answer is a no; until one is set, probes run as they always have', () => {
    setClaudeCliProbeAllowed(() => { throw new Error('boom') })
    expect(claudeCliProbeAllowed()).toBe(false)
    _resetClaudeCliVersionForTest()
    expect(claudeCliProbeAllowed()).toBe(true)
  })
})
