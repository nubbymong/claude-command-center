import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { backfillTokenomicsProvider } from '../../src/main/tokenomics-manager'
import type { TokenomicsData } from '../../src/shared/types'

describe('backfillTokenomicsProvider', () => {
  it('tags untyped sessions as claude', () => {
    const data: TokenomicsData = {
      sessions: { 's1': { sessionId: 's1', model: 'sonnet' } as any },
      dailyAggregates: {},
      lastSyncTimestamp: 0,
      totalCostUsd: 0,
      seedComplete: true,
    }
    const mutated = backfillTokenomicsProvider(data)
    expect(mutated).toBe(true)
    expect((data.sessions['s1'] as any).provider).toBe('claude')
  })

  it('leaves typed sessions untouched and reports not mutated', () => {
    const data: TokenomicsData = {
      sessions: { 's2': { sessionId: 's2', model: 'gpt-5.5', provider: 'codex' } as any },
      dailyAggregates: {},
      lastSyncTimestamp: 0,
      totalCostUsd: 0,
      seedComplete: true,
    }
    const mutated = backfillTokenomicsProvider(data)
    expect(mutated).toBe(false)
    expect((data.sessions['s2'] as any).provider).toBe('codex')
  })

  it('handles mixed batches (some typed, some not)', () => {
    const data: TokenomicsData = {
      sessions: {
        's1': { sessionId: 's1', model: 'sonnet' } as any,
        's2': { sessionId: 's2', model: 'gpt-5.5', provider: 'codex' } as any,
        's3': { sessionId: 's3', model: 'opus' } as any,
      },
      dailyAggregates: {},
      lastSyncTimestamp: 0,
      totalCostUsd: 0,
      seedComplete: true,
    }
    const mutated = backfillTokenomicsProvider(data)
    expect(mutated).toBe(true)
    expect((data.sessions['s1'] as any).provider).toBe('claude')
    expect((data.sessions['s2'] as any).provider).toBe('codex')
    expect((data.sessions['s3'] as any).provider).toBe('claude')
  })
})

// ── Codex rollout shape dispatch ──

describe('ingestCodexRolloutFile', () => {
  const FIXTURE = path.join(process.cwd(), 'tests/fixtures/codex/rollout-sample.jsonl')
  let tmpDir: string
  let data: TokenomicsData

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-test-'))
    data = {
      sessions: {},
      dailyAggregates: {},
      lastSyncTimestamp: 0,
      totalCostUsd: 0,
      seedComplete: false,
    }
  })

  it('imports the function without error', async () => {
    const mod = await import('../../src/main/tokenomics-manager')
    expect(typeof mod.ingestCodexRolloutFile).toBe('function')
  })

  it('parses the rollout fixture and creates a codex session record', async () => {
    const { ingestCodexRolloutFile } = await import('../../src/main/tokenomics-manager')
    await ingestCodexRolloutFile(FIXTURE, data)

    const sessions = Object.values(data.sessions)
    expect(sessions).toHaveLength(1)

    const rec = sessions[0]
    expect(rec.provider).toBe('codex')
    expect(rec.model).toBe('gpt-5.5')
    expect(rec.projectDir).toBe('/anon/repo')
    // input total = input_tokens + cached_input_tokens = 21805 + 19328 = 41133
    expect(rec.totalInputTokens).toBe(41133)
    // output total = output_tokens + reasoning_output_tokens = 30 + 0 = 30
    expect(rec.totalOutputTokens).toBe(30)
    // cache read = cached_input_tokens = 19328
    expect(rec.totalCacheReadTokens).toBe(19328)
    // cache write = 0 for codex
    expect(rec.totalCacheWriteTokens).toBe(0)
    // messageCount = number of token_count events with real info (1 in fixture)
    expect(rec.messageCount).toBe(1)
  })

  it('sets firstTimestamp and lastTimestamp from event timestamps', async () => {
    const { ingestCodexRolloutFile } = await import('../../src/main/tokenomics-manager')
    await ingestCodexRolloutFile(FIXTURE, data)

    const rec = Object.values(data.sessions)[0]
    expect(rec.firstTimestamp).toBeTruthy()
    expect(rec.lastTimestamp).toBeTruthy()
    // timestamps come from fixture events -- both should be ISO strings
    expect(rec.firstTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('does not crash on a malformed first line (skip file gracefully)', async () => {
    const { ingestCodexRolloutFile } = await import('../../src/main/tokenomics-manager')
    const badFile = path.join(tmpDir, 'bad.jsonl')
    fs.writeFileSync(badFile, 'not-json\n{"type":"event_msg"}\n', 'utf-8')
    // Should not throw; data stays empty
    await ingestCodexRolloutFile(badFile, data)
    expect(Object.keys(data.sessions)).toHaveLength(0)
  })

  it('skips a Claude JSONL (non-session_meta first line) without adding codex records', async () => {
    const { ingestCodexRolloutFile } = await import('../../src/main/tokenomics-manager')
    const claudeLike = path.join(tmpDir, 'claude.jsonl')
    // First line looks like a Claude transcript line (no type: session_meta)
    fs.writeFileSync(claudeLike, '{"type":"human","message":{"content":"hi"}}\n', 'utf-8')
    await ingestCodexRolloutFile(claudeLike, data)
    // Should do nothing -- Claude files are not processed by this function
    expect(Object.keys(data.sessions)).toHaveLength(0)
  })
})

describe('detectAndIngestFile', () => {
  const ROLLOUT_FIXTURE = path.join(process.cwd(), 'tests/fixtures/codex/rollout-sample.jsonl')
  let tmpDir: string
  let data: TokenomicsData

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-test2-'))
    data = {
      sessions: {},
      dailyAggregates: {},
      lastSyncTimestamp: 0,
      totalCostUsd: 0,
      seedComplete: false,
    }
  })

  it('routes codex rollout to codex path and sets provider=codex', async () => {
    const { detectAndIngestFile } = await import('../../src/main/tokenomics-manager')
    await detectAndIngestFile(ROLLOUT_FIXTURE, data)

    const sessions = Object.values(data.sessions)
    expect(sessions).toHaveLength(1)
    expect(sessions[0].provider).toBe('codex')
  })

  it('routes a Claude-like JSONL to claude path (empty for minimal fixture)', async () => {
    const { detectAndIngestFile } = await import('../../src/main/tokenomics-manager')
    const claudeFile = path.join(tmpDir, 'abc123.jsonl')
    // A minimal Claude line that doesn't trigger session_meta detection
    fs.writeFileSync(claudeFile, '{"type":"human","message":{"content":"test"}}\n', 'utf-8')

    // detectAndIngestFile for Claude path calls parseClaudeTranscriptFile which
    // returns empty for no assistant lines -- no session created, no crash
    await detectAndIngestFile(claudeFile, data)
    expect(Object.keys(data.sessions)).toHaveLength(0)
  })
})
