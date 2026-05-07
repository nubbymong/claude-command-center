import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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

  // I1: ingestCodexRolloutFile honours preloadedText (does not re-read the file from disk)
  it('uses preloadedText when provided instead of reading from disk (I1)', async () => {
    const { ingestCodexRolloutFile } = await import('../../src/main/tokenomics-manager')
    // Write a file whose content differs from the preloaded text
    const diskFile = path.join(tmpDir, 'rollout-disk.jsonl')
    // Disk file has a different session ID so we can tell which one was used
    const diskContent = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8')
      .replace('019ddcce-453d-7b80-8980-f3fbcb133271', 'disk-session-id-should-not-appear')
    fs.writeFileSync(diskFile, diskContent, 'utf-8')

    // preloadedText uses the real fixture (original session ID)
    const preloaded = fs.readFileSync(ROLLOUT_FIXTURE, 'utf-8')
    await ingestCodexRolloutFile(diskFile, data, preloaded)

    // Record uses the session ID from preloadedText, not from the disk file
    expect(Object.keys(data.sessions)).toContain('019ddcce-453d-7b80-8980-f3fbcb133271')
    expect(Object.keys(data.sessions)).not.toContain('disk-session-id-should-not-appear')
  })
})

// ── I3: empty meta.model skips record ──

describe('ingestCodexRolloutFile -- I3 empty model skip', () => {
  let tmpDir: string
  let data: TokenomicsData

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-i3-'))
    data = {
      sessions: {},
      dailyAggregates: {},
      lastSyncTimestamp: 0,
      totalCostUsd: 0,
      seedComplete: false,
    }
  })

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('does not add a record when session_meta exists but no turn_context (model is empty)', async () => {
    // A rollout with session_meta + a real token_count but NO turn_context event,
    // so parseCodexRollout leaves meta.model = '' (session_meta.payload has no model field).
    const noModelRollout = [
      JSON.stringify({
        timestamp: '2026-05-01T10:00:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'early-life-session-id',
          timestamp: '2026-05-01T10:00:00.000Z',
          cwd: '/test/repo',
          originator: 'codex-tui',
          cli_version: '0.125.0',
          source: 'cli',
          model_provider: 'openai',
        },
      }),
      // token_count with real data but no turn_context that would set the model
      JSON.stringify({
        timestamp: '2026-05-01T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 0,
              output_tokens: 20,
              reasoning_output_tokens: 0,
              total_tokens: 120,
            },
            model_context_window: 128000,
          },
          rate_limits: null,
        },
      }),
    ].join('\n') + '\n'

    const rolloutFile = path.join(tmpDir, 'rollout-no-model.jsonl')
    fs.writeFileSync(rolloutFile, noModelRollout, 'utf-8')

    const { ingestCodexRolloutFile } = await import('../../src/main/tokenomics-manager')
    await ingestCodexRolloutFile(rolloutFile, data)

    // No record should be written -- early-life rollout without model is silently skipped
    expect(Object.keys(data.sessions)).toHaveLength(0)
  })
})

// ── I2: symlink loop guard ──

describe('findCodexRolloutFiles -- I2 symlink loop guard', () => {
  let codexHome: string
  let originalCodexHome: string | undefined

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-i2-'))
    originalCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
  })

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = originalCodexHome
    }
    try { fs.rmSync(codexHome, { recursive: true, force: true }) } catch { /* ignore */ }
    vi.restoreAllMocks()
  })

  it('does not hang or stack-overflow on a symlink pointing to a parent directory (I2)', async () => {
    // Symlink creation on Windows requires elevation or Developer Mode.
    // Attempt it; if it throws EPERM, skip gracefully.
    const sessionsDir = path.join(codexHome, 'sessions')
    const targetDir = path.join(sessionsDir, 'real')
    fs.mkdirSync(targetDir, { recursive: true })
    // Put a real rollout file in the real dir so there is something to find
    fs.writeFileSync(
      path.join(targetDir, 'rollout-test.jsonl'),
      '{"type":"session_meta"}\n',
      'utf-8',
    )

    const linkPath = path.join(sessionsDir, 'loop-link')
    let canCreateSymlink = false
    try {
      fs.symlinkSync(sessionsDir, linkPath, 'junction')
      canCreateSymlink = true
    } catch {
      // Could not create symlink -- skip symlink-specific assertion
    }

    const { findCodexRolloutFiles } = await import('../../src/main/tokenomics-manager')

    if (!canCreateSymlink) {
      console.warn('[I2 test] Skipping symlink-loop assertion -- symlink creation not permitted on this host')
      // Still verify the function returns the real file without error
      const result = findCodexRolloutFiles()
      expect(Array.isArray(result)).toBe(true)
      return
    }

    // With the symlink guard in place this must complete without stack overflow
    let result: Array<{ path: string; mtime: number }> | undefined
    expect(() => {
      result = findCodexRolloutFiles()
    }).not.toThrow()
    // The real rollout file should still be found
    expect(result).toBeDefined()
    expect(result!.some(r => r.path.includes('rollout-test.jsonl'))).toBe(true)
  })
})
