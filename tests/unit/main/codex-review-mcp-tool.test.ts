import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// Every provider is on here: main's launch rule has its own suites
// (tests/unit/main/provider-launch-gate.test.ts and the provider-off tests).
vi.mock('../../../src/main/provider-launch-gate', () => ({ providerLaunchRefusal: () => null, providerProbeRefusal: () => null }))
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock setup-handlers and usage module.
let testResourcesDir: string
vi.mock('../../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: () => testResourcesDir,
}))
const recordReview = vi.fn()
vi.mock('../../../src/main/codex-review-usage', () => ({
  recordReview: (sessionId: string, payload: any) => recordReview(sessionId, payload),
}))

// debug-logger is already mocked globally in tests/unit/setup.ts; no per-file
// mock needed here. (Source under test calls logInfo through that module.)

import { runCodexReview, runClaudeReview, registerCodexReviewTool, registerClaudeReviewTool, abortSessionReviews, cancelReviewRequest, MAX_REVIEWS_PER_SESSION } from '../../../src/main/codex-review-mcp-tool'
import type { ReviewToolDeps } from '../../../src/main/codex-review-mcp-tool'

const optedIn = new Set<string>(['sess-allowed'])

// WP2 commit 5a: a review runs on a launch the accounts service prepared
// (kind `review`) and through the Codex package's reviewer adapter. Both are
// injected here: the service's own rules are covered by tests/wp1 and the
// adapter's by tests/wp1/cli-discovery.test.ts.
interface Harness { deps: ReviewToolDeps; prepareLaunch: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }
function makeDeps(): Harness {
  const release = vi.fn()
  const prepareLaunch = vi.fn(async (_input: Record<string, unknown>): Promise<Record<string, unknown>> => ({
    ok: true, lease: { release }, binding: { providerAccountId: 'acct-1', authRealmId: 'realm-1' }, realmOnly: false, reviewer: 'reviewer-default',
    home: 'C:/res/codex-realms/r1', executable: 'C:/proven/codex.exe', env: { PATH: '/usr/bin', CODEX_HOME: 'C:/res/codex-realms/r1' }, sessionsDir: 'C:/res/codex-realms/r1/sessions',
  }))
  const run = vi.fn(async (_input: Record<string, unknown>): Promise<Record<string, unknown>> => ({ ok: true, text: '1. A finding.\n', usage: { inputTokens: 1200, cachedInputTokens: 200, outputTokens: 80 } }))
  return { deps: { accounts: () => ({ prepareLaunch }) as never, reviewer: () => ({ run }) as never }, prepareLaunch, run, release }
}

describe('codex_review tool', () => {
  // gitCwd: real on-disk dir with a `.git` marker so the P7.7.9 git-repo
  // guard passes for tests that exercise mode 'working' or 'range'.
  let gitCwd: string
  let h: Harness

  beforeEach(() => {
    testResourcesDir = mkdtempSync(join(tmpdir(), 'ccc-codex-review-tool-'))
    gitCwd = mkdtempSync(join(tmpdir(), 'ccc-codex-review-git-'))
    mkdirSync(join(gitCwd, '.git'))
    recordReview.mockReset()
    h = makeDeps()
  })

  afterEach(() => {
    rmSync(testResourcesDir, { recursive: true, force: true })
    rmSync(gitCwd, { recursive: true, force: true })
  })

  it('rejects when sessionId is not in opted-in set', async () => {
    const r = await runCodexReview({ cccSessionId: 'sess-other', mode: 'working' }, optedIn, gitCwd, h.deps)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/not enabled/i)
    expect(h.prepareLaunch).not.toHaveBeenCalled()
  })

  it('rejects mode "range" without range arg via zod', async () => {
    const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'range' }, optedIn, gitCwd, h.deps)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/range/)
  })

  it('rejects mode "paths" with empty paths via zod', async () => {
    const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'paths', paths: [] }, optedIn, gitCwd, h.deps)
    expect(r.isError).toBe(true)
  })

  it('rejects mode "paths" with paths outside the cwd, relative or absolute', async () => {
    for (const p of ['../../etc/passwd', '/etc/passwd']) {
      const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'paths', paths: [p] }, optedIn, gitCwd, h.deps)
      expect(r.isError, p).toBe(true)
      expect(r.text).toMatch(/inside the session cwd/)
    }
    expect(h.prepareLaunch).not.toHaveBeenCalled()
  })

  it('rejects mode "working" / "range" when the cwd lacks a .git, before any account is used; "paths" works outside a repo', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'ccc-codex-review-plain-'))
    try {
      for (const args of [{ mode: 'working' }, { mode: 'range', range: 'HEAD~1..HEAD' }]) {
        const r = await runCodexReview({ cccSessionId: 'sess-allowed', ...args }, optedIn, plain, h.deps)
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/requires a git repository/)
      }
      expect(h.prepareLaunch).not.toHaveBeenCalled()
      writeFileSync(join(plain, 'a.ts'), 'x')
      const ok = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'paths', paths: ['a.ts'] }, optedIn, plain, h.deps)
      expect(ok.isError).toBe(false)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('accepts mode "working" when .git is a FILE (git worktree)', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'ccc-codex-review-wt-'))
    try {
      writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere\n')
      const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, wt, h.deps)
      expect(r.isError).toBe(false)
    } finally {
      rmSync(wt, { recursive: true, force: true })
    }
  })

  it('refuses when resolvedCwd is the home directory (no project dir)', async () => {
    const os = await import('os')
    const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'paths', paths: ['x'] }, optedIn, os.homedir(), h.deps)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/no project directory/)
    expect(h.prepareLaunch).not.toHaveBeenCalled()
  })

  it('rejects when cccSessionId is missing (no transport binding, no arg)', async () => {
    const r = await runCodexReview({ mode: 'working' }, optedIn, gitCwd, h.deps)
    expect(r.isError).toBe(true)
    expect(r.text).toMatch(/no Conductor session id/)
  })

  describe('WP2 commit 5a: the reviewer runs on a prepared review launch', () => {
    it('asks the accounts service for a LOCAL review launch on Codex, a fresh owner per call, naming no account (reviewer default, else provider default)', async () => {
      await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, h.deps)
      await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, h.deps)
      const [a, b] = h.prepareLaunch.mock.calls.map((c) => c[0] as Record<string, unknown>)
      expect(a).toMatchObject({ kind: 'review', providerId: 'codex', remote: false })
      expect(a.providerAccountId).toBeUndefined()
      expect(a.acknowledgeRealmOnly).toBeUndefined()
      expect(a.ownerId).toMatch(/^review:sess-allowed:\d+$/)
      expect(b.ownerId).not.toBe(a.ownerId)
    })

    it('runs the prepared executable in the prepared realm environment, in the project, with the request on stdin -- never argv', async () => {
      await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'range', range: 'HEAD~1..HEAD', focus: 'race %OPENAI_API_KEY% & calc' }, optedIn, gitCwd, h.deps)
      const input = h.run.mock.calls[0][0] as Record<string, unknown>
      expect(input).toMatchObject({ executable: 'C:/proven/codex.exe', env: { CODEX_HOME: 'C:/res/codex-realms/r1' }, cwd: gitCwd, timeoutMs: 5 * 60 * 1000 })
      // The text a session supplies travels as the prompt, byte for byte.
      expect(input.prompt).toContain('Scope: git revision range HEAD~1..HEAD.')
      expect(input.prompt).toContain('Focus area: race %OPENAI_API_KEY% & calc')
    })

    it('honours caller-supplied timeoutSeconds, and says so when it runs out', async () => {
      h.run.mockResolvedValueOnce({ ok: false, code: 'timed-out', message: 'The review timed out.' })
      const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working', timeoutSeconds: 45 }, optedIn, gitCwd, h.deps)
      expect((h.run.mock.calls[0][0] as Record<string, unknown>).timeoutMs).toBe(45_000)
      expect(r.isError).toBe(true)
      expect(r.text).toContain('timed out after 45 seconds')
    })

    it('returns the review with a usage footer and records the usage', async () => {
      const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, h.deps)
      expect(r.isError).toBe(false)
      expect(r.text).toContain('1. A finding.')
      expect(r.text).toContain('1200 input tokens (200 cached), 80 output tokens')
      expect(recordReview).toHaveBeenCalledWith('sess-allowed', { inputTokens: 1200, outputTokens: 80, rateLimit: null })
    })

    it('a failed review says why and still records what it used', async () => {
      h.run.mockResolvedValueOnce({ ok: false, code: 'failed', message: 'Codex exited with code 1: model overloaded.', usage: { inputTokens: 5, cachedInputTokens: 0, outputTokens: 0 } })
      const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, h.deps)
      expect(r.isError).toBe(true)
      expect(r.text).toContain('model overloaded')
      expect(recordReview).toHaveBeenCalledTimes(1)
    })

    it('the review lease is released once the run has ended -- after a result, a failure, and a throw', async () => {
      await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, h.deps)
      expect(h.release).toHaveBeenCalledTimes(1)
      h.run.mockResolvedValueOnce({ ok: false, code: 'failed', message: 'x' })
      await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, h.deps)
      expect(h.release).toHaveBeenCalledTimes(2)
      h.run.mockRejectedValueOnce(new Error('boom'))
      await expect(runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, h.deps)).rejects.toThrow('boom')
      expect(h.release).toHaveBeenCalledTimes(3)
    })

    it('a refused launch runs nothing and says what to do: an unverified sign-in, no account, Codex off, accounts not ready', async () => {
      for (const [code, expected] of [
        ['acknowledgement-required', /Add a Codex account in Accounts/],
        ['not-found', /needs a Codex account/],
        ['provider-disabled', /turned off/],
        ['cli-unavailable', /Codex review unavailable: The CLI moved/],
      ] as const) {
        h.prepareLaunch.mockResolvedValueOnce({ ok: false, code, message: code === 'cli-unavailable' ? 'The CLI moved.' : 'x' })
        const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, h.deps)
        expect(r.isError, code).toBe(true)
        expect(r.text, code).toMatch(expected)
      }
      expect(h.run).not.toHaveBeenCalled()
      const noAccounts = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, { ...h.deps, accounts: () => null })
      expect(noAccounts.text).toMatch(/not ready/)
      const noReviewer = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, { ...h.deps, reviewer: () => undefined })
      expect(noReviewer.text).toMatch(/not ready/)
      expect(h.run).not.toHaveBeenCalled()
    })
  })
})

describe('WP2 5a, ADR-009 round 1: a review never outlives its request or its session', () => {
  let gitCwd: string
  let h: Harness
  const sets = new Set<string>(['sess-allowed', 'sess-other'])
  // A run that ends only when it is stopped, as a real long review does.
  const untilStopped = (input: Record<string, unknown>) => new Promise<Record<string, unknown>>((res) => {
    const s = input.signal as AbortSignal
    const done = () => res({ ok: false, code: 'cancelled', message: 'The review was cancelled.' })
    if (s.aborted) done(); else s.addEventListener('abort', done)
  })
  beforeEach(() => {
    testResourcesDir = mkdtempSync(join(tmpdir(), 'ccc-codex-review-tool-'))
    gitCwd = mkdtempSync(join(tmpdir(), 'ccc-codex-review-git-'))
    mkdirSync(join(gitCwd, '.git'))
    h = makeDeps()
  })
  afterEach(() => {
    abortSessionReviews('sess-allowed')
    abortSessionReviews('sess-other')
    rmSync(testResourcesDir, { recursive: true, force: true })
    rmSync(gitCwd, { recursive: true, force: true })
  })

  it('the lease is held for the whole run, and released only once it has settled', async () => {
    h.run.mockImplementationOnce(async () => {
      expect(h.release).not.toHaveBeenCalled()
      return { ok: true, text: 'fine' }
    })
    await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps)
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('the MCP request\'s cancel stops the reviewer; the lease goes and the agent is told', async () => {
    h.run.mockImplementationOnce(untilStopped)
    const ac = new AbortController()
    const p = runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps, ac.signal)
    await vi.waitFor(() => expect(h.run).toHaveBeenCalled())
    ac.abort()
    expect(await p).toEqual({ isError: true, text: 'Codex review was cancelled.' })
    expect((h.run.mock.calls[0][0].signal as AbortSignal).aborted).toBe(true)
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('a request cancelled before it starts prepares nothing; one cancelled while preparing releases what it took and runs nothing', async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps, ac.signal)).toMatchObject({ isError: true, text: 'Codex review was cancelled.' })
    expect(h.prepareLaunch).not.toHaveBeenCalled()
    const ac2 = new AbortController()
    const prep = h.prepareLaunch.getMockImplementation() as (i: Record<string, unknown>) => Promise<Record<string, unknown>>
    h.prepareLaunch.mockImplementationOnce(async (i: Record<string, unknown>) => { const r = await prep(i); ac2.abort(); return r })
    expect(await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps, ac2.signal)).toMatchObject({ text: 'Codex review was cancelled.' })
    expect(h.run).not.toHaveBeenCalled()
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('closing the session stops its reviews (and only its own)', async () => {
    h.run.mockImplementation(untilStopped)
    const mine = runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps)
    const theirs = runCodexReview({ cccSessionId: 'sess-other', mode: 'working' }, sets, gitCwd, h.deps)
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2))
    abortSessionReviews('sess-allowed')
    expect(await mine).toMatchObject({ text: 'Codex review was cancelled.' })
    const signals = h.run.mock.calls.map((c) => c[0].signal as AbortSignal)
    expect(signals.filter((s) => s.aborted)).toHaveLength(1)
    abortSessionReviews('sess-other')
    await theirs
    expect(h.release).toHaveBeenCalledTimes(2)
  })

  it('a session respawned with the same id can ask again at once, while its stopped review is still settling (whose lease goes when it settles)', async () => {
    let settle: (() => void) | null = null
    h.run.mockImplementationOnce(() => new Promise((res) => { settle = () => res({ ok: false, code: 'cancelled', message: 'x' }) }))
    const old = runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps)
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1))
    abortSessionReviews('sess-allowed')
    const again = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps)
    expect(again).toMatchObject({ isError: false })
    expect(h.release).toHaveBeenCalledTimes(1)
    // A newer review starts before the stopped one settles; the stopped one's
    // cleanup must not free the newer one's place.
    h.run.mockImplementationOnce(untilStopped)
    const newer = runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps)
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(3))
    settle!()
    await old
    expect(h.release).toHaveBeenCalledTimes(2)
    expect(await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps)).toMatchObject({ text: expect.stringContaining('already running') })
    abortSessionReviews('sess-allowed')
    await newer
  })

  it('one review runs at a time for a session (a review cannot start another for it); a finished one frees its place', async () => {
    expect(MAX_REVIEWS_PER_SESSION).toBe(1)
    h.run.mockImplementation(untilStopped)
    const first = runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps)
    const second = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps)
    expect(second).toMatchObject({ isError: true, text: expect.stringContaining('already running for this session') })
    expect(h.prepareLaunch).toHaveBeenCalledTimes(1)
    // Another session is not limited by this one.
    const other = runCodexReview({ cccSessionId: 'sess-other', mode: 'working' }, sets, gitCwd, h.deps)
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2))
    abortSessionReviews('sess-allowed')
    await first
    h.run.mockImplementation(async () => ({ ok: true, text: 'again' }))
    expect(await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps)).toMatchObject({ isError: false })
    abortSessionReviews('sess-other')
    await other
  })

  it('the registered tool passes the MCP request\'s cancel signal through', async () => {
    let handler: ((args: unknown, extra?: { signal?: AbortSignal }) => Promise<any>) | null = null
    const server = { tool: (_n: string, _d: string, _s: unknown, fn: typeof handler) => { handler = fn } }
    const chain: any = new Proxy(function () { return chain }, { get: () => chain, apply: () => chain })
    registerCodexReviewTool(server, chain, () => sets, () => gitCwd, () => 'sess-allowed', h.deps)
    h.run.mockImplementationOnce(untilStopped)
    const ac = new AbortController()
    const p = handler!({ mode: 'working' }, { signal: ac.signal })
    await vi.waitFor(() => expect(h.run).toHaveBeenCalled())
    ac.abort()
    expect((await p).content[0].text).toBe('Codex review was cancelled.')
  })
})

describe('registerCodexReviewTool: the session id comes only from the transport', () => {
  let resolver: ((args: any) => Promise<any>) | null
  const mockServer = { tool: (_n: string, _d: string, _s: unknown, fn: (args: any) => Promise<any>) => { resolver = fn } }
  const chain: any = new Proxy(function () { return chain }, { get: () => chain, apply: () => chain })
  const mockZ = chain
  let boundCwd: string
  let otherCwd: string
  const sessionCwds = new Map<string, string>()
  const optedInSet = new Set<string>(['bound-sid', 'arg-sid'])
  let h: Harness

  beforeEach(() => {
    resolver = null
    boundCwd = mkdtempSync(join(tmpdir(), 'ccc-codex-review-bound-'))
    otherCwd = mkdtempSync(join(tmpdir(), 'ccc-codex-review-other-'))
    writeFileSync(join(boundCwd, 'x'), 'x')
    writeFileSync(join(otherCwd, 'x'), 'x')
    sessionCwds.clear()
    sessionCwds.set('bound-sid', boundCwd)
    sessionCwds.set('arg-sid', otherCwd)
    h = makeDeps()
  })
  afterEach(() => {
    rmSync(boundCwd, { recursive: true, force: true })
    rmSync(otherCwd, { recursive: true, force: true })
  })

  it('uses the transport-bound sessionId and its cwd, ignoring the LLM-supplied arg', async () => {
    registerCodexReviewTool(mockServer, mockZ, () => optedInSet, (sid: string) => sessionCwds.get(sid) ?? null, () => 'bound-sid', h.deps)
    expect(resolver).not.toBeNull()
    const out = await resolver!({ cccSessionId: 'arg-sid', mode: 'paths', paths: ['x'] })
    expect(out.isError).toBe(false)
    expect((h.run.mock.calls[0][0] as Record<string, unknown>).cwd).toBe(boundCwd)
    expect((h.prepareLaunch.mock.calls[0][0] as Record<string, unknown>).ownerId).toMatch(/^review:bound-sid:/)
  })

  it('REFUSES when no sessionId is bound (arg fallback removed), and when getBoundSessionId is omitted', async () => {
    registerCodexReviewTool(mockServer, mockZ, () => optedInSet, (sid: string) => sessionCwds.get(sid) ?? null, () => null, h.deps)
    let out = await resolver!({ cccSessionId: 'arg-sid', mode: 'paths', paths: ['x'] })
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('no bound Conductor session')
    registerCodexReviewTool(mockServer, mockZ, () => optedInSet, (sid: string) => sessionCwds.get(sid) ?? null)
    out = await resolver!({ cccSessionId: 'arg-sid', mode: 'paths', paths: ['x'] })
    expect(out.content[0].text).toContain('no bound Conductor session')
    expect(h.prepareLaunch).not.toHaveBeenCalled()
  })

  it('REFUSES a bound sid with no cwd mapping (never falls back to process.cwd)', async () => {
    registerCodexReviewTool(mockServer, mockZ, () => optedInSet, () => null, () => 'bound-sid', h.deps)
    const out = await resolver!({ mode: 'paths', paths: ['x'] })
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('not enabled')
    expect(h.prepareLaunch).not.toHaveBeenCalled()
  })
})

// WP2 commit 5b: claude_review, offered to a Codex session. It shares every
// session check and the one-review-per-session slot with codex_review; the
// change is produced by main (the reviewer has no git) and sent in the
// prompt between markers no diff can forge; it runs on the Claude reviewer
// account's prepared launch.
describe('claude_review tool (WP2 5b)', () => {
  let gitCwd: string
  let h: Harness
  let diff: ReturnType<typeof vi.fn>
  const sets = new Set<string>(['sess-allowed', 'sess-other'])
  const DIFF = 'diff --git a/x.ts b/x.ts\n+const y = 1\n'
  const claudeDeps = (): ReviewToolDeps => ({ ...h.deps, diff: diff as never })
  const untilStopped = (input: Record<string, unknown>) => new Promise<Record<string, unknown>>((res) => {
    const s = input.signal as AbortSignal
    const done = () => res({ ok: false, code: 'cancelled', message: 'The review was cancelled.' })
    if (s.aborted) done(); else s.addEventListener('abort', done)
  })
  beforeEach(() => {
    testResourcesDir = mkdtempSync(join(tmpdir(), 'ccc-claude-review-tool-'))
    gitCwd = mkdtempSync(join(tmpdir(), 'ccc-claude-review-git-'))
    mkdirSync(join(gitCwd, '.git'))
    recordReview.mockReset()
    h = makeDeps()
    diff = vi.fn(async () => ({ ok: true, diff: DIFF }))
  })
  afterEach(() => {
    abortSessionReviews('sess-allowed')
    abortSessionReviews('sess-other')
    rmSync(testResourcesDir, { recursive: true, force: true })
    rmSync(gitCwd, { recursive: true, force: true })
  })

  it('runs on the Claude reviewer launch, the change from main in the prompt between nonce markers, the account\'s realm passed on', async () => {
    const r = await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'range', range: 'HEAD~1..HEAD', focus: 'races' }, sets, gitCwd, claudeDeps())
    expect(r).toEqual({ isError: false, text: '1. A finding.\n\n\n---\nClaude review -- 1 message used -- 1200 input tokens (200 cached), 80 output tokens.' })
    expect(diff).toHaveBeenCalledWith({ cwd: gitCwd, mode: 'range', range: 'HEAD~1..HEAD', signal: expect.any(AbortSignal) })
    // The diff runs under the review's own stop: a cancel or the session's end stops git too.
    expect((diff.mock.calls[0][0] as { signal: AbortSignal }).signal).toBe((h.run.mock.calls[0][0] as { signal: AbortSignal }).signal)
    expect(h.prepareLaunch).toHaveBeenCalledWith({ kind: 'review', providerId: 'claude', ownerId: expect.stringMatching(/^review:sess-allowed:\d+$/), remote: false })
    const run = h.run.mock.calls[0][0] as Record<string, unknown>
    expect(run.realm).toEqual({ authRealmId: 'realm-1' })
    expect(run.cwd).toBe(gitCwd)
    const prompt = run.prompt as string
    const nonce = /<<<CHANGE-([0-9a-f]{16})\n/.exec(prompt)?.[1]
    expect(nonce).toBeDefined()
    expect(prompt).toContain(`<<<CHANGE-${nonce}\n${DIFF}\nCHANGE-${nonce}>>>`)
    expect(prompt).toContain('Scope: git revision range HEAD~1..HEAD.')
    expect(prompt).toContain('Focus area: races')
    await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, claudeDeps())
    expect(h.run.mock.calls[1][0].prompt).not.toContain(nonce)
    // Usage is recorded for Codex's own reviews only (the Claude session statusline).
    expect(recordReview).not.toHaveBeenCalled()
  })

  it('mode paths sends no diff: the reviewer reads the named files, still contained to the project', async () => {
    expect(await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'paths', paths: ['a.ts', 'src/b.ts'] }, sets, gitCwd, claudeDeps())).toMatchObject({ isError: false })
    expect(diff).not.toHaveBeenCalled()
    const prompt = h.run.mock.calls[0][0].prompt as string
    expect(prompt).toContain('(read them): a.ts, src/b.ts')
    expect(prompt).not.toContain('<<<CHANGE')
    expect(await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'paths', paths: ['../x'] }, sets, gitCwd, claudeDeps())).toMatchObject({ isError: true, text: 'Paths must be inside the session cwd. Rejected: ../x' })
  })

  it('nothing to review, or a change it cannot read, spends no account: no launch is prepared', async () => {
    diff.mockResolvedValueOnce({ ok: true, diff: '  \n' })
    expect(await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, claudeDeps())).toEqual({ isError: false, text: 'Claude review: nothing to review -- there are no uncommitted changes to tracked files.' })
    diff.mockResolvedValueOnce({ ok: false, message: 'the change is larger than 512 KB' })
    expect(await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'range', range: 'a..b' }, sets, gitCwd, claudeDeps())).toEqual({ isError: true, text: 'Claude review could not read the change: the change is larger than 512 KB.' })
    expect(h.prepareLaunch).not.toHaveBeenCalled()
    const noDiff = { ...h.deps }
    expect(await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, noDiff)).toMatchObject({ isError: true, text: expect.stringContaining('not ready') })
  })

  it('the diff runs inside the session\'s one review slot, shared with codex_review; a cancel while it runs prepares nothing', async () => {
    let finish!: (v: unknown) => void
    diff.mockImplementationOnce(() => new Promise((r) => { finish = r }))
    const ac = new AbortController()
    const first = runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, claudeDeps(), ac.signal)
    await vi.waitFor(() => expect(diff).toHaveBeenCalled())
    expect(await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, claudeDeps())).toMatchObject({ isError: true, text: expect.stringContaining('already running') })
    expect(await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, h.deps)).toMatchObject({ isError: true, text: expect.stringContaining('already running') })
    ac.abort()
    finish({ ok: true, diff: DIFF })
    expect(await first).toEqual({ isError: true, text: 'Claude review was cancelled.' })
    expect(h.prepareLaunch).not.toHaveBeenCalled()
    expect(await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, claudeDeps())).toMatchObject({ isError: false })
  })

  it('closing the session stops its Claude review and frees its place; the lease goes once the run settles', async () => {
    h.run.mockImplementationOnce(untilStopped)
    const p = runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, claudeDeps())
    await vi.waitFor(() => expect(h.run).toHaveBeenCalled())
    abortSessionReviews('sess-allowed')
    expect(await p).toEqual({ isError: true, text: 'Claude review was cancelled.' })
    expect(h.release).toHaveBeenCalledTimes(1)
  })

  it('refusals say what to do, in Claude\'s terms', async () => {
    h.prepareLaunch.mockResolvedValueOnce({ ok: false, code: 'not-found', message: 'x' })
    expect((await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, claudeDeps())).text).toBe('Claude review needs a Claude account: add one in Accounts, then try again.')
    h.prepareLaunch.mockResolvedValueOnce({ ok: false, code: 'provider-disabled', message: 'x' })
    expect((await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, claudeDeps())).text).toBe('Claude review is unavailable: Claude is turned off in Settings.')
    expect((await runClaudeReview({ cccSessionId: 'sess-nope', mode: 'working' }, sets, gitCwd, claudeDeps())).text).toContain('local Codex sessions')
    h.run.mockResolvedValueOnce({ ok: false, code: 'failed', message: 'Claude Code exited with code 1.' })
    expect((await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, sets, gitCwd, claudeDeps())).text).toBe('Claude review failed: Claude Code exited with code 1.\n\n---\nClaude review -- 1 message used. Usage data unavailable.')
  })

  it('the registered tool is claude_review, bound to the transport\'s session, and passes the cancel through', async () => {
    let name = ''
    let handler: ((args: unknown, extra?: { signal?: AbortSignal }) => Promise<any>) | null = null
    const server = { tool: (n: string, _d: string, _s: unknown, fn: typeof handler) => { name = n; handler = fn } }
    const chain: any = new Proxy(function () { return chain }, { get: () => chain, apply: () => chain })
    registerClaudeReviewTool(server, chain, () => sets, () => gitCwd, () => 'sess-allowed', claudeDeps())
    expect(name).toBe('claude_review')
    h.run.mockImplementationOnce(untilStopped)
    const ac = new AbortController()
    const p = handler!({ mode: 'working', cccSessionId: 'sess-other' }, { signal: ac.signal })
    await vi.waitFor(() => expect(h.run).toHaveBeenCalled())
    expect((h.prepareLaunch.mock.calls[0][0] as Record<string, unknown>).ownerId).toMatch(/^review:sess-allowed:/)
    ac.abort()
    expect((await p).content[0].text).toBe('Claude review was cancelled.')
    registerClaudeReviewTool(server, chain, () => sets, () => gitCwd, () => null, claudeDeps())
    expect((await handler!({ mode: 'working' })).content[0].text).toContain('no bound Conductor session')
  })
})

// ADR-009 confirmation (5b): on Codex's stateless /mcp route a request's
// cancel arrives on a connection of its own; the server routes it here by the
// session that connection authenticated and the request's id.
describe('a review request cancelled from another connection (WP2 5b)', () => {
  let gitCwd: string
  let h: Harness
  const sets = new Set<string>(['sess-allowed', 'sess-other'])
  const chain: any = new Proxy(function () { return chain }, { get: () => chain, apply: () => chain })
  beforeEach(() => {
    testResourcesDir = mkdtempSync(join(tmpdir(), 'ccc-claude-review-cancel-'))
    gitCwd = mkdtempSync(join(tmpdir(), 'ccc-claude-review-cancel-git-'))
    h = makeDeps()
  })
  afterEach(() => {
    abortSessionReviews('sess-allowed')
    rmSync(testResourcesDir, { recursive: true, force: true })
    rmSync(gitCwd, { recursive: true, force: true })
  })

  it('stops the review serving that request of that session, and nothing of any other session', async () => {
    let handler: ((args: unknown, extra?: { signal?: AbortSignal; requestId?: string | number }) => Promise<any>) | null = null
    const server = { tool: (_n: string, _d: string, _s: unknown, fn: typeof handler) => { handler = fn } }
    registerClaudeReviewTool(server, chain, () => sets, () => gitCwd, () => 'sess-allowed', { ...h.deps, diff: async () => ({ ok: true, diff: 'x' }) } as ReviewToolDeps)
    h.run.mockImplementationOnce((input: Record<string, unknown>) => new Promise((res) => {
      const s = input.signal as AbortSignal
      s.addEventListener('abort', () => res({ ok: false, code: 'cancelled', message: 'The review was cancelled.' }))
    }))
    const p = handler!({ mode: 'paths', paths: ['a.ts'] }, { requestId: 7 })
    await vi.waitFor(() => expect(h.run).toHaveBeenCalled())
    expect(cancelReviewRequest('sess-other', 7)).toBe(false)
    expect(cancelReviewRequest('sess-allowed', 8)).toBe(false)
    expect((h.run.mock.calls[0][0].signal as AbortSignal).aborted).toBe(false)
    expect(cancelReviewRequest('sess-allowed', 7)).toBe(true)
    expect((await p).content[0].text).toBe('Claude review was cancelled.')
    // Settled: the request is forgotten.
    expect(cancelReviewRequest('sess-allowed', 7)).toBe(false)
    expect(h.release).toHaveBeenCalledTimes(1)
  })
})
