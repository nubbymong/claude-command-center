import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
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

import { runCodexReview } from '../../../src/main/codex-review-mcp-tool'

const optedIn = new Set<string>(['sess-allowed'])

describe('codex_review tool', () => {
  beforeEach(() => {
    testResourcesDir = mkdtempSync(join(tmpdir(), 'ccc-codex-review-tool-'))
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
      optedIn, '/some/repo/cwd',
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
    expect(capturedArgs).toContain('--ask-for-approval')
    expect(capturedArgs).toContain('never')
    expect(capturedArgs).toContain('--sandbox')
    expect(capturedArgs).toContain('read-only')
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
      optedIn, '/some/repo',
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
      optedIn, '/fake/cwd',
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
      optedIn, '/fake/cwd',
    )
    expect(result.isError).toBe(true)
    expect(result.text).toContain('Codex review failed (exit 2)')
    expect(result.text).toContain('rate-limit window exhausted')
  })
})
