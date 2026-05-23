import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock saveData so applyAttributionPayload doesn't touch real disk.
vi.mock('../../src/main/tokenomics-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/tokenomics-manager')>()
  return { ...actual, saveData: vi.fn() }
})

describe('account attribution wizard integration', () => {
  let sandbox: string
  let originalHome: string | undefined
  let originalUserProfile: string | undefined

  beforeEach(async () => {
    sandbox = mkdtempSync(join(tmpdir(), 'attr-int-'))
    originalHome = process.env.HOME
    originalUserProfile = process.env.USERPROFILE
    process.env.USERPROFILE = sandbox
    process.env.HOME = sandbox
    mkdirSync(join(sandbox, '.claude', 'backups'), { recursive: true })
    writeFileSync(
      join(sandbox, '.claude', 'backups', '.claude.json.backup.1000'),
      JSON.stringify({ oauthAccount: { emailAddress: 'a@x.com' } }),
    )
    writeFileSync(
      join(sandbox, '.claude', 'backups', '.claude.json.backup.5000'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@x.com' } }),
    )
    writeFileSync(
      join(sandbox, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@x.com' } }),
    )
  })

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    rmSync(sandbox, { recursive: true, force: true })
  })

  function makeRecord(overrides: any): any {
    return {
      sessionId: '',
      projectDir: '/p',
      model: 'sonnet',
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheWriteTokens: 0,
      totalCostUsd: 0,
      messageCount: 0,
      firstTimestamp: '2026-01-01T00:00:00Z',
      lastTimestamp: '2026-01-01T00:00:00Z',
      ...overrides,
    }
  }

  it('lists unattributed groups with suggestions from the timeline', async () => {
    const tk = await import('../../src/main/tokenomics-manager')
    const attr = await import('../../src/main/account-attribution')
    tk.__resetTokenomicsForTests()
    tk.__seedTokenomicsForTests([
      makeRecord({ sessionId: 's-old', totalCostUsd: 1, lastTimestamp: new Date(1500).toISOString() }),
      makeRecord({ sessionId: 's-new', totalCostUsd: 2, lastTimestamp: new Date(5500).toISOString() }),
    ])
    const timeline = attr.buildAccountTimeline()
    const groups = tk.listUnattributedGroups(timeline)
    expect(groups.length).toBeGreaterThan(0)
  })

  it('attribute -> re-list shows zero remaining', async () => {
    const tk = await import('../../src/main/tokenomics-manager')
    const attr = await import('../../src/main/account-attribution')
    tk.__resetTokenomicsForTests()
    tk.__seedTokenomicsForTests([
      makeRecord({ sessionId: 's-old', totalCostUsd: 1, lastTimestamp: new Date(1500).toISOString() }),
    ])
    tk.applyAttributionPayload({ sessionIds: ['s-old'], assignment: { type: 'email', email: 'a@x.com' } })
    const groups = tk.listUnattributedGroups(attr.buildAccountTimeline())
    expect(groups).toEqual([])
  })

  it('mark mixed flips attributionMixed = true', async () => {
    const tk = await import('../../src/main/tokenomics-manager')
    tk.__resetTokenomicsForTests()
    tk.__seedTokenomicsForTests([makeRecord({ sessionId: 's1' })])
    tk.applyAttributionPayload({ sessionIds: ['s1'], assignment: { type: 'mixed' } })
    expect(tk.__seedTokenomicsForTests.read().sessions.s1.attributionMixed).toBe(true)
  })

  // Copilot review on PR #31 (p9.14): a config's sessions can span
  // multiple timeline intervals. Pre-fix code set suggestedEmail =
  // iv.email per session, so the FINAL Object.entries iteration won --
  // any ordering reshuffle (Node version, V8 internals) would flip the
  // result. The fix tallies votes per email per group and picks the
  // majority (alphabetical tie-break). This test pins the deterministic
  // outcome for a 2-of-3 majority.
  it('suggestedEmail is the majority vote when sessions span multiple intervals', async () => {
    const tk = await import('../../src/main/tokenomics-manager')
    const attr = await import('../../src/main/account-attribution')
    tk.__resetTokenomicsForTests()
    tk.__seedTokenomicsForTests([
      // 2 sessions in [1000, 5000) -> a@x.com
      makeRecord({ sessionId: 's-old1', configId: 'cfg', totalCostUsd: 1, lastTimestamp: new Date(1500).toISOString() }),
      makeRecord({ sessionId: 's-old2', configId: 'cfg', totalCostUsd: 1, lastTimestamp: new Date(2500).toISOString() }),
      // 1 session in [5000, Inf) -> b@x.com
      makeRecord({ sessionId: 's-new', configId: 'cfg', totalCostUsd: 1, lastTimestamp: new Date(5500).toISOString() }),
    ])
    const groups = tk.listUnattributedGroups(attr.buildAccountTimeline())
    const cfg = groups.find(g => g.groupId === 'cfg')
    expect(cfg).toBeDefined()
    expect(cfg!.suggestedEmail).toBe('a@x.com') // 2 votes vs 1
  })
})
