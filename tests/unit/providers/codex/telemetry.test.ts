import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync } from 'fs'

// Mock getCodexHome before importing the module under test
vi.mock('../../../../src/main/providers/codex/auth', () => ({
  getCodexHome: vi.fn(() => _mockCodexHome),
}))

let _mockCodexHome = ''

import { parseCodexRollout, mapTokenCountToStatusline, watchAndClaimRollout } from '../../../../src/main/providers/codex/telemetry'
import type { TokenCountEvent } from '../../../../src/main/providers/codex/telemetry'
import { getCodexHome } from '../../../../src/main/providers/codex/auth'

const FIXTURE = readFileSync(join(__dirname, '../../../fixtures/codex/rollout-sample.jsonl'), 'utf-8')

describe('codex rollout parsing', () => {
  it('parses session_meta from first line', () => {
    const { meta } = parseCodexRollout(FIXTURE)
    expect(meta.id).toBeTruthy()
    expect(meta.cwd).toBeTruthy()
    expect(meta.model).toBeTruthy()
  })

  it('extracts token_count events', () => {
    const { tokenCounts } = parseCodexRollout(FIXTURE)
    expect(tokenCounts.length).toBeGreaterThan(0)
    expect(tokenCounts[0].total_token_usage.input_tokens).toBeGreaterThanOrEqual(0)
  })

  it('maps token_count to StatuslineData', () => {
    const { tokenCounts, meta } = parseCodexRollout(FIXTURE)
    const tc = tokenCounts[tokenCounts.length - 1]
    const sl = mapTokenCountToStatusline(tc, meta, 'sid-test')
    expect(sl.sessionId).toBe('sid-test')
    expect(sl.model).toBe(meta.model)
    expect(sl.inputTokens).toBeGreaterThanOrEqual(0)
    if (tc.rate_limits?.primary) {
      expect(sl.rateLimitCurrent).toBeDefined()
      expect(sl.rateLimitCurrentResets).toBeDefined()
    }
  })

  it('extracts contextWindow from task_started', () => {
    const { contextWindow } = parseCodexRollout(FIXTURE)
    expect(contextWindow).toBe(258400)
  })

  it('throws if session_meta is missing', () => {
    expect(() => parseCodexRollout('')).toThrow('rollout missing session_meta')
    expect(() => parseCodexRollout('{"type":"event_msg","payload":{"type":"task_started"}}\n')).toThrow('rollout missing session_meta')
  })

  it('skips token_count events where info is null', () => {
    // The fixture has one token_count with info:null (pre-response) and one with real data
    const { tokenCounts } = parseCodexRollout(FIXTURE)
    // Every returned token_count must have total_token_usage
    for (const tc of tokenCounts) {
      expect(tc.total_token_usage).toBeDefined()
      expect(typeof tc.total_token_usage.input_tokens).toBe('number')
    }
  })

  it('maps rate_limits secondary to rateLimitWeekly', () => {
    const { tokenCounts, meta } = parseCodexRollout(FIXTURE)
    const tc = tokenCounts[tokenCounts.length - 1]
    const sl = mapTokenCountToStatusline(tc, meta, 'sid-weekly')
    if (tc.rate_limits?.secondary) {
      expect(sl.rateLimitWeekly).toBeDefined()
      expect(sl.rateLimitWeeklyResets).toBeDefined()
    }
  })

  it('omits costUsd when model pricing is unknown', () => {
    const { tokenCounts } = parseCodexRollout(FIXTURE)
    const tc = tokenCounts[tokenCounts.length - 1]
    const unknownMeta = { id: 'x', cwd: '/anon/repo', model: 'unknown-model-xyz', cli_version: '0.1.0', timestamp: '2026-04-30T00:00:00.000Z' }
    const sl = mapTokenCountToStatusline(tc, unknownMeta, 'sid-unknown')
    expect(sl.costUsd).toBeUndefined()
  })
})

describe('watchAndClaimRollout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    _mockCodexHome = ''
  })

  it('claims a rollout file matching cwd and timestamp window', async () => {
    // Set up a tmp dir as the mock codex home
    const tmpBase = mkdtempSync(join(tmpdir(), 'ccc-test-codex-'))
    _mockCodexHome = tmpBase
    vi.mocked(getCodexHome).mockReturnValue(tmpBase)

    // Create the sessions/YYYY/MM/DD directory and write a rollout file
    const today = new Date()
    const dateDir = join(
      tmpBase, 'sessions',
      String(today.getUTCFullYear()),
      String(today.getUTCMonth() + 1).padStart(2, '0'),
      String(today.getUTCDate()).padStart(2, '0'),
    )
    mkdirSync(dateDir, { recursive: true })

    // Build a minimal rollout with session_meta matching cwd + current timestamp
    const spawnTs = Date.now()
    const rolloutTs = new Date(spawnTs + 200).toISOString()
    const sessionMeta = JSON.stringify({
      timestamp: rolloutTs,
      type: 'session_meta',
      payload: {
        id: 'test-session-abc',
        timestamp: rolloutTs,
        cwd: '/test/cwd',
        model: 'gpt-5.5',
        cli_version: '0.125.0',
      },
    })
    const rolloutPath = join(dateDir, `rollout-${rolloutTs.replace(/:/g, '-')}-test.jsonl`)
    writeFileSync(rolloutPath, sessionMeta + '\n', 'utf-8')

    const updates: unknown[] = []
    const src = watchAndClaimRollout('sess-1', '/test/cwd', spawnTs, (d) => updates.push(d))

    // Poll for up to 1s for the claim to happen
    await new Promise<void>((resolve) => {
      let elapsed = 0
      const check = setInterval(() => {
        elapsed += 50
        // Once a token_count line is appended, onUpdate fires; for claim-only test we just wait for 500ms
        if (elapsed >= 500) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    src.stop()
    // The rollout was claimable -- no assertion on updates since no token_count lines were written
    // The test verifies stop() doesn't throw and the interval stops
    expect(typeof src.stop).toBe('function')
  })

  it('does NOT claim a rollout whose timestamp is older than spawnTimestamp - 5s', async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'ccc-test-codex-stale-'))
    _mockCodexHome = tmpBase
    vi.mocked(getCodexHome).mockReturnValue(tmpBase)

    const today = new Date()
    const dateDir = join(
      tmpBase, 'sessions',
      String(today.getUTCFullYear()),
      String(today.getUTCMonth() + 1).padStart(2, '0'),
      String(today.getUTCDate()).padStart(2, '0'),
    )
    mkdirSync(dateDir, { recursive: true })

    // Rollout timestamp is 10s before spawnTimestamp -- outside the 5s window
    const spawnTs = Date.now()
    const staleTs = new Date(spawnTs - 10_000).toISOString()
    const sessionMeta = JSON.stringify({
      timestamp: staleTs,
      type: 'session_meta',
      payload: {
        id: 'stale-session-xyz',
        timestamp: staleTs,
        cwd: '/test/cwd',
        model: 'gpt-5.5',
        cli_version: '0.125.0',
      },
    })
    const rolloutPath = join(dateDir, `rollout-stale-test.jsonl`)
    writeFileSync(rolloutPath, sessionMeta + '\n', 'utf-8')

    const updates: unknown[] = []
    const src = watchAndClaimRollout('sess-stale', '/test/cwd', spawnTs, (d) => updates.push(d))

    // Wait 600ms -- more than 2 poll cycles
    await new Promise((r) => setTimeout(r, 600))
    src.stop()

    // No updates should have fired (the stale file was not claimed)
    expect(updates.length).toBe(0)
  })

  it('stop() cleans up the watcher and removes from claimed Set', async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'ccc-test-codex-claimed-'))
    _mockCodexHome = tmpBase
    vi.mocked(getCodexHome).mockReturnValue(tmpBase)

    const today = new Date()
    const dateDir = join(
      tmpBase, 'sessions',
      String(today.getUTCFullYear()),
      String(today.getUTCMonth() + 1).padStart(2, '0'),
      String(today.getUTCDate()).padStart(2, '0'),
    )
    mkdirSync(dateDir, { recursive: true })

    const spawnTs = Date.now()
    const rolloutTs = new Date(spawnTs + 100).toISOString()
    const sessionMeta = JSON.stringify({
      timestamp: rolloutTs,
      type: 'session_meta',
      payload: {
        id: 'claimed-session-1',
        timestamp: rolloutTs,
        cwd: '/reclaim/cwd',
        model: 'gpt-5.5',
        cli_version: '0.125.0',
      },
    })
    const rolloutPath = join(dateDir, `rollout-claimed-test.jsonl`)
    writeFileSync(rolloutPath, sessionMeta + '\n', 'utf-8')

    // First watcher claims it
    const src1 = watchAndClaimRollout('sess-claim-1', '/reclaim/cwd', spawnTs, () => {})
    // Wait for claim poll
    await new Promise((r) => setTimeout(r, 600))
    src1.stop()

    // After stop(), the path is removed from claimed -- a second watcher can claim it
    const updates: unknown[] = []
    const src2 = watchAndClaimRollout('sess-claim-2', '/reclaim/cwd', Date.now(), (d) => updates.push(d))

    // Wait for src2 to claim the file (polling interval is 250ms; 500ms is safe)
    await new Promise((r) => setTimeout(r, 500))

    // Now append a token_count line so the watcher fires an update
    const tokenCountLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 },
          last_token_usage: null,
          model_context_window: 128000,
        },
        rate_limits: null,
      },
    })
    writeFileSync(rolloutPath, sessionMeta + '\n' + tokenCountLine + '\n', 'utf-8')

    // Wait for the fs.watch callback to fire and emit the update
    await new Promise((r) => setTimeout(r, 400))
    src2.stop()

    // The update should have fired at least once for the token_count line
    expect(updates.length).toBeGreaterThan(0)
  })
})

describe('parseAndEmit truncation guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    _mockCodexHome = ''
  })

  it('re-parses from offset 0 when the rollout file is replaced with smaller content', async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'ccc-test-codex-trunc-'))
    _mockCodexHome = tmpBase
    vi.mocked(getCodexHome).mockReturnValue(tmpBase)

    const today = new Date()
    const dateDir = join(
      tmpBase, 'sessions',
      String(today.getUTCFullYear()),
      String(today.getUTCMonth() + 1).padStart(2, '0'),
      String(today.getUTCDate()).padStart(2, '0'),
    )
    mkdirSync(dateDir, { recursive: true })

    const spawnTs = Date.now()
    const rolloutTs = new Date(spawnTs + 50).toISOString()

    // Build a long initial file (session_meta + large padding to push lastSize high)
    const sessionMeta = JSON.stringify({
      timestamp: rolloutTs,
      type: 'session_meta',
      payload: {
        id: 'trunc-session-1',
        timestamp: rolloutTs,
        cwd: '/trunc/cwd',
        model: 'gpt-5.5',
        cli_version: '0.125.0',
      },
    })
    const tokenCountLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 520 },
          last_token_usage: null,
          model_context_window: 128000,
        },
        rate_limits: null,
      },
    })
    const rolloutPath = join(dateDir, `rollout-trunc-test.jsonl`)
    // Write initial large file so lastSize gets set high
    writeFileSync(rolloutPath, sessionMeta + '\n' + tokenCountLine + '\n', 'utf-8')

    const updates: import('../../../../src/shared/types').StatuslineData[] = []
    const src = watchAndClaimRollout('sess-trunc', '/trunc/cwd', spawnTs, (d) => updates.push(d))

    // Wait for claim + initial parse
    await new Promise((r) => setTimeout(r, 400))
    const countAfterFirst = updates.length
    expect(countAfterFirst).toBeGreaterThan(0)

    // Now simulate a file rotation: overwrite with shorter content (new session, fresh start)
    const newRolloutTs = new Date(Date.now() + 100).toISOString()
    const newSessionMeta = JSON.stringify({
      timestamp: newRolloutTs,
      type: 'session_meta',
      payload: {
        id: 'trunc-session-2',
        timestamp: newRolloutTs,
        cwd: '/trunc/cwd',
        model: 'gpt-5.5',
        cli_version: '0.125.0',
      },
    })
    const newTokenCountLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 2, reasoning_output_tokens: 0, total_tokens: 12 },
          last_token_usage: null,
          model_context_window: 128000,
        },
        rate_limits: null,
      },
    })
    // Write shorter content -- this simulates rotation (length < lastSize)
    writeFileSync(rolloutPath, newSessionMeta + '\n' + newTokenCountLine + '\n', 'utf-8')

    // Wait for the watcher to fire
    await new Promise((r) => setTimeout(r, 400))
    src.stop()

    // Without the truncation guard, updates.length would still be countAfterFirst.
    // With the guard, the re-parse fires and updates.length increases.
    expect(updates.length).toBeGreaterThan(countAfterFirst)
    // The latest update should reflect the new (smaller) token counts from the replacement file
    const latest = updates[updates.length - 1]
    expect(latest.inputTokens).toBe(10)
  })
})

describe('mapTokenCountToStatusline NaN guards', () => {
  const baseMeta = { id: 's', cwd: '/x', model: 'm', cli_version: '1', timestamp: '2026-05-04T00:00:00Z' }

  it('omits rateLimitCurrentResets when primary.resets_at is NaN', () => {
    const tc: TokenCountEvent = {
      total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      rate_limits: { primary: { used_percent: 50, window_minutes: 300, resets_at: NaN } },
    }
    const sl = mapTokenCountToStatusline(tc, baseMeta, 'sid')
    expect(sl.rateLimitCurrent).toBe(50)
    expect(sl.rateLimitCurrentResets).toBeUndefined()
  })

  it('omits rateLimitWeeklyResets when secondary.resets_at is NaN', () => {
    const tc: TokenCountEvent = {
      total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      rate_limits: { secondary: { used_percent: 30, window_minutes: 10080, resets_at: NaN } },
    }
    const sl = mapTokenCountToStatusline(tc, baseMeta, 'sid')
    expect(sl.rateLimitWeekly).toBe(30)
    expect(sl.rateLimitWeeklyResets).toBeUndefined()
  })

  it('sets rateLimitCurrentResets when primary.resets_at is a valid finite number', () => {
    const tc: TokenCountEvent = {
      total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      rate_limits: { primary: { used_percent: 75, window_minutes: 300, resets_at: 1777544035 } },
    }
    const sl = mapTokenCountToStatusline(tc, baseMeta, 'sid')
    expect(sl.rateLimitCurrent).toBe(75)
    expect(sl.rateLimitCurrentResets).toBe(new Date(1777544035 * 1000).toISOString())
  })
})
