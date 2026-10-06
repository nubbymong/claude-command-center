/**
 * WP2: the review tools (codex_review, claude_review) are offered only while
 * the reviewing provider is on (commit 5b), but a call can arrive after it
 * was switched off -- an agent that saw the tool earlier. Main refuses it at
 * RUN time, through the one launch rule, before anything is done for it: no
 * diff, no account prepared or leased, no reviewer CLI.
 *
 * The REAL review tool and the REAL launch gate; the accounts service's
 * answer is scripted (its rule is proven against real settings in
 * provider-launch-gate.test.ts). The reviewer and the diff are injected
 * fakes, so nothing runs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../../../src/main/codex-review-usage', () => ({ recordReview: vi.fn() }))
const acct = vi.hoisted(() => ({ state: { claude: 'on', codex: 'on' } as Record<string, 'on' | 'off' | 'unreadable'> }))
vi.mock('../../../src/main/provider-accounts', () => ({
  getAccountsService: () => ({
    launchRefusal: (id: string) => {
      const name = id === 'claude' ? 'Claude Code' : 'Codex'
      if (acct.state[id] === 'off') return { code: 'provider-off', providerId: id, message: `${name} is off. Turn it on in Settings, Accounts.` }
      if (acct.state[id] === 'unreadable') return { code: 'provider-state-unknown', providerId: id, message: `This app could not read whether ${name} is on. Check Settings, Accounts.` }
      return null
    },
  }),
}))

const { runCodexReview, runClaudeReview } = await import('../../../src/main/codex-review-mcp-tool')

const optedIn = new Set(['sess-allowed'])
const release = vi.fn()
const prepareLaunch = vi.fn(async () => ({
  ok: true, lease: { release }, binding: { providerAccountId: 'acct-1', authRealmId: 'realm-1' }, realmOnly: false, reviewer: 'reviewer-default',
  home: 'C:/res/r1', executable: 'C:/proven/reviewer.exe', env: { PATH: '/usr/bin' }, sessionsDir: 'C:/res/r1/sessions',
}))
const run = vi.fn(async () => ({ ok: true, text: '1. A finding.\n', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }))
const diff = vi.fn(async () => ({ ok: true, diff: 'diff --git a/x b/x\n+y\n' }))
// No launchRefusal here: the real rule (provider-launch-gate.ts) is asked.
const deps = () => ({ accounts: () => ({ prepareLaunch }) as never, reviewer: () => ({ run }) as never, diff: diff as never })

let gitCwd = ''
beforeEach(() => {
  gitCwd = mkdtempSync(join(tmpdir(), 'ccc-review-off-'))
  mkdirSync(join(gitCwd, '.git'))
  acct.state = { claude: 'on', codex: 'on' }
  prepareLaunch.mockClear()
  run.mockClear()
  diff.mockClear()
  release.mockClear()
})
afterEach(() => { rmSync(gitCwd, { recursive: true, force: true }) })

const nothingDone = () => {
  expect(diff).not.toHaveBeenCalled()
  expect(prepareLaunch).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
}

describe('a review asked for after its reviewer was switched off', () => {
  it('codex_review while Codex is off: refused in plain words, and nothing is done', async () => {
    acct.state.codex = 'off'
    const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, deps())
    expect(r).toEqual({ isError: true, text: 'Codex review is unavailable. Codex is off. Turn it on in Settings, Accounts.' })
    nothingDone()
  })

  it('claude_review while Claude Code is off: refused the same way', async () => {
    acct.state.claude = 'off'
    const r = await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, deps())
    expect(r).toEqual({ isError: true, text: 'Claude review is unavailable. Claude Code is off. Turn it on in Settings, Accounts.' })
    nothingDone()
  })

  it('a setting that cannot be read refuses (fail closed)', async () => {
    acct.state.codex = 'unreadable'
    const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, deps())
    expect(r.isError).toBe(true)
    expect(r.text).toBe('Codex review is unavailable. This app could not read whether Codex is on. Check Settings, Accounts.')
    nothingDone()
  })

  it('only the REVIEWING provider matters: Claude Code off does not stop codex_review', async () => {
    acct.state.claude = 'off'
    const r = await runCodexReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, deps())
    expect(r.isError).toBe(false)
    expect(prepareLaunch).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('with the reviewer on, claude_review runs as before', async () => {
    const r = await runClaudeReview({ cccSessionId: 'sess-allowed', mode: 'working' }, optedIn, gitCwd, deps())
    expect(r.isError).toBe(false)
    expect(diff).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledTimes(1)
  })
})
