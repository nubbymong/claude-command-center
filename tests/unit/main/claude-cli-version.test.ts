// WP1.38: the cached `claude --version` probe behind the managed-launch
// preflight's CLI floor.
//
// It is on the security path by consequence rather than by content: if this
// module answers `null` for a healthy install, every managed launch gets a
// blocking "version not verified" finding; if it ever cached a stale or wrong
// answer, an out-of-date CLI would read as verified. Both directions are
// covered below.
import { describe, it, expect, beforeEach, vi } from 'vitest'

type ExecCb = (err: Error | null, stdout?: string) => void
let execFileImpl: (bin: string, args: string[], opts: unknown, cb: ExecCb) => void
let probeImpl: () => Promise<{ installed: boolean; path?: string; probe: string }>

vi.mock('node:child_process', () => ({
  execFile: (bin: string, args: string[], opts: unknown, cb: ExecCb) => execFileImpl(bin, args, opts, cb),
}))
vi.mock('../../../src/main/claude-cli-probe', () => ({
  probeClaudeCli: () => probeImpl(),
}))

const {
  parseClaudeCliVersion, peekClaudeCliVersion, probeClaudeCliVersion,
  ensureClaudeCliVersion, _resetClaudeCliVersionForTest,
} = await import('../../../src/main/claude-cli-version')

const RESOLVED = '/usr/local/bin/claude'

beforeEach(() => {
  _resetClaudeCliVersionForTest()
  probeImpl = async () => ({ installed: true, path: RESOLVED, probe: 'test' })
  execFileImpl = (_b, _a, _o, cb) => cb(null, '2.1.278 (Claude Code)\n')
})

describe('parseClaudeCliVersion', () => {
  it('reads the version out of the CLI banner', () => {
    expect(parseClaudeCliVersion('2.1.278 (Claude Code)')).toBe('2.1.278')
    expect(parseClaudeCliVersion('claude 2.1.0')).toBe('2.1.0')
    expect(parseClaudeCliVersion('2.1.0-beta.1')).toBe('2.1.0-beta.1')
  })

  it('answers null rather than guessing when there is no version in the output', () => {
    for (const raw of ['', 'command not found', 'claude']) expect(parseClaudeCliVersion(raw), raw).toBeNull()
  })
})

describe('probeClaudeCliVersion', () => {
  it('starts unknown: peek is null until a probe has answered', () => {
    expect(peekClaudeCliVersion()).toBeNull()
  })

  it('runs the RESOLVED binary, not the bare name', async () => {
    // The reason this module resolves through probeClaudeCli at all: a
    // GUI-launched Electron's PATH does not carry Homebrew/nvm/asdf, so
    // `execFile('claude', ...)` reports missing for a CLI the login shell finds.
    let seen = ''
    execFileImpl = (bin, _a, _o, cb) => { seen = bin; cb(null, '2.1.278 (Claude Code)') }
    await probeClaudeCliVersion()
    expect(seen).toBe(RESOLVED)
  })

  it('caches a successful answer', async () => {
    expect(await probeClaudeCliVersion()).toBe('2.1.278')
    expect(peekClaudeCliVersion()).toBe('2.1.278')
  })

  it('shares ONE subprocess between overlapping callers, and both get the same answer', async () => {
    let calls = 0
    let pending: ExecCb | null = null
    execFileImpl = (_b, _a, _o, cb) => { calls++; pending = cb }
    const a = probeClaudeCliVersion()
    const b = probeClaudeCliVersion()
    expect(a).toBe(b)               // the SAME promise: coalesced synchronously
    // The binary resolution is async, so the subprocess starts a microtask
    // later; drain before counting rather than asserting on a race.
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(calls).toBe(1)
    pending!(null, '2.1.278 (Claude Code)')
    expect(await a).toBe('2.1.278')
    expect(await b).toBe('2.1.278')
  })

  it('caches NOTHING on failure, so a transient error cannot make an old CLI look verified', async () => {
    execFileImpl = (_b, _a, _o, cb) => cb(new Error('boom'))
    expect(await probeClaudeCliVersion()).toBeNull()
    expect(peekClaudeCliVersion()).toBeNull()

    // ...and the next call genuinely re-probes rather than returning the failure.
    execFileImpl = (_b, _a, _o, cb) => cb(null, '2.1.279 (Claude Code)')
    expect(await probeClaudeCliVersion()).toBe('2.1.279')
    expect(peekClaudeCliVersion()).toBe('2.1.279')
  })

  it('answers null when no CLI can be resolved at all', async () => {
    probeImpl = async () => ({ installed: false, probe: 'where claude' })
    expect(await probeClaudeCliVersion()).toBeNull()
    expect(peekClaudeCliVersion()).toBeNull()
  })

  it('does not throw when the resolver itself rejects', async () => {
    probeImpl = async () => { throw new Error('probe exploded') }
    await expect(probeClaudeCliVersion()).resolves.toBeNull()
  })

  it('does not throw when execFile throws synchronously', async () => {
    execFileImpl = () => { throw new Error('spawn EACCES') }
    await expect(probeClaudeCliVersion()).resolves.toBeNull()
  })
})

describe('ensureClaudeCliVersion', () => {
  it('probes while the answer is unknown', async () => {
    let calls = 0
    execFileImpl = (_b, _a, _o, cb) => { calls++; cb(null, '2.1.278 (Claude Code)') }
    ensureClaudeCliVersion()
    await probeClaudeCliVersion()
    expect(calls).toBe(1)
    expect(peekClaudeCliVersion()).toBe('2.1.278')
  })

  it('does NOT re-probe once a version is known -- it is called on the launch path', async () => {
    await probeClaudeCliVersion()
    let calls = 0
    execFileImpl = (_b, _a, _o, cb) => { calls++; cb(null, '2.1.278 (Claude Code)') }
    ensureClaudeCliVersion()
    ensureClaudeCliVersion()
    await Promise.resolve()
    expect(calls).toBe(0)
  })

  it('never throws, whatever the probe does', () => {
    probeImpl = async () => { throw new Error('nope') }
    _resetClaudeCliVersionForTest()
    expect(() => ensureClaudeCliVersion()).not.toThrow()
  })

  it('backs off after a FAILED probe instead of re-probing on every spawn', async () => {
    // The opportunistic path runs per managed launch, and a resolution chain
    // spawns a LOGIN SHELL on POSIX (8s timeout, up to three candidates). With
    // no floor, a machine with no resolvable CLI would start one of those on
    // every session the user opens.
    let resolutions = 0
    probeImpl = async () => { resolutions++; return { installed: false, probe: 'none' } }

    expect(await probeClaudeCliVersion()).toBeNull()
    expect(resolutions).toBe(1)

    for (let i = 0; i < 5; i++) { ensureClaudeCliVersion(); await Promise.resolve() }
    expect(resolutions, 'ensure() re-probed inside the backoff window').toBe(1)
  })

  it('a DELIBERATE probe ignores the backoff', async () => {
    // The floor is on the opportunistic path only. An explicit call -- boot, or
    // a future "check again" affordance -- must still run.
    let resolutions = 0
    probeImpl = async () => { resolutions++; return { installed: false, probe: 'none' } }
    await probeClaudeCliVersion()
    await probeClaudeCliVersion()
    expect(resolutions).toBe(2)
  })
})
