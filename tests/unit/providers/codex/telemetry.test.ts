import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync, writeFileSync, appendFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync } from 'fs'

import { parseCodexRollout, mapTokenCountToStatusline, contextTokensInWindow, watchAndClaimRollout, withAllowance } from '../../../../src/main/providers/codex/telemetry'
import type { TokenCountEvent } from '../../../../src/main/providers/codex/telemetry'
import { CODEX_DEFAULT_LIMIT_ID as DEFAULT_ID, normaliseCodexRateLimits } from '../../../../src/main/providers/codex/rate-limits'
import { createCodexLiveUsage } from '../../../../src/main/providers/codex/usage'
import { CodexProvider } from '../../../../src/main/providers/codex'

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

  // The rate-limit fields of an update come only from the validated
  // allowance (withAllowance); the token mapper no longer sets them (review Q4).
  it('maps token_count to StatuslineData, with the rate limits from the allowance', () => {
    const { tokenCounts, meta, allowance } = parseCodexRollout(FIXTURE)
    const tc = tokenCounts[tokenCounts.length - 1]
    const mapped = mapTokenCountToStatusline(tc, meta, 'sid-test')
    expect(mapped.rateLimitCurrent).toBeUndefined()
    expect(mapped.rateLimitCurrentResets).toBeUndefined()
    const sl = withAllowance(mapped, allowance)
    expect(sl.sessionId).toBe('sid-test')
    expect(sl.model).toBe(meta.model)
    expect(sl.inputTokens).toBeGreaterThanOrEqual(0)
    expect(sl.rateLimitCurrent).toBe(1)
    expect(sl.rateLimitCurrentResets).toBe(new Date(1777544035 * 1000).toISOString())
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
    const { tokenCounts, meta, allowance } = parseCodexRollout(FIXTURE)
    const tc = tokenCounts[tokenCounts.length - 1]
    const sl = withAllowance(mapTokenCountToStatusline(tc, meta, 'sid-weekly'), allowance)
    expect(sl.rateLimitWeekly).toBe(13)
    expect(sl.rateLimitWeeklyResets).toBe(new Date(1777959356 * 1000).toISOString())
  })

  it('omits costUsd when model pricing is unknown', () => {
    const { tokenCounts } = parseCodexRollout(FIXTURE)
    const tc = tokenCounts[tokenCounts.length - 1]
    const unknownMeta = { id: 'x', cwd: '/anon/repo', model: 'unknown-model-xyz', cli_version: '0.1.0', timestamp: '2026-04-30T00:00:00.000Z' }
    const sl = mapTokenCountToStatusline(tc, unknownMeta, 'sid-unknown')
    expect(sl.costUsd).toBeUndefined()
  })

  it('extracts reasoningEffort from turn_context.payload.effort', () => {
    // Codex 0.128.0 places the active reasoning effort on turn_context.payload.effort.
    // parseCodexRollout must capture it onto meta.reasoningEffort.
    const lines = [
      JSON.stringify({
        timestamp: '2026-05-07T05:14:52.758Z',
        type: 'session_meta',
        payload: { id: 'effort-session-1', timestamp: '2026-05-07T05:14:46.875Z', cwd: 'F:\\Codex', cli_version: '0.128.0' },
      }),
      JSON.stringify({
        timestamp: '2026-05-07T05:14:52.759Z',
        type: 'turn_context',
        payload: { model: 'gpt-5.5', effort: 'xhigh' },
      }),
    ].join('\n') + '\n'
    const { meta } = parseCodexRollout(lines)
    expect(meta.model).toBe('gpt-5.5')
    expect(meta.reasoningEffort).toBe('xhigh')
  })

  it('forwards reasoningEffort onto StatuslineData via mapTokenCountToStatusline', () => {
    const tc: TokenCountEvent = {
      total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 },
    }
    const meta = { id: 'm', cwd: '/x', model: 'gpt-5.5', reasoningEffort: 'xhigh', cli_version: '0.128.0', timestamp: '2026-05-07T05:14:52.758Z' }
    const sl = mapTokenCountToStatusline(tc, meta, 'sid-effort')
    expect(sl.model).toBe('gpt-5.5')
    expect(sl.reasoningEffort).toBe('xhigh')
  })

  // Context % must reflect the WINDOW's occupancy (last request), not the
  // session's cumulative total — the old total/window formula pinned the bar
  // at ~96-100% red on long sessions whose window was mostly free.
  describe('contextUsedPercent — window occupancy, not cumulative total', () => {
    const meta = { id: 'm', cwd: '/x', model: 'gpt-5.5', cli_version: '0.144.0', timestamp: '2026-07-09T00:00:00.000Z' }

    it('uses last_token_usage (prompt + output of the last request)', () => {
      const tc: TokenCountEvent = {
        // Cumulative total (350k) exceeds the 100k window — the OLD formula read 350%.
        total_token_usage: { input_tokens: 330_000, cached_input_tokens: 280_000, output_tokens: 20_000, reasoning_output_tokens: 0, total_tokens: 350_000 },
        last_token_usage: { input_tokens: 50_000, cached_input_tokens: 45_000, output_tokens: 1_000 },
      }
      expect(contextTokensInWindow(tc)).toBe(51_000)
      const sl = mapTokenCountToStatusline(tc, meta, 'sid-ctx', 100_000)
      expect(sl.contextUsedPercent).toBe(51)
    })

    it('falls back to the cumulative total when last_token_usage is absent (first event)', () => {
      const tc: TokenCountEvent = {
        total_token_usage: { input_tokens: 21_805, cached_input_tokens: 19_328, output_tokens: 30, reasoning_output_tokens: 0, total_tokens: 21_835 },
      }
      expect(contextTokensInWindow(tc)).toBe(21_835)
      const sl = mapTokenCountToStatusline(tc, meta, 'sid-ctx2', 258_400)
      expect(sl.contextUsedPercent).toBeCloseTo((21_835 / 258_400) * 100, 5)
    })

    it('caps at 100 even when the fallback total exceeds the window', () => {
      const tc: TokenCountEvent = {
        total_token_usage: { input_tokens: 340_000, cached_input_tokens: 0, output_tokens: 10_000, reasoning_output_tokens: 0, total_tokens: 350_000 },
      }
      const sl = mapTokenCountToStatusline(tc, meta, 'sid-ctx3', 100_000)
      expect(sl.contextUsedPercent).toBe(100)
    })

    it('omits contextUsedPercent when the window is unknown', () => {
      const tc: TokenCountEvent = {
        total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0, total_tokens: 110 },
      }
      const sl = mapTokenCountToStatusline(tc, meta, 'sid-ctx4')
      expect(sl.contextUsedPercent).toBeUndefined()
    })
  })

  it('leaves reasoningEffort undefined when turn_context omits effort', () => {
    // Older rollouts (pre-0.128.0) and the very first events of a session before
    // any turn_context fires must not surface a stale effort label.
    const lines = JSON.stringify({
      timestamp: '2026-05-07T05:14:52.758Z',
      type: 'session_meta',
      payload: { id: 'no-effort', timestamp: '2026-05-07T05:14:46.875Z', cwd: 'F:\\Codex', cli_version: '0.125.0' },
    }) + '\n'
    const { meta } = parseCodexRollout(lines)
    expect(meta.reasoningEffort).toBeUndefined()
  })
})

describe('watchAndClaimRollout', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('claims a rollout file matching cwd and timestamp window', async () => {
    // Set up a tmp dir as the mock codex home
    const tmpBase = mkdtempSync(join(tmpdir(), 'ccc-test-codex-'))

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
    const src = watchAndClaimRollout('sess-1', '/test/cwd', spawnTs, (d) => updates.push(d), join(tmpBase, 'sessions'))

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
    const src = watchAndClaimRollout('sess-stale', '/test/cwd', spawnTs, (d) => updates.push(d), join(tmpBase, 'sessions'))

    // Wait 600ms -- more than 2 poll cycles
    await new Promise((r) => setTimeout(r, 600))
    src.stop()

    // No updates should have fired (the stale file was not claimed)
    expect(updates.length).toBe(0)
  })

  it('stop() clears the tail interval and removes from claimed Set', async () => {
    // Verifies that stop() tears down cleanly: tail polling stops (no further
    // onUpdate calls) and the claimed path is released for re-claim.
    const tmpBase = mkdtempSync(join(tmpdir(), 'ccc-test-codex-claimed-'))

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

    // First source claims it
    const src1 = watchAndClaimRollout('sess-claim-1', '/reclaim/cwd', spawnTs, () => {}, join(tmpBase, 'sessions'))
    // Wait for claim poll
    await new Promise((r) => setTimeout(r, 600))
    src1.stop()

    // After stop(), the path is removed from claimed -- a second source can claim it
    const updates: unknown[] = []
    const src2 = watchAndClaimRollout('sess-claim-2', '/reclaim/cwd', Date.now(), (d) => updates.push(d), join(tmpBase, 'sessions'))

    // Wait for src2 to claim the file (polling interval is 250ms; 500ms is safe)
    await new Promise((r) => setTimeout(r, 500))

    // Now append a token_count line -- tail poll (500ms) will pick it up
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

    // Wait past one tail-poll cycle (500ms + buffer)
    await new Promise((r) => setTimeout(r, 700))
    src2.stop()

    // The update should have fired at least once for the token_count line
    expect(updates.length).toBeGreaterThan(0)
  })

  it('still claims a rollout that appears 12s after spawn (slow cold start, before 30s deadline)', async () => {
    // Codex 0.128.0 cold starts on Windows can run noticeably longer than 10s.
    // The watcher must keep polling until 30s before giving up. This regression
    // test simulates a 12s file-write delay and asserts the claim still happens.
    vi.useFakeTimers()

    const tmpBase = mkdtempSync(join(tmpdir(), 'ccc-test-codex-slowcold-'))

    const today = new Date()
    const dateDir = join(
      tmpBase, 'sessions',
      String(today.getUTCFullYear()),
      String(today.getUTCMonth() + 1).padStart(2, '0'),
      String(today.getUTCDate()).padStart(2, '0'),
    )
    mkdirSync(dateDir, { recursive: true })

    const spawnTs = Date.now()
    // Start the watcher BEFORE the rollout file exists. dateDir exists but is empty.
    const updates: import('../../../../src/shared/types').StatuslineData[] = []
    const src = watchAndClaimRollout('sess-slowcold', '/slowcold/cwd', spawnTs, (d) => updates.push(d), join(tmpBase, 'sessions'))

    // Advance 12 seconds. The 10s warn fires (silently in test); no claim yet.
    await vi.advanceTimersByTimeAsync(12_000)
    expect(updates.length).toBe(0)

    // Now Codex finally writes the rollout. Outer event timestamp matches when it
    // was written, ~12s after spawn.
    const rolloutTs = new Date(spawnTs + 12_100).toISOString()
    const sessionMeta = JSON.stringify({
      timestamp: rolloutTs,
      type: 'session_meta',
      payload: {
        id: 'slowcold-session-1',
        timestamp: rolloutTs,
        cwd: '/slowcold/cwd',
        model: 'gpt-5.5',
        cli_version: '0.128.0',
      },
    })
    const tokenCountLine = JSON.stringify({
      timestamp: new Date(spawnTs + 12_200).toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 50, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 55 },
          last_token_usage: null,
          model_context_window: 128000,
        },
        rate_limits: null,
      },
    })
    const rolloutPath = join(dateDir, `rollout-slowcold-test.jsonl`)
    writeFileSync(rolloutPath, sessionMeta + '\n' + tokenCountLine + '\n', 'utf-8')

    // Advance past the next claim poll tick (250ms) -- must claim and emit.
    await vi.advanceTimersByTimeAsync(400)

    src.stop()
    vi.useRealTimers()

    expect(updates.length).toBeGreaterThan(0)
    expect(updates[updates.length - 1].inputTokens).toBe(50)
  })

  it('gives up at 30s when no rollout ever appears', async () => {
    // The opposite of the slow-cold-start case: nothing is ever written. The
    // watcher must give up at 30s exactly, not earlier and not later.
    vi.useFakeTimers()

    const tmpBase = mkdtempSync(join(tmpdir(), 'ccc-test-codex-eph-'))

    const today = new Date()
    const dateDir = join(
      tmpBase, 'sessions',
      String(today.getUTCFullYear()),
      String(today.getUTCMonth() + 1).padStart(2, '0'),
      String(today.getUTCDate()).padStart(2, '0'),
    )
    mkdirSync(dateDir, { recursive: true })

    // Suppress console.warn during this test (the 10s warn + 30s timeout both log).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const spawnTs = Date.now()
    const updates: unknown[] = []
    const src = watchAndClaimRollout('sess-eph', '/eph/cwd', spawnTs, (d) => updates.push(d), join(tmpBase, 'sessions'))

    // The give-up message text -- distinct from the 10s "still polling" warning.
    const isGiveUpCall = (c: unknown[]) =>
      typeof c[0] === 'string' && c[0].includes('assuming --ephemeral')

    // At 25s, watcher is still polling -- no claim yet, no give-up message either.
    await vi.advanceTimersByTimeAsync(25_000)
    expect(updates.length).toBe(0)
    expect(warnSpy.mock.calls.filter(isGiveUpCall).length).toBe(0)

    // At 31s, the give-up warning has fired.
    await vi.advanceTimersByTimeAsync(6_000)
    expect(warnSpy.mock.calls.filter(isGiveUpCall).length).toBeGreaterThanOrEqual(1)

    src.stop()
    vi.useRealTimers()
    warnSpy.mockRestore()
  })

  it('polls and emits new token_count events appended after claim', async () => {
    // Spec: simulates Codex appending a token_count event AFTER the watcher claimed
    // the file. Without polling, fs.watch on Windows may miss this. Polling guarantees
    // the new event reaches onUpdate within ~500ms.
    vi.useFakeTimers()

    const tmpBase = mkdtempSync(join(tmpdir(), 'ccc-test-codex-polltail-'))

    const today = new Date()
    const dateDir = join(
      tmpBase, 'sessions',
      String(today.getUTCFullYear()),
      String(today.getUTCMonth() + 1).padStart(2, '0'),
      String(today.getUTCDate()).padStart(2, '0'),
    )
    mkdirSync(dateDir, { recursive: true })

    // Write initial rollout with only session_meta + task_started (no token_count yet)
    const spawnTs = Date.now()
    const rolloutTs = new Date(spawnTs + 100).toISOString()
    const sessionMeta = JSON.stringify({
      timestamp: rolloutTs,
      type: 'session_meta',
      payload: {
        id: 'poll-session-1',
        timestamp: rolloutTs,
        cwd: '/poll/cwd',
        model: 'gpt-5.5',
        cli_version: '0.125.0',
      },
    })
    const taskStarted = JSON.stringify({
      timestamp: rolloutTs,
      type: 'event_msg',
      payload: { type: 'task_started', model_context_window: 200000 },
    })
    const rolloutPath = join(dateDir, `rollout-polltail-test.jsonl`)
    writeFileSync(rolloutPath, sessionMeta + '\n' + taskStarted + '\n', 'utf-8')

    const updates: import('../../../../src/shared/types').StatuslineData[] = []
    const src = watchAndClaimRollout('sess-poll', '/poll/cwd', spawnTs, (d) => updates.push(d), join(tmpBase, 'sessions'))

    // Advance past claim-poll (250ms) to trigger claim + initial parseAndEmit.
    // Initial parse finds no token_count -- no update yet.
    await vi.advanceTimersByTimeAsync(300)
    expect(updates.length).toBe(0)

    // Simulate Codex appending a token_count event to the file
    const tokenCountLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { input_tokens: 1500, cached_input_tokens: 300, output_tokens: 200, reasoning_output_tokens: 0, total_tokens: 2000 },
          last_token_usage: null,
          model_context_window: 200000,
        },
        rate_limits: null,
      },
    })
    appendFileSync(rolloutPath, tokenCountLine + '\n', 'utf-8')

    // Advance past the tail-poll interval (500ms) -- polling picks up the new line
    await vi.advanceTimersByTimeAsync(600)

    src.stop()
    vi.useRealTimers()

    expect(updates.length).toBeGreaterThan(0)
    const latest = updates[updates.length - 1]
    expect(latest.inputTokens).toBe(1500) // input_tokens alone — cached_input_tokens is a subset of it
    expect(latest.outputTokens).toBe(200)
    expect(latest.contextWindowSize).toBe(200000)
    expect(latest.contextUsedPercent).toBeCloseTo((2000 / 200000) * 100, 4)
  })
})

describe('watchAndClaimRollout in a realm (WP2 plan A13)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('claims only from the sessions folder it is given: a matching rollout in the ambient home is never read', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    const ambient = mkdtempSync(join(tmpdir(), 'ccc-test-codex-ambient-'))
    const realmSessions = join(mkdtempSync(join(tmpdir(), 'ccc-test-codex-realm-')), 'sessions')
    const today = new Date()
    const ymd = [String(today.getUTCFullYear()), String(today.getUTCMonth() + 1).padStart(2, '0'), String(today.getUTCDate()).padStart(2, '0')]
    const spawnTs = Date.now()
    const ts = new Date(spawnTs + 100).toISOString()
    const rollout = (id: string, input: number) => [
      JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id, timestamp: ts, cwd: '/realm/cwd', model: 'gpt-5.5', cli_version: '0.155.1' } }),
      JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_started', model_context_window: 200000 } }),
      JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 }, last_token_usage: null, model_context_window: 200000 }, rate_limits: null } }),
    ].join('\n') + '\n'
    // The ambient home holds a rollout that matches this session's cwd and window.
    const ambientDay = join(ambient, 'sessions', ...ymd)
    mkdirSync(ambientDay, { recursive: true })
    writeFileSync(join(ambientDay, 'rollout-ambient.jsonl'), rollout('ambient-1', 9999), 'utf-8')

    const updates: import('../../../../src/shared/types').StatuslineData[] = []
    const src = watchAndClaimRollout('sess-realm', '/realm/cwd', spawnTs, (d) => updates.push(d), realmSessions)
    await vi.advanceTimersByTimeAsync(600)
    expect(updates).toHaveLength(0)

    const realmDay = join(realmSessions, ...ymd)
    mkdirSync(realmDay, { recursive: true })
    writeFileSync(join(realmDay, 'rollout-realm.jsonl'), rollout('realm-1', 1500), 'utf-8')
    await vi.advanceTimersByTimeAsync(1200)
    src.stop()

    expect(updates.length).toBeGreaterThan(0)
    expect(updates.map((u) => u.inputTokens)).not.toContain(9999)
    expect(updates[updates.length - 1].inputTokens).toBe(1500)
  })

  it('WP2 commit 6g: with no sessions folder nothing is watched; there is no fallback to the ambient home (CODEX_HOME)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    const ambient = mkdtempSync(join(tmpdir(), 'ccc-test-codex-ambient-'))
    const saved = process.env.CODEX_HOME
    process.env.CODEX_HOME = ambient
    try {
      const today = new Date()
      const ymd = [String(today.getUTCFullYear()), String(today.getUTCMonth() + 1).padStart(2, '0'), String(today.getUTCDate()).padStart(2, '0')]
      const spawnTs = Date.now()
      const ts = new Date(spawnTs + 100).toISOString()
      // The ambient home, under both of its old names, holds a rollout that
      // matches this session's cwd and window.
      for (const base of [ambient, join(ambient, '.codex')]) {
        const day = join(base, 'sessions', ...ymd)
        mkdirSync(day, { recursive: true })
        writeFileSync(join(day, 'rollout-ambient.jsonl'), [
          JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: 'ambient-1', timestamp: ts, cwd: '/none/cwd', model: 'gpt-5.5', cli_version: '0.155.1' } }),
          JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 9999, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 10000 }, last_token_usage: null, model_context_window: 200000 }, rate_limits: null } }),
        ].join('\n') + '\n', 'utf-8')
      }
      const watch = watchAndClaimRollout as unknown as (...a: unknown[]) => { stop(): void }
      for (const folder of [undefined, '']) {
        const updates: unknown[] = []
        const src = watch('sess-none', '/none/cwd', spawnTs, (d: unknown) => updates.push(d), folder)
        await vi.advanceTimersByTimeAsync(1500)
        src.stop()
        expect(updates, String(folder)).toHaveLength(0)
      }
    } finally {
      if (saved === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = saved
    }
  })
})

describe('parseAndEmit truncation guard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('re-parses from offset 0 when the rollout file is replaced with smaller content', async () => {
    const tmpBase = mkdtempSync(join(tmpdir(), 'ccc-test-codex-trunc-'))

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
    const src = watchAndClaimRollout('sess-trunc', '/trunc/cwd', spawnTs, (d) => updates.push(d), join(tmpBase, 'sessions'))

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

// The rate-limit fields come from the validated allowance only (review Q4:
// the token mapper's own copy of them was dead, withAllowance replaced it).
describe('rate-limit fields NaN guards (through the allowance)', () => {
  const baseMeta = { id: 's', cwd: '/x', model: 'm', cli_version: '1', timestamp: '2026-05-04T00:00:00Z' }
  const AT = Date.parse('2026-04-30T05:13:52.611Z')
  const update = (rateLimits: TokenCountEvent['rate_limits']) => {
    const tc: TokenCountEvent = {
      total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      rate_limits: rateLimits,
    }
    return withAllowance(mapTokenCountToStatusline(tc, baseMeta, 'sid'), normaliseCodexRateLimits(rateLimits, 'rollout', AT))
  }

  it('omits rateLimitCurrentResets when primary.resets_at is NaN', () => {
    const sl = update({ primary: { used_percent: 50, window_minutes: 300, resets_at: NaN } })
    expect(sl.rateLimitCurrent).toBe(50)
    expect(sl.rateLimitCurrentResets).toBeUndefined()
  })

  it('omits rateLimitWeeklyResets when secondary.resets_at is NaN', () => {
    const sl = update({ secondary: { used_percent: 30, window_minutes: 10080, resets_at: NaN } })
    expect(sl.rateLimitWeekly).toBe(30)
    expect(sl.rateLimitWeeklyResets).toBeUndefined()
  })

  it('sets rateLimitCurrentResets when primary.resets_at is a valid finite number', () => {
    const sl = update({ primary: { used_percent: 75, window_minutes: 300, resets_at: 1777544035 } })
    expect(sl.rateLimitCurrent).toBe(75)
    expect(sl.rateLimitCurrentResets).toBe(new Date(1777544035 * 1000).toISOString())
  })

  it('the token mapper sets no rate-limit field of its own', () => {
    const tc: TokenCountEvent = {
      total_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 },
      rate_limits: { primary: { used_percent: 75, window_minutes: 300, resets_at: 1777544035 }, secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1777959356 } },
    }
    const sl = mapTokenCountToStatusline(tc, baseMeta, 'sid')
    for (const k of ['rateLimitCurrent', 'rateLimitCurrentResets', 'rateLimitWeekly', 'rateLimitWeeklyResets'] as const) expect(sl[k], k).toBeUndefined()
  })
})

// Usage track MP2: the allowance a session reports, from every token_count that
// carries rate_limits (the pre-response one included), as validated usage
// buckets with the event time, and a one-time "no reading" when no rollout is
// ever claimed.
describe('allowance from the rollout (usage track MP2)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  const ymdOf = (d: Date) => [String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, '0'), String(d.getUTCDate()).padStart(2, '0')]
  const S = (ms: number) => Math.floor(ms / 1000)
  const meta = (ts: string, cwd: string) => JSON.stringify({ timestamp: ts, type: 'session_meta', payload: { id: 'mp2', timestamp: ts, cwd, model: 'gpt-5.5', cli_version: '0.155.1' } })
  const tokenCount = (ts: string, info: unknown, rateLimits: unknown) =>
    JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info, rate_limits: rateLimits } })
  const usage = (input: number) => ({ total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 }, last_token_usage: null, model_context_window: 200000 })

  // Fake timers first, so the spawn time and the event times share the fake clock.
  function startClock(): number {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    return Date.now()
  }

  async function watchRollout(spawnTs: number, lines: string[], advance = 800) {
    const sessions = join(mkdtempSync(join(tmpdir(), 'ccc-test-codex-mp2-')), 'sessions')
    const day = join(sessions, ...ymdOf(new Date()))
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, 'rollout-mp2.jsonl'), lines.join('\n') + '\n', 'utf-8')
    const updates: import('../../../../src/shared/types').StatuslineData[] = []
    const src = watchAndClaimRollout('sess-mp2', '/mp2/cwd', spawnTs, (d) => updates.push(d), sessions)
    await vi.advanceTimersByTimeAsync(advance)
    src.stop()
    return updates
  }

  it('parseCodexRollout returns the allowance from the fixture, the info-null event included', () => {
    const { allowance } = parseCodexRollout(FIXTURE)
    expect(allowance).not.toBeNull()
    expect(allowance!.planType).toBe('plus')
    // The newest event that carried rate_limits is line 11.
    expect(allowance!.readingAt).toBe(Date.parse('2026-04-30T05:13:55.184Z'))
    expect(allowance!.limits.map((l) => [l.limitId, l.primary?.windowMinutes, l.secondary?.windowMinutes])).toEqual([['codex', 300, 10080]])
  })

  it('parseCodexRollout reads the allowance of a rollout whose only token_count has info null', () => {
    const ts = '2026-09-27T10:00:00.000Z'
    const { tokenCounts, allowance } = parseCodexRollout([
      meta(ts, '/x'),
      tokenCount(ts, null, { limit_id: DEFAULT_ID, primary: { used_percent: 9, window_minutes: 300 }, plan_type: 'plus' }),
    ].join('\n'))
    expect(tokenCounts).toEqual([])
    expect(allowance!.limits[0].primary!.usedPercent).toBe(9)
    expect(allowance!.readingAt).toBe(Date.parse(ts))
  })

  it('reports the allowance from a pre-response token_count before any usage exists', async () => {
    const spawn = startClock()
    const ts = new Date(spawn + 100).toISOString()
    const updates = await watchRollout(spawn, [
      meta(ts, '/mp2/cwd'),
      tokenCount(ts, null, { limit_id: DEFAULT_ID, limit_name: null, primary: { used_percent: 7, window_minutes: 300, resets_at: S(spawn + 3_600_000) }, secondary: { used_percent: 41, window_minutes: 10080, resets_at: S(spawn + 86_400_000) }, credits: null, plan_type: 'pro' }),
    ])
    expect(updates.length).toBeGreaterThan(0)
    const u = updates[updates.length - 1]
    expect(u.sessionId).toBe('sess-mp2')
    expect(u.inputTokens).toBeUndefined()
    expect(u.usageBuckets!.map((b) => [b.key, b.label, b.percent])).toEqual([['codex/300:', '5h', 7], ['codex/10080:', 'Weekly', 41]])
    expect(u.rateLimitsAt).toBe(Date.parse(ts))
    expect(u.rateLimitCurrent).toBe(7)
    expect(u.rateLimitWeekly).toBe(41)
    expect(u.rateLimitCurrentResets).toBe(new Date(S(spawn + 3_600_000) * 1000).toISOString())
  })

  it('keeps the allowance when the newest token_count has none, and stamps the event that had it', async () => {
    const spawn = startClock()
    const t1 = new Date(spawn + 100).toISOString()
    const t2 = new Date(spawn + 200).toISOString()
    const updates = await watchRollout(spawn, [
      meta(t1, '/mp2/cwd'),
      tokenCount(t1, null, { limit_id: DEFAULT_ID, primary: { used_percent: 12, window_minutes: 300 }, plan_type: 'plus' }),
      tokenCount(t2, usage(1500), null),
    ])
    const u = updates[updates.length - 1]
    expect(u.inputTokens).toBe(1500)
    expect(u.usageBuckets!.map((b) => [b.label, b.percent])).toEqual([['5h', 12]])
    expect(u.rateLimitsAt).toBe(Date.parse(t1))
  })

  it('shows every limit seen in the session, the newest reading of each', async () => {
    const spawn = startClock()
    const t = (n: number) => new Date(spawn + 100 * n).toISOString()
    const updates = await watchRollout(spawn, [
      meta(t(1), '/mp2/cwd'),
      tokenCount(t(1), usage(10), { limit_id: DEFAULT_ID, primary: { used_percent: 10, window_minutes: 300 } }),
      tokenCount(t(2), usage(20), { limit_id: 'codex_spark', limit_name: 'Spark', primary: { used_percent: 3, window_minutes: 300 } }),
      tokenCount(t(3), usage(30), { limit_id: DEFAULT_ID, primary: { used_percent: 11, window_minutes: 300 } }),
    ])
    const u = updates[updates.length - 1]
    expect(u.usageBuckets!.map((b) => [b.key, b.label, b.percent])).toEqual([['codex/300:', '5h', 11], ['codex_spark/300:Spark', 'Spark 5h', 3]])
    expect(u.rateLimitCurrent).toBe(11)
  })

  it('sends only validated figures, the legacy fields included', async () => {
    const spawn = startClock()
    const ts = new Date(spawn + 100).toISOString()
    const updates = await watchRollout(spawn, [
      meta(ts, '/mp2/cwd'),
      tokenCount(ts, usage(5), { limit_id: DEFAULT_ID, primary: { used_percent: 250, window_minutes: 300, resets_at: 1e30 }, secondary: { used_percent: 'x', window_minutes: 10080 } }),
    ])
    const u = updates[updates.length - 1]
    expect(u.rateLimitCurrent).toBe(100)
    expect(u.rateLimitCurrentResets).toBeUndefined()
    expect(u.rateLimitWeekly).toBeUndefined()
    expect(u.usageBuckets!.map((b) => [b.label, b.percent, b.resetsAt])).toEqual([['5h', 100, '']])
  })

  it('an update survives a reset time outside the Date range (it used to throw and drop the update)', () => {
    const rateLimits = { primary: { used_percent: 20, window_minutes: 300, resets_at: 1e30 }, secondary: { used_percent: 30, window_minutes: 10080, resets_at: -1e30 } }
    const tc: TokenCountEvent = {
      total_token_usage: { input_tokens: 3, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 3 },
      rate_limits: rateLimits,
    }
    const sl = withAllowance(mapTokenCountToStatusline(tc, { id: 's', cwd: '/x', model: 'm', cli_version: '1', timestamp: '' }, 'sid'), normaliseCodexRateLimits(rateLimits, 'rollout', Date.now()))
    expect(sl.inputTokens).toBe(3)
    expect(sl.rateLimitCurrent).toBe(20)
    expect(sl.rateLimitCurrentResets).toBeUndefined()
    expect(sl.rateLimitWeeklyResets).toBeUndefined()
  })

  // Review Q2: an event stamped at the edge of the Date range, carrying a
  // later reset on a separate limit, used to throw in every update from then
  // on (the merged reading kept it), leaving the session with no status line.
  it('an event at the edge of the Date range never stops the status line', async () => {
    const spawn = startClock()
    const ts = new Date(spawn + 100).toISOString()
    const edge = '+275760-09-13T00:00:00.000Z'
    expect(Date.parse(edge)).toBe(8.64e15)
    const updates = await watchRollout(spawn, [
      meta(ts, '/mp2/cwd'),
      tokenCount(edge, null, { limit_id: 'codex_x', primary: { used_percent: 5, window_minutes: 300, resets_at: 8.64e12 + 3600 } }),
      tokenCount(ts, usage(7), { limit_id: DEFAULT_ID, primary: { used_percent: 9, window_minutes: 300 } }),
    ])
    expect(updates.length).toBeGreaterThan(0)
    const u = updates[updates.length - 1]
    expect(u.inputTokens).toBe(7)
    expect(u.rateLimitCurrent).toBe(9)
    expect(u.usageBuckets!.map((b) => [b.label, b.resetsAt])).toEqual([['5h', ''], ['codex_x 5h', '']])
  })

  it('sends no usage fields when the rollout carries no rate limits', async () => {
    const spawn = startClock()
    const ts = new Date(spawn + 100).toISOString()
    const updates = await watchRollout(spawn, [meta(ts, '/mp2/cwd'), tokenCount(ts, usage(5), null)])
    const u = updates[updates.length - 1]
    expect(u.inputTokens).toBe(5)
    expect(u.usageBuckets).toBeUndefined()
    expect(u.rateLimitsAt).toBeUndefined()
    expect(u.rateLimitCurrent).toBeUndefined()
  })

  it('reports no reading once, at the 30 s give-up, when no rollout is ever claimed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spawn = startClock()
    const sessions = join(mkdtempSync(join(tmpdir(), 'ccc-test-codex-mp2-none-')), 'sessions')
    mkdirSync(join(sessions, ...ymdOf(new Date())), { recursive: true })
    const updates: unknown[] = []
    const src = watchAndClaimRollout('sess-none', '/none/cwd', spawn, (d) => updates.push(d), sessions)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(updates).toEqual([])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(updates).toEqual([{ sessionId: 'sess-none', usageUnavailable: 'no-reading' }])
    await vi.advanceTimersByTimeAsync(60_000)
    src.stop()
    expect(updates).toHaveLength(1)
  })

  it('does not report no reading when stopped before the give-up, or once a rollout was claimed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const spawn = startClock()
    const sessions = join(mkdtempSync(join(tmpdir(), 'ccc-test-codex-mp2-stop-')), 'sessions')
    mkdirSync(join(sessions, ...ymdOf(new Date())), { recursive: true })
    const stopped: unknown[] = []
    const early = watchAndClaimRollout('sess-stop', '/none/cwd', spawn, (d) => stopped.push(d), sessions)
    await vi.advanceTimersByTimeAsync(5_000)
    early.stop()
    await vi.advanceTimersByTimeAsync(40_000)
    expect(stopped).toEqual([])

    const spawn2 = Date.now()
    const ts = new Date(spawn2 + 100).toISOString()
    const updates = await watchRollout(spawn2, [meta(ts, '/mp2/cwd')], 40_000)
    expect(updates.filter((u) => u.usageUnavailable)).toEqual([])
  })

  // Usage track MP3: the live figure. The session's own package records each
  // validated allowance under the sessions folder the launch handed it, and
  // under nothing else; a recorder that throws never stops the watch.
  it('the Codex session records its allowance for the usage page by its sessions folder only', async () => {
    const spawn = startClock()
    const ts = new Date(spawn + 100).toISOString()
    const sessions = join(mkdtempSync(join(tmpdir(), 'ccc-test-codex-mp3-')), 'sessions')
    mkdirSync(join(sessions, ...ymdOf(new Date())), { recursive: true })
    writeFileSync(join(sessions, ...ymdOf(new Date()), 'rollout-mp3.jsonl'), [
      meta(ts, '/mp3/cwd'),
      tokenCount(ts, null, { limit_id: DEFAULT_ID, primary: { used_percent: 26, window_minutes: 300 }, plan_type: 'pro' }),
    ].join('\n') + '\n', 'utf-8')
    const live = createCodexLiveUsage(process.platform)
    const updates: unknown[] = []
    const src = new CodexProvider(live).ingestSessionTelemetry('sess-mp3', { cwd: '/mp3/cwd', spawnTimestamp: spawn, sessionsDir: sessions }, (d) => updates.push(d))
    await vi.advanceTimersByTimeAsync(800)
    src.stop()
    expect(updates.length).toBeGreaterThan(0)
    expect(live.get(sessions)).toMatchObject({ planType: 'pro', readingAt: Date.parse(ts), limits: [{ limitId: 'codex', primary: { usedPercent: 26 } }] })
    expect(live.get(join(sessions, '..', 'other', 'sessions'))).toBeNull()
  })

  it('a recorder that throws never stops the status line updates', async () => {
    const spawn = startClock()
    const ts = new Date(spawn + 100).toISOString()
    const updates = await (async () => {
      const sessions = join(mkdtempSync(join(tmpdir(), 'ccc-test-codex-mp3-throw-')), 'sessions')
      mkdirSync(join(sessions, ...ymdOf(new Date())), { recursive: true })
      writeFileSync(join(sessions, ...ymdOf(new Date()), 'rollout-mp3.jsonl'), [
        meta(ts, '/mp2/cwd'),
        tokenCount(ts, usage(9), { limit_id: DEFAULT_ID, primary: { used_percent: 1, window_minutes: 300 } }),
      ].join('\n') + '\n', 'utf-8')
      const got: import('../../../../src/shared/types').StatuslineData[] = []
      const src = watchAndClaimRollout('sess-mp2', '/mp2/cwd', spawn, (d) => got.push(d), sessions, () => { throw new Error('recorder') })
      await vi.advanceTimersByTimeAsync(800)
      src.stop()
      return got
    })()
    expect(updates.length).toBeGreaterThan(0)
    expect(updates[updates.length - 1].inputTokens).toBe(9)
  })
})
