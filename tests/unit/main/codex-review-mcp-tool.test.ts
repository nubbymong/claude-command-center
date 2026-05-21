import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock auth: BOTH runCodexStreaming and readCodexAuthStatus from the same mock factory.
// (The module under test imports both from './providers/codex/auth'.)
const runCodexStreaming = vi.fn()
const readCodexAuthStatus = vi.fn()
vi.mock('../../../src/main/providers/codex/auth', () => ({
  runCodexStreaming: (args: string[], opts: any) => runCodexStreaming(args, opts),
  readCodexAuthStatus: () => readCodexAuthStatus(),
}))

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

import { runCodexReview, registerCodexReviewTool } from '../../../src/main/codex-review-mcp-tool'

const optedIn = new Set<string>(['sess-allowed'])

describe('codex_review tool', () => {
  // gitCwd: real on-disk dir with a `.git` marker so the P7.7.9 git-repo
  // guard passes for tests that exercise mode 'working' or 'range'.
  let gitCwd: string

  beforeEach(() => {
    testResourcesDir = mkdtempSync(join(tmpdir(), 'ccc-codex-review-tool-'))
    gitCwd = mkdtempSync(join(tmpdir(), 'ccc-codex-review-git-'))
    mkdirSync(join(gitCwd, '.git'))
    runCodexStreaming.mockReset()
    readCodexAuthStatus.mockReset()
    recordReview.mockReset()
    readCodexAuthStatus.mockResolvedValue({
      installed: true, version: '0.125.0', authMode: 'chatgpt',
      planType: 'plus', hasOpenAiApiKeyEnv: false,
    })
  })

  afterEach(() => {
    rmSync(testResourcesDir, { recursive: true, force: true })
    rmSync(gitCwd, { recursive: true, force: true })
  })

  it('rejects when sessionId is not in opted-in set', async () => {
    const result = await runCodexReview(
      { cccSessionId: 'sess-other', mode: 'working' },
      optedIn, '/fake/cwd',
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not enabled for')
    expect(runCodexStreaming).not.toHaveBeenCalled()
  })

  it('rejects when codex CLI is not installed', async () => {
    readCodexAuthStatus.mockResolvedValue({
      installed: false, version: null, authMode: 'none', hasOpenAiApiKeyEnv: false,
    })
    const result = await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'working' },
      optedIn, '/fake/cwd',
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Codex CLI not installed')
  })

  it('rejects when not logged in', async () => {
    readCodexAuthStatus.mockResolvedValue({
      installed: true, version: '0.125.0', authMode: 'none', hasOpenAiApiKeyEnv: false,
    })
    const result = await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'working' },
      optedIn, '/fake/cwd',
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('not logged into Codex')
  })

  it('rejects mode "range" without range arg via zod', async () => {
    const result = await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'range' } as any,
      optedIn, '/fake/cwd',
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/range required/i)
  })

  it('rejects mode "paths" with empty paths via zod', async () => {
    const result = await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'paths', paths: [] },
      optedIn, '/fake/cwd',
    )
    expect(result.isError).toBe(true)
    expect(result.text).toMatch(/paths required/i)
  })

  it('rejects mode "paths" with paths outside the cwd', async () => {
    const result = await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'paths', paths: ['../../../etc/hosts'] },
      optedIn, '/some/repo',
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('inside the session cwd')
    expect(runCodexStreaming).not.toHaveBeenCalled()
  })

  it('rejects mode "paths" with absolute paths outside the cwd', async () => {
    const result = await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'paths', paths: ['/etc/hosts'] },
      optedIn, '/some/repo',
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('inside the session cwd')
  })

  it('accepts mode "paths" with paths inside the cwd', async () => {
    runCodexStreaming.mockImplementation(async (args: string[], _opts: any) => {
      const i = args.indexOf('--output-last-message')
      writeFileSync(args[i + 1], 'fine', 'utf-8')
      return { code: 0, stderr: '', timedOut: false }
    })
    const result = await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'paths', paths: ['src/foo.ts', 'src/bar.ts'] },
      optedIn, '/some/repo',
    )
    expect(result.isError).toBe(false)
  })

  it('builds the expected argv for mode "working" and reads the tmpfile', async () => {
    let capturedArgs: string[] = []
    runCodexStreaming.mockImplementation(async (args: string[], opts: any) => {
      capturedArgs = args
      const i = args.indexOf('--output-last-message')
      const tmpfile = args[i + 1]
      writeFileSync(tmpfile, '## Review\n\nNo issues found.\n', 'utf-8')
      opts.onStdoutLine(JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          total_token_usage: { input_tokens: 1500, output_tokens: 800 },
          rate_limits: {
            primary: { used_percent: 0.41, resets_at: 1714850000, window_minutes: 300 },
            plan_type: 'plus',
          },
        },
      }))
      return { code: 0, stderr: '', timedOut: false }
    })

    const result = await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'working', focus: 'race conditions' },
      optedIn, gitCwd,
    )

    expect(result.isError).toBe(false)
    expect(result.text).toContain('## Review')
    expect(result.text).toContain('No issues found.')
    expect(result.text).toContain('Codex review')
    expect(result.text).toContain('1 message used')
    expect(result.text).toContain('plus')

    expect(capturedArgs).toContain('exec')
    expect(capturedArgs).toContain('--json')
    expect(capturedArgs).toContain('--ephemeral')
    expect(capturedArgs).toContain('--sandbox')
    expect(capturedArgs).toContain('read-only')
    // P7.7.6: Codex CLI 0.128.0 removed --ask-for-approval from `codex exec`.
    // The flag is no longer passed; pin its absence so a future revert is caught.
    expect(capturedArgs).not.toContain('--ask-for-approval')
    expect(capturedArgs).toContain('-m')
    expect(capturedArgs).toContain('gpt-5.5')

    expect(recordReview).toHaveBeenCalledWith('sess-allowed', expect.objectContaining({
      inputTokens: 1500,
      outputTokens: 800,
      rateLimit: expect.objectContaining({ usedPercent: 0.41, planType: 'plus' }),
    }))
  })

  it('passes range to codex argv for mode "range"', async () => {
    let capturedArgs: string[] = []
    runCodexStreaming.mockImplementation(async (args: string[], opts: any) => {
      capturedArgs = args
      const i = args.indexOf('--output-last-message')
      writeFileSync(args[i + 1], 'fine', 'utf-8')
      return { code: 0, stderr: '', timedOut: false }
    })
    await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'range', range: 'HEAD~1..HEAD' },
      optedIn, gitCwd,
    )
    const flat = capturedArgs.join(' ')
    expect(flat).toContain('HEAD~1..HEAD')
  })

  it('returns timeout error when stream exceeds limit', async () => {
    runCodexStreaming.mockImplementation(async () => ({
      code: -1, stderr: '', timedOut: true,
    }))
    const result = await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'working' },
      optedIn, gitCwd,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('timed out')
  })

  it('returns non-zero exit error with stderr excerpt', async () => {
    runCodexStreaming.mockImplementation(async () => ({
      code: 2, stderr: 'codex: rate-limit window exhausted; resets in 47 minutes\n', timedOut: false,
    }))
    const result = await runCodexReview(
      { cccSessionId: 'sess-allowed', mode: 'working' },
      optedIn, gitCwd,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Codex review failed (exit 2)')
    expect(result.text).toContain('rate-limit window exhausted')
  })

  // P7.7.9 -- git-repo guard. Modes 'working' and 'range' rely on git
  // history; fail early with a clean message when the cwd isn't a repo
  // rather than paying for a spawn + quota hit before codex catches it.
  it('rejects mode "working" when cwd lacks a .git directory', async () => {
    const nonGitCwd = mkdtempSync(join(tmpdir(), 'ccc-codex-review-nogit-'))
    try {
      const result = await runCodexReview(
        { cccSessionId: 'sess-allowed', mode: 'working' },
        optedIn, nonGitCwd,
      )
      expect(result.isError).toBe(true)
      expect(result.text).toContain('requires a git repository')
      expect(result.text).toContain(nonGitCwd)
      expect(result.text).toContain("mode='paths'")
      expect(runCodexStreaming).not.toHaveBeenCalled()
    } finally {
      rmSync(nonGitCwd, { recursive: true, force: true })
    }
  })

  it('rejects mode "range" when cwd lacks a .git directory', async () => {
    const nonGitCwd = mkdtempSync(join(tmpdir(), 'ccc-codex-review-nogit-'))
    try {
      const result = await runCodexReview(
        { cccSessionId: 'sess-allowed', mode: 'range', range: 'HEAD~1..HEAD' },
        optedIn, nonGitCwd,
      )
      expect(result.isError).toBe(true)
      expect(result.text).toContain('requires a git repository')
      expect(runCodexStreaming).not.toHaveBeenCalled()
    } finally {
      rmSync(nonGitCwd, { recursive: true, force: true })
    }
  })

  it('accepts mode "working" when .git is a FILE (git worktree)', async () => {
    // In a linked worktree, `.git` is a file containing `gitdir: <path>` --
    // not a directory. existsSync returns true for both, so the guard must
    // accept this shape without an extra stat check.
    const worktreeCwd = mkdtempSync(join(tmpdir(), 'ccc-codex-review-worktree-'))
    writeFileSync(join(worktreeCwd, '.git'), 'gitdir: /tmp/main-repo/.git/worktrees/feature\n', 'utf-8')
    runCodexStreaming.mockImplementation(async (args: string[], _opts: any) => {
      const i = args.indexOf('--output-last-message')
      writeFileSync(args[i + 1], 'fine', 'utf-8')
      return { code: 0, stderr: '', timedOut: false }
    })
    try {
      const result = await runCodexReview(
        { cccSessionId: 'sess-allowed', mode: 'working' },
        optedIn, worktreeCwd,
      )
      expect(result.isError).toBe(false)
      expect(runCodexStreaming).toHaveBeenCalled()
    } finally {
      rmSync(worktreeCwd, { recursive: true, force: true })
    }
  })

  it('does NOT apply the git-repo guard to mode "paths" (works outside a repo)', async () => {
    const nonGitCwd = mkdtempSync(join(tmpdir(), 'ccc-codex-review-nogit-'))
    runCodexStreaming.mockImplementation(async (args: string[], _opts: any) => {
      const i = args.indexOf('--output-last-message')
      writeFileSync(args[i + 1], 'fine', 'utf-8')
      return { code: 0, stderr: '', timedOut: false }
    })
    try {
      const result = await runCodexReview(
        { cccSessionId: 'sess-allowed', mode: 'paths', paths: ['file.ts'] },
        optedIn, nonGitCwd,
      )
      expect(result.isError).toBe(false)
      expect(runCodexStreaming).toHaveBeenCalled()
    } finally {
      rmSync(nonGitCwd, { recursive: true, force: true })
    }
  })

  // P7.7.10 -- cccSessionId is now optional in the zod schema (resolved
  // server-side from the MCP transport URL). runCodexReview itself still
  // requires it -- the tool wrapper is responsible for merging in the
  // bound sid before calling the function. A direct call without sid
  // surfaces a wiring bug rather than silently falling through.
  it('rejects when cccSessionId is missing (no transport binding, no arg)', async () => {
    const result = await runCodexReview(
      { mode: 'working' },
      optedIn, gitCwd,
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('no CCC session id bound')
    expect(runCodexStreaming).not.toHaveBeenCalled()
  })
})

describe('registerCodexReviewTool resolver (P7.7.10 transport binding)', () => {
  // Capture the tool resolver lambda from a mock McpServer.
  let resolver: ((rawArgs: any) => Promise<any>) | null = null
  const mockServer = {
    tool: vi.fn((_name: string, _desc: string, _schema: any, lambda: any) => {
      resolver = lambda
    }),
  }
  const mockZ = {
    string: () => ({ describe: () => ({}), optional: () => ({ describe: () => ({}) }), max: () => ({ optional: () => ({ describe: () => ({}) }) }) }),
    enum: () => ({ describe: () => ({}) }),
    array: () => ({ optional: () => ({ describe: () => ({}) }) }),
  }
  let optedInSet: Set<string>
  let sessionCwds: Map<string, string>

  beforeEach(() => {
    resolver = null
    mockServer.tool.mockClear()
    runCodexStreaming.mockReset()
    readCodexAuthStatus.mockReset()
    readCodexAuthStatus.mockResolvedValue({
      installed: true, version: '0.125.0', authMode: 'chatgpt',
      planType: 'plus', hasOpenAiApiKeyEnv: false,
    })
    optedInSet = new Set<string>(['bound-sid', 'arg-sid'])
    sessionCwds = new Map<string, string>()
  })

  it('prefers the transport-bound sessionId over the LLM-supplied arg', async () => {
    registerCodexReviewTool(
      mockServer,
      mockZ,
      () => optedInSet,
      (sid: string) => sessionCwds.get(sid) ?? null,
      () => 'bound-sid',
    )
    expect(resolver).not.toBeNull()
    runCodexStreaming.mockImplementation(async () => ({
      code: -1, stderr: '', timedOut: true,  // bail early; we only care about which sid ran the ACL.
    }))
    // LLM passes a DIFFERENT sid -- bound should win, ACL passes against bound.
    const out = await resolver!({ cccSessionId: 'arg-sid', mode: 'paths', paths: ['x'] })
    // ACL passed (bound-sid in set) so we got past it; failure is the
    // mocked timeout from runCodexStreaming, NOT "not enabled for arg-sid".
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('timed out')
    expect(out.content[0].text).not.toContain('not enabled')
  })

  it('falls back to the LLM-supplied arg when no sessionId is bound', async () => {
    registerCodexReviewTool(
      mockServer,
      mockZ,
      () => optedInSet,
      (sid: string) => sessionCwds.get(sid) ?? null,
      () => null,  // no transport binding -- legacy/in-flight connection
    )
    expect(resolver).not.toBeNull()
    runCodexStreaming.mockImplementation(async () => ({
      code: -1, stderr: '', timedOut: true,
    }))
    const out = await resolver!({ cccSessionId: 'arg-sid', mode: 'paths', paths: ['x'] })
    // Arg sid is in the opted-in set so ACL passes; failure is the mocked
    // timeout (proves we got past ACL with the arg-supplied sid).
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('timed out')
    expect(out.content[0].text).not.toContain('not enabled')
  })

  it('returns "no CCC session id bound" when neither bound nor arg sid is present', async () => {
    registerCodexReviewTool(
      mockServer,
      mockZ,
      () => optedInSet,
      (sid: string) => sessionCwds.get(sid) ?? null,
      () => null,
    )
    expect(resolver).not.toBeNull()
    const out = await resolver!({ mode: 'paths', paths: ['x'] })
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('no CCC session id bound')
    expect(runCodexStreaming).not.toHaveBeenCalled()
  })

  it('uses default null-returning getBoundSessionId when caller omits it (back-compat)', async () => {
    registerCodexReviewTool(
      mockServer,
      mockZ,
      () => optedInSet,
      (sid: string) => sessionCwds.get(sid) ?? null,
      // getBoundSessionId omitted -- default returns null
    )
    expect(resolver).not.toBeNull()
    runCodexStreaming.mockImplementation(async () => ({
      code: -1, stderr: '', timedOut: true,
    }))
    const out = await resolver!({ cccSessionId: 'arg-sid', mode: 'paths', paths: ['x'] })
    expect(out.isError).toBe(true)
    expect(out.content[0].text).toContain('timed out')
  })
})
