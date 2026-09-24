// WP1.17 / WP1.38 / WP1.46 -- WP2 commit 5b (plan "Commit 5b"): Claude Code
// as the reviewer for a Codex session. Its executable is proved (resolved,
// version at or above the floor, file identity recorded) and re-verified
// before a launch; a launch is prepared for REVIEWS only, in the reviewer
// account's profile home (composed by account-profiles, injected); one
// isolated `claude -p --restricted` per review, the request on stdin, a
// constant argv, no Conductor variable, the account held as a credential
// consumer for the whole run; the pinned 2.1.278 JSON result is read, and
// what goes back is redacted and bounded.
//
// PURE: every port (the registry, the profile home, the runner, the
// filesystem) is injected. No process is started and no file is touched.
import { describe, it, expect, vi } from 'vitest'
import {
  createClaudePackage, createClaudeReviewLaunch, createClaudeReviewOperations, parseClaudeResult,
  discoverClaude, verifyClaudeExecutable, parseClaudeVersion,
  CLAUDE_REVIEW_ARGS, CLAUDE_REVIEW_HOLD_GRACE_MS, CLAUDE_REVIEW_MAX_STDOUT,
} from '../../src/main/providers/claude'
import type { ClaudeReviewPorts, ClaudeCliRunResult, ClaudeCliRunOptions, ClaudeCliCommand, ClaudeFileStat, ClaudeReviewDeps } from '../../src/main/providers/claude'
import { packageRegistrationProblem } from '../../src/main/providers/core'
import { cliCommandLine, codexShellEnv } from '../../src/main/providers/codex'
import type { AuthRealm } from '../../src/shared/providers'

// The composition root's realm lookup reads the running registry: a stub
// document stands in for it (only the compose wiring test below uses it).
const reg = vi.hoisted(() => ({ doc: null as unknown }))
vi.mock('../../src/main/provider-account-registry', async (orig) => ({
  ...(await orig<typeof import('../../src/main/provider-account-registry')>()),
  getAccountRegistry: () => (reg.doc ? { current: () => reg.doc } : null),
}))

const PID = 'profile-abc123-0a1b2c'
const EXE = 'C:\\Users\\u\\.local\\bin\\claude.exe'
const SHIM = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'
const STAT: ClaudeFileStat = { size: 100, mtimeMs: 1000.4, ctimeMs: 2000.7, dev: '7', ino: '99999999999999999', isFile: true }
const TOKEN = 'sk-ant-api03-' + 'A1b2'.repeat(12)

const realm = (over: Partial<AuthRealm> = {}): AuthRealm => ({
  id: 'realm-' + '1'.repeat(32), providerId: 'claude', ownerProviderAccountId: 'acct-' + '1'.repeat(32),
  kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: `claude-profile:${PID}`, lifecycle: 'active', createdAt: 1, ...over,
})
const result = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, result: '1. A finding.',
  usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 }, ...over,
}) + '\n'
const ran = (over: Partial<ClaudeCliRunResult> = {}): ClaudeCliRunResult => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, ...over })

/** A runner that streams its scripted stdout/stderr through onChunk. */
function runner(script: (cmd: ClaudeCliCommand, opts: ClaudeCliRunOptions) => Partial<ClaudeCliRunResult> | Promise<Partial<ClaudeCliRunResult>>) {
  const calls: Array<{ cmd: ClaudeCliCommand; opts: ClaudeCliRunOptions }> = []
  const run = vi.fn(async (cmd: ClaudeCliCommand, opts: ClaudeCliRunOptions) => {
    calls.push({ cmd, opts })
    const r = ran(await script(cmd, opts))
    if (r.stdout) opts.onChunk?.(r.stdout, 'stdout')
    if (r.stderr) opts.onChunk?.(r.stderr, 'stderr')
    return r
  })
  return { run, calls }
}

function reviewDeps(over: Partial<ClaudeReviewDeps> = {}) {
  const events: string[] = []
  const release = vi.fn(() => { events.push('release') })
  const r = runner(() => { events.push('run'); return { stdout: result() } })
  const deps: ClaudeReviewDeps = {
    platform: 'win32',
    profileOf: vi.fn(async () => PID),
    holdProfile: vi.fn(async () => { events.push('hold'); return release }),
    recordPreflight: vi.fn(),
    commandLine: (e, a, p, s) => cliCommandLine(e, a, p, s, 'Claude Code'),
    shellEnv: codexShellEnv,
    run: r.run,
    ...over,
  }
  return { deps, release, events, calls: r.calls, run: r.run }
}
const input = (over: Record<string, unknown> = {}) => ({
  executable: EXE,
  env: { PATH: 'C:\\Windows;relative\\bin;.;C:\\Tools', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\res\\profiles\\p', CONDUCTOR_MCP_TOKEN: 'secret', ccc_session_id: 's1', Claude_Multi_Session: 'x' },
  cwd: 'C:\\proj',
  prompt: 'Review this. %PATH% & echo x | "quoted" !VAR!',
  timeoutMs: 60_000,
  realm: { authRealmId: realm().id },
  ...over,
})

describe('the Claude reviewer invocation (WP2 5b)', () => {
  it('is a constant, read-only argv: restricted, no MCP server, read tools only, JSON, nothing persisted', () => {
    expect([...CLAUDE_REVIEW_ARGS]).toEqual(['-p', '--restricted', '--strict-mcp-config', '--tools', 'Read,Grep,Glob', '--output-format', 'json', '--no-session-persistence'])
    expect(Object.isFrozen(CLAUDE_REVIEW_ARGS)).toBe(true)
  })

  it('runs the proven executable in the project, the request on stdin, with no Conductor variable and only absolute PATH entries', async () => {
    const h = reviewDeps()
    const out = await createClaudeReviewOperations(h.deps).run(input())
    expect(out).toMatchObject({ ok: true, text: '1. A finding.' })
    expect(h.calls).toHaveLength(1)
    const { cmd, opts } = h.calls[0]
    expect(cmd.file).toBe(EXE)
    expect(cmd.args).toEqual([...CLAUDE_REVIEW_ARGS])
    expect(cmd.verbatim).toBe(false)
    expect(cmd.cwd).toBe('C:\\proj')
    expect(opts.stdin).toBe(input().prompt)
    expect(opts.timeoutMs).toBe(60_000)
    expect(Object.keys(opts.env).map((k) => k.toUpperCase()).filter((k) => /^(CCC_|CONDUCTOR_|CLAUDE_MULTI_)/.test(k))).toEqual([])
    expect(opts.env.PATH).toBe('C:\\Windows;C:\\Tools')
    expect(opts.env.NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(opts.env.USERPROFILE).toBe('C:\\res\\profiles\\p')
  })

  it('an npm shim runs through the absolute cmd.exe with the same constant line, never in a network-path project', async () => {
    const h = reviewDeps()
    await createClaudeReviewOperations(h.deps).run(input({ executable: SHIM }))
    expect(h.calls[0].cmd.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(h.calls[0].cmd.args.at(-1)).toBe(`""${SHIM}" ${CLAUDE_REVIEW_ARGS.join(' ')}"`)
    expect(h.calls[0].cmd.verbatim).toBe(true)
    const unc = reviewDeps()
    expect(await createClaudeReviewOperations(unc.deps).run(input({ executable: SHIM, cwd: '\\\\server\\share\\proj' }))).toMatchObject({ ok: false, code: 'not-started' })
    expect(unc.run).not.toHaveBeenCalled()
    expect(unc.deps.holdProfile).not.toHaveBeenCalled()
  })

  it('holds the reviewer account as a credential consumer for the whole run: taken before the run, bounded, released after', async () => {
    const h = reviewDeps()
    await createClaudeReviewOperations(h.deps).run(input())
    expect(h.deps.holdProfile).toHaveBeenCalledWith(PID, 60_000 + CLAUDE_REVIEW_HOLD_GRACE_MS, undefined)
    expect(h.events).toEqual(['hold', 'run', 'release'])
    expect(h.deps.profileOf).toHaveBeenCalledWith(input().realm)
  })

  it('waits out a refresh in flight before it runs (the hold resolves only then), and a cancel meanwhile runs nothing and lets go', async () => {
    let resolveHold!: (r: () => void) => void
    const h = reviewDeps({ holdProfile: vi.fn(() => new Promise<(() => void) | null>((r) => { resolveHold = r })) })
    const ac = new AbortController()
    const p = createClaudeReviewOperations(h.deps).run(input({ signal: ac.signal }))
    await vi.waitFor(() => expect(h.deps.holdProfile).toHaveBeenCalled())
    expect(h.run).not.toHaveBeenCalled()
    ac.abort()
    resolveHold(h.release)
    expect(await p).toMatchObject({ ok: false, code: 'cancelled' })
    expect(h.run).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('refuses before holding anything: a cancelled request, no realm, a realm that is not a profile home, a hold that fails', async () => {
    const ac = new AbortController()
    ac.abort()
    const pre = reviewDeps()
    expect(await createClaudeReviewOperations(pre.deps).run(input({ signal: ac.signal }))).toMatchObject({ ok: false, code: 'cancelled' })
    expect(pre.deps.holdProfile).not.toHaveBeenCalled()
    const noRealm = reviewDeps()
    expect(await createClaudeReviewOperations(noRealm.deps).run(input({ realm: undefined }))).toMatchObject({ ok: false, code: 'not-started' })
    const unknown = reviewDeps({ profileOf: vi.fn(async () => null) })
    expect(await createClaudeReviewOperations(unknown.deps).run(input())).toMatchObject({ ok: false, code: 'not-started' })
    for (const h of [noRealm, unknown]) { expect(h.deps.holdProfile).not.toHaveBeenCalled(); expect(h.run).not.toHaveBeenCalled() }
    const busy = reviewDeps({ holdProfile: vi.fn(async () => { throw new Error('x') }) })
    expect(await createClaudeReviewOperations(busy.deps).run(input())).toMatchObject({ ok: false, code: 'not-started' })
    expect(busy.run).not.toHaveBeenCalled()
  })

  it('records the launch preflight on the environment the reviewer actually gets', async () => {
    const h = reviewDeps()
    await createClaudeReviewOperations(h.deps).run(input())
    expect(h.deps.recordPreflight).toHaveBeenCalledWith(PID, h.calls[0].opts.env)
  })

  it('releases the account on every outcome, a runner that throws included', async () => {
    for (const script of [() => ({ exitCode: 1 }), () => ({ timedOut: true, stopped: 'deadline' as const }), () => { throw new Error('boom') }]) {
      const h = reviewDeps({})
      const r = runner(script as never)
      h.deps.run = r.run
      await createClaudeReviewOperations(h.deps).run(input()).catch(() => undefined)
      expect(h.release).toHaveBeenCalledTimes(1)
    }
  })

  it('maps the outcome: cancel, deadline, a spawn error, too much output, no result, an error result, an empty review', async () => {
    const outcome = async (over: Partial<ClaudeCliRunResult>, extra: Record<string, unknown> = {}) => {
      const h = reviewDeps()
      h.deps.run = runner(() => over).run
      return createClaudeReviewOperations(h.deps).run(input(extra))
    }
    expect(await outcome({ stopped: 'cancel', exitCode: null })).toMatchObject({ ok: false, code: 'cancelled' })
    expect(await outcome({ stopped: 'deadline', timedOut: true, stdout: result() })).toMatchObject({ ok: false, code: 'timed-out', usage: { inputTokens: 115, cachedInputTokens: 100, outputTokens: 20 } })
    expect(await outcome({ spawnError: `spawn failed ${TOKEN}`, exitCode: null })).toMatchObject({ ok: false, code: 'not-started' })
    expect(JSON.stringify(await outcome({ spawnError: `spawn failed ${TOKEN}`, exitCode: null }))).not.toContain(TOKEN)
    expect(await outcome({ stdout: 'x'.repeat(CLAUDE_REVIEW_MAX_STDOUT + 1) })).toMatchObject({ ok: false, code: 'no-output' })
    expect(await outcome({ stdout: 'no json here\n', exitCode: 0 })).toMatchObject({ ok: false, code: 'no-output' })
    const failed = await outcome({ stdout: '', stderr: `fatal: bad token ${TOKEN}\n`, exitCode: 2 })
    expect(failed).toMatchObject({ ok: false, code: 'failed' })
    expect(JSON.stringify(failed)).toContain('code 2')
    expect(JSON.stringify(failed)).not.toContain(TOKEN)
    const apiError = await outcome({ stdout: result({ is_error: true, result: `API Error: 401 ${TOKEN}` }), exitCode: 1 })
    expect(apiError).toMatchObject({ ok: false, code: 'failed' })
    expect(JSON.stringify(apiError)).toContain('API Error: 401')
    expect(JSON.stringify(apiError)).not.toContain(TOKEN)
    expect(await outcome({ stdout: result({ subtype: 'error_during_execution', is_error: true, result: undefined, errors: ['turn failed'] }), exitCode: 1 })).toMatchObject({ ok: false, code: 'failed', message: expect.stringContaining('turn failed') })
    expect(await outcome({ stdout: result({ result: '   ' }) })).toMatchObject({ ok: false, code: 'no-output' })
  })

  it('a credential the review quotes is redacted; ordinary prose is untouched', async () => {
    const h = reviewDeps()
    h.deps.run = runner(() => ({ stdout: result({ result: `Found a leaked key: ${TOKEN}. Also basic validation is missing.` }) })).run
    const out = await createClaudeReviewOperations(h.deps).run(input())
    expect(out.ok && out.text).toContain('[REDACTED]')
    expect(out.ok && out.text).not.toContain(TOKEN)
    expect(out.ok && out.text).toContain('basic validation is missing')
  })
})

describe('the pinned 2.1.278 result line (--output-format json)', () => {
  it('the last result message is read; a success that is not an error is the review, with its usage', () => {
    expect(parseClaudeResult(`noise\n{"type":"system"}\n${result()}`)).toEqual({ text: '1. A finding.', usage: { inputTokens: 115, cachedInputTokens: 100, outputTokens: 20 } })
    expect(parseClaudeResult(result({ usage: undefined }))).toEqual({ text: '1. A finding.' })
  })

  it('an error is never a review: is_error, an error subtype, or a missing result', () => {
    expect(parseClaudeResult(result({ is_error: true, result: 'Invalid API key' }))).toMatchObject({ text: null, error: 'Invalid API key' })
    expect(parseClaudeResult(result({ subtype: 'error_max_turns', is_error: true, result: undefined, errors: ['Reached maximum number of turns (1)'] }))).toMatchObject({ text: null, error: 'Reached maximum number of turns (1)' })
    expect(parseClaudeResult(result({ result: undefined }))).toMatchObject({ text: null })
    expect(parseClaudeResult(result({ is_error: undefined }))).toMatchObject({ text: null })
    expect(parseClaudeResult('')).toBeNull()
    expect(parseClaudeResult('{"type":"assistant"}\n')).toBeNull()
  })
})

describe('proving the Claude Code executable (WP1.17)', () => {
  const deps = (over: Record<string, unknown> = {}) => ({
    resolve: async () => EXE as string | null,
    realpath: (p: string) => p,
    stat: () => STAT,
    runVersion: vi.fn(async () => ({ exitCode: 0, stdout: '2.1.278 (Claude Code)\n', timedOut: false })),
    platform: 'win32' as NodeJS.Platform,
    now: () => 5,
    ...over,
  })

  it('a CLI at or above the floor is found and supported, its identity recorded', async () => {
    const d = await discoverClaude(deps())
    expect(d).toMatchObject({ state: 'found', executable: EXE, version: '2.1.278', compatibility: 'supported' })
    expect(d.identity).toEqual({ path: EXE, size: 100, mtimeMs: 1000, ctimeMs: 2000, dev: '7', ino: '99999999999999999' })
    expect(await discoverClaude(deps({ runVersion: async () => ({ exitCode: 0, stdout: '2.1.281 (Claude Code)\n', timedOut: false }) }))).toMatchObject({ compatibility: 'supported' })
  })

  it('an older CLI is too old; no CLI is missing; an unrecognised answer, a refusal or a change mid-check is invalid', async () => {
    expect(await discoverClaude(deps({ runVersion: async () => ({ exitCode: 0, stdout: '2.1.277 (Claude Code)\n', timedOut: false }) }))).toMatchObject({ state: 'found', compatibility: 'too-old' })
    expect(await discoverClaude(deps({ resolve: async () => null }))).toMatchObject({ state: 'missing' })
    expect(await discoverClaude(deps({ runVersion: async () => ({ exitCode: 0, stdout: 'hello\n', timedOut: false }) }))).toMatchObject({ state: 'invalid' })
    expect(await discoverClaude(deps({ runVersion: async () => ({ refused: 'no' }) }))).toMatchObject({ state: 'invalid' })
    let n = 0
    expect(await discoverClaude(deps({ stat: () => (n++ === 0 ? STAT : { ...STAT, size: 101 }) }))).toMatchObject({ state: 'invalid' })
    expect(parseClaudeVersion('v2.1.278')).toBeNull()
  })

  it('before a launch: the same file passes; another path, a replaced file or no file does not', async () => {
    const d = await discoverClaude(deps())
    expect(await verifyClaudeExecutable(d.identity!, deps())).toEqual({ ok: true, executable: EXE })
    expect(await verifyClaudeExecutable(d.identity!, deps({ realpath: () => 'C:\\Other\\claude.exe' }))).toMatchObject({ ok: false, reason: 'moved' })
    expect(await verifyClaudeExecutable(d.identity!, deps({ stat: () => ({ ...STAT, ctimeMs: 3000 }) }))).toMatchObject({ ok: false, reason: 'replaced' })
    expect(await verifyClaudeExecutable(d.identity!, deps({ resolve: async () => null }))).toMatchObject({ ok: false, reason: 'missing' })
  })
})

describe('the review-only Claude launch (WP1.38, WP1.46)', () => {
  function ports(over: Partial<ClaudeReviewPorts> = {}) {
    const state = { version: '2.1.278', stat: STAT, realm: realm() as AuthRealm | null }
    const versionRuns: string[] = []
    const p: ClaudeReviewPorts = {
      lookupRealm: vi.fn(async () => (state.realm ? { ok: true as const, realm: state.realm } : { ok: false as const })),
      profileRealmLaunch: vi.fn((id: string) => ({ home: `C:\\res\\profiles\\${id}`, baseEnv: { PATH: 'C:\\Windows' }, realmEnv: { set: { USERPROFILE: `C:\\res\\profiles\\${id}` } }, sessionsDir: `C:\\res\\profiles\\${id}\\.claude\\projects` })),
      holdProfile: vi.fn(async () => () => {}),
      recordPreflight: vi.fn(),
      resolveExecutable: vi.fn(async () => EXE),
      fileStat: { realpath: (x) => x, stat: () => state.stat },
      commandLine: (e, a, pl, s) => cliCommandLine(e, a, pl, s, 'Claude Code'),
      shellEnv: codexShellEnv,
      run: vi.fn(async (cmd: ClaudeCliCommand) => { versionRuns.push(cmd.args.join(' ')); return ran({ stdout: `${state.version} (Claude Code)\n` }) }),
      platform: 'win32',
      now: () => 1,
      ...over,
    }
    return { p, state, versionRuns }
  }

  it('prepares reviews only, in the reviewer account\'s profile home, on the executable it proved', async () => {
    const t = ports()
    const parts = createClaudeReviewLaunch(t.p)
    expect(parts.launch.kinds).toEqual(['review'])
    await parts.setup.discover()
    const r = await parts.launch.prepare({ authRealmId: realm().id })
    expect(r).toEqual({
      ok: true, home: `C:\\res\\profiles\\${PID}`, executable: EXE, baseEnv: { PATH: 'C:\\Windows' },
      realmEnv: { set: { USERPROFILE: `C:\\res\\profiles\\${PID}` } }, sessionsDir: `C:\\res\\profiles\\${PID}\\.claude\\projects`,
    })
    expect(t.p.profileRealmLaunch).toHaveBeenCalledWith(PID)
    expect(t.versionRuns).toEqual(['--version'])
    expect(await parts.launch.sessionsDir({ authRealmId: realm().id })).toBeNull()
  })

  it('a first launch proves the executable itself; a proven one is only re-verified', async () => {
    const t = ports()
    const parts = createClaudeReviewLaunch(t.p)
    expect(await parts.launch.prepare({ authRealmId: realm().id })).toMatchObject({ ok: true, executable: EXE })
    expect(t.versionRuns).toHaveLength(1)
    expect(await parts.launch.prepare({ authRealmId: realm().id })).toMatchObject({ ok: true })
    expect(t.versionRuns).toHaveLength(1)
  })

  it('Claude Code updated in place is proved again before it runs; an update below the floor is refused', async () => {
    const t = ports()
    const parts = createClaudeReviewLaunch(t.p)
    await parts.setup.discover()
    t.state.stat = { ...STAT, ctimeMs: 9000, mtimeMs: 9000 }
    t.state.version = '2.1.290'
    expect(await parts.launch.prepare({ authRealmId: realm().id })).toMatchObject({ ok: true, executable: EXE })
    expect(t.versionRuns).toHaveLength(2)
    t.state.stat = { ...STAT, ctimeMs: 9500 }
    t.state.version = '2.1.100'
    expect(await parts.launch.prepare({ authRealmId: realm().id })).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(t.p.profileRealmLaunch).toHaveBeenCalledTimes(1)
  })

  it('no CLI, a realm that is not a live Claude profile home, or a profile home that cannot be composed prepares nothing', async () => {
    const none = ports({ resolveExecutable: vi.fn(async () => null) })
    expect(await createClaudeReviewLaunch(none.p).launch.prepare({ authRealmId: realm().id })).toMatchObject({ ok: false, code: 'cli-unavailable' })
    for (const bad of [null, realm({ kind: 'codex-home' as never }), realm({ pathRef: 'managed:x' }), realm({ pathRef: 'claude-profile:../../x' }), realm({ pathRef: 'claude-profile:' })]) {
      const t = ports()
      t.state.realm = bad
      expect(await createClaudeReviewLaunch(t.p).launch.prepare({ authRealmId: realm().id }), JSON.stringify(bad)).toMatchObject({ ok: false, code: 'realm-unavailable' })
      expect(t.p.profileRealmLaunch).not.toHaveBeenCalled()
    }
    const throwing = ports({ profileRealmLaunch: vi.fn(() => { throw new Error('links') }) })
    expect(await createClaudeReviewLaunch(throwing.p).launch.prepare({ authRealmId: realm().id })).toMatchObject({ ok: false, code: 'not-started' })
  })

  it('the reviewer resolves its account from the prepared launch\'s realm', async () => {
    const t = ports()
    const parts = createClaudeReviewLaunch(t.p)
    t.p.run = vi.fn(async (_c: ClaudeCliCommand, o: ClaudeCliRunOptions) => { o.onChunk?.(result(), 'stdout'); return ran() })
    expect(await parts.review.run(input())).toMatchObject({ ok: true })
    expect(t.p.holdProfile).toHaveBeenCalledWith(PID, expect.any(Number), undefined)
    t.state.realm = realm({ pathRef: 'claude-profile:not a profile' })
    expect(await parts.review.run(input())).toMatchObject({ ok: false, code: 'not-started' })
  })

  it('the package offers setup, a review-only launch and a reviewer only when the composition root hands it the ports', () => {
    const bare = createClaudePackage()
    expect(bare.launch).toBeUndefined()
    expect(bare.review).toBeUndefined()
    expect(bare.setup).toBeUndefined()
    const pkg = createClaudePackage({ review: ports().p })
    expect(packageRegistrationProblem(pkg)).toBeNull()
    expect(pkg.launch?.kinds).toEqual(['review'])
    expect(typeof pkg.review?.run).toBe('function')
    expect(pkg.capabilities['cli.discovery'].state).toBe('unknown')
  })
})

describe('the command-line rules the composition root hands the Claude package', () => {
  it('refuse an argv element a shell or cmd.exe would read, on every route', () => {
    for (const bad of ['a b', '"x"', '%PATH%', 'a&b', 'a|b', '!x!', 'a^b', '(x)', '<x', '']) {
      expect(cliCommandLine(EXE, ['-p', bad], 'win32', { SystemRoot: 'C:\\Windows' }, 'Claude Code'), bad).toHaveProperty('refused')
      expect(cliCommandLine(SHIM, ['-p', bad], 'win32', { SystemRoot: 'C:\\Windows' }, 'Claude Code'), bad).toHaveProperty('refused')
      expect(cliCommandLine('/usr/bin/claude', ['-p', bad], 'linux', {}, 'Claude Code'), bad).toHaveProperty('refused')
    }
    expect(cliCommandLine(SHIM, CLAUDE_REVIEW_ARGS, 'win32', { SystemRoot: 'C:\\Windows' }, 'Claude Code')).not.toHaveProperty('refused')
  })
})

// ADR-009 round 1 (5b): the guards the correctness lens found no failing test
// for, each now with one.
describe('the Claude reviewer, round-1 regressions (WP2 5b)', () => {
  it('a hold that comes back empty (the run was cancelled while it waited) runs nothing and releases nothing', async () => {
    const h = reviewDeps({ holdProfile: vi.fn(async () => null) })
    expect(await createClaudeReviewOperations(h.deps).run(input())).toMatchObject({ ok: false, code: 'cancelled' })
    expect(h.run).not.toHaveBeenCalled()
    const ac = new AbortController()
    const w = reviewDeps()
    await createClaudeReviewOperations(w.deps).run(input({ signal: ac.signal }))
    expect(w.deps.holdProfile).toHaveBeenCalledWith(PID, 60_000 + CLAUDE_REVIEW_HOLD_GRACE_MS, ac.signal)
  })

  it('a cancel the runner does not report (it finished) is still a cancel', async () => {
    const ac = new AbortController()
    const h = reviewDeps()
    h.deps.run = runner(() => { ac.abort(); return { stdout: result() } }).run
    expect(await createClaudeReviewOperations(h.deps).run(input({ signal: ac.signal }))).toMatchObject({ ok: false, code: 'cancelled' })
  })

  it('a result line past the stdout bound is refused, even when it is valid JSON', async () => {
    const h = reviewDeps()
    h.deps.run = runner(() => ({ stdout: result({ result: 'y'.repeat(CLAUDE_REVIEW_MAX_STDOUT) }) })).run
    expect(await createClaudeReviewOperations(h.deps).run(input())).toMatchObject({ ok: false, code: 'no-output' })
  })

  it('only subtype success is a review, even with is_error false', () => {
    expect(parseClaudeResult(result({ subtype: 'error_max_turns', is_error: false, result: 'half a review' }))).toMatchObject({ text: null })
  })

  it('the verbose form (the user\'s own config turns verbose on) is read too: its last result is the review', () => {
    const arr = JSON.stringify([{ type: 'system', subtype: 'init' }, { type: 'assistant' }, JSON.parse(result())]) + '\n'
    expect(parseClaudeResult(arr)).toMatchObject({ text: '1. A finding.', usage: { inputTokens: 115 } })
    expect(parseClaudeResult('[{"type":"assistant"}]\n')).toBeNull()
  })

  it('discovery: a CLI path that is not a file, or a --version that fails, is not proven', async () => {
    const base = {
      resolve: async () => EXE as string | null, realpath: (p: string) => p, stat: () => STAT,
      runVersion: vi.fn(async () => ({ exitCode: 0, stdout: '2.1.278 (Claude Code)\n', timedOut: false })), platform: 'win32' as NodeJS.Platform, now: () => 1,
    }
    expect(await discoverClaude({ ...base, stat: () => ({ ...STAT, isFile: false }) })).toMatchObject({ state: 'invalid' })
    expect(await discoverClaude({ ...base, runVersion: vi.fn(async () => ({ exitCode: 1, stdout: '2.1.278 (Claude Code)\n', timedOut: false })) })).toMatchObject({ state: 'invalid' })
    expect(await discoverClaude({ ...base, runVersion: vi.fn(async () => ({ exitCode: null, stdout: '', timedOut: true })) })).toMatchObject({ state: 'error' })
  })
})

describe('the review-only Claude launch, round-1 regressions (WP2 5b)', () => {
  function ports(version: () => string, over: Partial<ClaudeReviewPorts> = {}) {
    const runs: string[] = []
    const p: ClaudeReviewPorts = {
      lookupRealm: async () => ({ ok: true as const, realm: realm() }),
      profileRealmLaunch: vi.fn((id: string) => ({ home: `H:\\${id}`, baseEnv: {}, realmEnv: { set: {} }, sessionsDir: 'H:\\s' })),
      holdProfile: vi.fn(async () => () => {}),
      recordPreflight: vi.fn(),
      resolveExecutable: async () => EXE,
      fileStat: { realpath: (x) => x, stat: () => STAT },
      commandLine: (e, a, pl, s) => cliCommandLine(e, a, pl, s, 'Claude Code'),
      shellEnv: codexShellEnv,
      run: vi.fn(async () => { runs.push('--version'); return ran({ stdout: `${version()} (Claude Code)\n` }) }),
      platform: 'win32',
      ...over,
    }
    return { p, runs }
  }

  it('a proven CLI below the floor is never run: the same file is proved again and refused', async () => {
    const t = ports(() => '2.1.100')
    const parts = createClaudeReviewLaunch(t.p)
    expect(await parts.setup.discover()).toMatchObject({ state: 'found', compatibility: 'too-old' })
    expect(await parts.launch.prepare({ authRealmId: realm().id })).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(t.runs).toHaveLength(2)
    expect(t.p.profileRealmLaunch).not.toHaveBeenCalled()
  })

  it('overlapping checks keep the NEWEST proof: an older, slower one finishing last does not replace it', async () => {
    let v = '2.1.100'
    let releaseSlow!: () => void
    const slow = new Promise<void>((r) => { releaseSlow = r })
    let n = 0
    const t = ports(() => v, {
      run: vi.fn(async () => {
        const mine = ++n
        // The first check is the older one, and it saw the older file.
        const answer = mine === 1 ? '2.1.100' : v
        if (mine === 1) await slow
        return ran({ stdout: `${answer} (Claude Code)\n` })
      }),
    })
    const parts = createClaudeReviewLaunch(t.p)
    const older = parts.setup.discover()
    v = '2.1.278'
    expect(await parts.setup.discover()).toMatchObject({ compatibility: 'supported' })
    releaseSlow()
    expect(await older).toMatchObject({ compatibility: 'too-old' })
    expect(await parts.launch.prepare({ authRealmId: realm().id })).toMatchObject({ ok: true })
    expect(n).toBe(2)
  })

  it('a profile that cannot review here (macOS: not the primary) is refused with the reason, before anything runs', async () => {
    const t = ports(() => '2.1.278', { profileRealmLaunch: vi.fn(() => ({ refused: 'on macOS a review runs on your normal Claude sign-in' })) })
    expect(await createClaudeReviewLaunch(t.p).launch.prepare({ authRealmId: realm().id })).toEqual({ ok: false, code: 'realm-unavailable', message: 'on macOS a review runs on your normal Claude sign-in' })
  })

  it('answers the platform rule on its own, from the registry record, with nothing run (WP2 commit 6)', () => {
    const rule = vi.fn((id: string) => (id === PID ? 'On macOS a Claude review runs on your normal Claude sign-in.' : null))
    const t = ports(() => '2.1.278', { profileReviewRefusal: rule })
    const launch = createClaudeReviewLaunch(t.p).launch
    expect(launch.reviewRefusal!(realm())).toBe('On macOS a Claude review runs on your normal Claude sign-in.')
    expect(rule).toHaveBeenCalledWith(PID)
    // A record that names no profile is left to prepare, which refuses it: the
    // rule is not even asked (this one would refuse any profile it is asked about).
    const refuseAll = vi.fn((_id: string) => 'refused')
    const strict = createClaudeReviewLaunch(ports(() => '2.1.278', { profileReviewRefusal: refuseAll }).p).launch
    expect(strict.reviewRefusal!(realm({ pathRef: 'somewhere-else' }))).toBeNull()
    expect(refuseAll).not.toHaveBeenCalled()
    // No platform rule wired: nothing refuses here.
    expect(createClaudeReviewLaunch(ports(() => '2.1.278').p).launch.reviewRefusal!(realm())).toBeNull()
    // A rule that cannot tell throws through: the accounts service refuses to
    // offer on it but never clears a choice because of it.
    const failing = createClaudeReviewLaunch(ports(() => '2.1.278', { profileReviewRefusal: () => { throw new Error('unreadable') } }).p).launch
    expect(() => failing.reviewRefusal!(realm())).toThrow('unreadable')
    expect(t.p.profileRealmLaunch).not.toHaveBeenCalled()
    expect(t.p.run).not.toHaveBeenCalled()
  })
})

describe('the composition root wires the reviewer\'s account hold', () => {
  it('the hold is holdProfileForRun (taken before the refresh wait, re-armed after it, cancellable)', async () => {
    const { claudeReviewPorts } = await import('../../src/main/providers/compose')
    const { holdProfileForRun } = await import('../../src/main/profile-consumers')
    expect(claudeReviewPorts.holdProfile).toBe(holdProfileForRun)
  })

  it('the platform rule is account-profiles\' profileReviewRefusal (off macOS it refuses nothing)', async () => {
    const { claudeReviewPorts } = await import('../../src/main/providers/compose')
    const { profileReviewRefusal } = await import('../../src/main/account-profiles')
    expect(claudeReviewPorts.profileReviewRefusal).toBe(profileReviewRefusal)
    expect(profileReviewRefusal('profile-a1', 'win32')).toBeNull()
    expect(profileReviewRefusal('profile-a1', 'linux')).toBeNull()
    if (process.platform !== 'darwin') expect(claudeReviewPorts.profileReviewRefusal!('profile-a1')).toBeNull()
  })

  it('the realm lookup answers only for a realm in use', async () => {
    const { claudeReviewPorts } = await import('../../src/main/providers/compose')
    const live = realm()
    const retired = realm({ id: 'realm-' + '2'.repeat(32), lifecycle: 'retired' as never })
    reg.doc = { realms: [live, retired] }
    expect(await claudeReviewPorts.lookupRealm({ authRealmId: live.id })).toEqual({ ok: true, realm: live })
    expect(await claudeReviewPorts.lookupRealm({ authRealmId: retired.id })).toEqual({ ok: false })
    expect(await claudeReviewPorts.lookupRealm({ authRealmId: 'realm-' + '3'.repeat(32) })).toEqual({ ok: false })
    reg.doc = null
    expect(await claudeReviewPorts.lookupRealm({ authRealmId: live.id })).toEqual({ ok: false })
  })
})
