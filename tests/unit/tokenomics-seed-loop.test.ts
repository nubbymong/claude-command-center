/**
 * Tests for findCodexRolloutFiles and seedTokenomics + syncTokenomics integration.
 * Uses mkdtempSync for all disk I/O -- never touches real ~/.codex or resources dir.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// ── Mocks must be hoisted before any module import ──

vi.mock('../../src/main/providers/codex/spawn', () => ({
  resolveCodexBinary: vi.fn(() => null),
}))

// We need to control CODEX_HOME via env var for findCodexRolloutFiles.
// The auth module reads process.env.CODEX_HOME ?? join(homedir(), '.codex').

// ── Helpers ──

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tok-seed-test-'))
}

/**
 * Minimal Claude JSONL transcript fixture -- one assistant message with token usage.
 * parseClaudeTranscriptFile gates on "type":"assistant" and usage fields.
 */
function makeClaudeJSONL(sessionId: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-05-01T10:00:00.000Z',
    sessionId,
    message: {
      model: 'claude-sonnet-4-6',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 0,
      },
    },
  }) + '\n'
}

const ROLLOUT_FIXTURE = path.join(process.cwd(), 'tests/fixtures/codex/rollout-sample.jsonl')
const ROLLOUT_SESSION_ID = '019ddcce-453d-7b80-8980-f3fbcb133271'

// ── findCodexRolloutFiles ──

describe('findCodexRolloutFiles', () => {
  let codexHome: string
  let originalCodexHome: string | undefined

  beforeEach(() => {
    codexHome = makeTmpDir()
    originalCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
  })

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = originalCodexHome
    }
    // Clean up tmpdir
    try { fs.rmSync(codexHome, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('returns [] when sessions dir does not exist', async () => {
    const { findCodexRolloutFiles } = await import('../../src/main/tokenomics-manager')
    const result = findCodexRolloutFiles()
    expect(result).toEqual([])
  })

  it('returns [] when CODEX_HOME itself does not exist', async () => {
    const { findCodexRolloutFiles } = await import('../../src/main/tokenomics-manager')
    // Point CODEX_HOME to a path that does not exist
    process.env.CODEX_HOME = path.join(os.tmpdir(), 'does-not-exist-' + Date.now())
    const result = findCodexRolloutFiles()
    expect(result).toEqual([])
  })

  it('finds rollout-*.jsonl files recursively, skipping size-0 files', async () => {
    const { findCodexRolloutFiles } = await import('../../src/main/tokenomics-manager')

    const sessionsDir = path.join(codexHome, 'sessions')
    const dir1 = path.join(sessionsDir, '2026', '05', '04')
    const dir2 = path.join(sessionsDir, '2026', '05', '03')
    fs.mkdirSync(dir1, { recursive: true })
    fs.mkdirSync(dir2, { recursive: true })

    const file1 = path.join(dir1, 'rollout-abc.jsonl')
    const file2 = path.join(dir1, 'rollout-xyz.jsonl')
    const emptyFile = path.join(dir2, 'rollout-empty.jsonl')
    const nonRollout = path.join(dir2, 'other.jsonl')

    fs.writeFileSync(file1, '{"type":"session_meta"}\n', 'utf-8')
    fs.writeFileSync(file2, '{"type":"session_meta"}\n', 'utf-8')
    fs.writeFileSync(emptyFile, '', 'utf-8')       // size 0 -- must be skipped
    fs.writeFileSync(nonRollout, '{"type":"x"}\n', 'utf-8') // not rollout-*.jsonl

    const result = findCodexRolloutFiles()

    // Only file1 and file2 should be returned (empty and non-rollout skipped)
    expect(result).toHaveLength(2)
    const paths = result.map(r => r.path)
    expect(paths).toContain(file1)
    expect(paths).toContain(file2)
  })

  it('returns results sorted by mtime ascending (oldest first)', async () => {
    const { findCodexRolloutFiles } = await import('../../src/main/tokenomics-manager')

    const sessionsDir = path.join(codexHome, 'sessions', 'dated')
    fs.mkdirSync(sessionsDir, { recursive: true })

    const older = path.join(sessionsDir, 'rollout-older.jsonl')
    const newer = path.join(sessionsDir, 'rollout-newer.jsonl')
    fs.writeFileSync(older, '{"type":"session_meta"}\n', 'utf-8')
    // Touch newer with a later mtime by setting it explicitly
    fs.writeFileSync(newer, '{"type":"session_meta"}\n', 'utf-8')

    // Force mtime difference: set older to 10s in the past
    const olderTime = new Date(Date.now() - 10_000)
    fs.utimesSync(older, olderTime, olderTime)

    const result = findCodexRolloutFiles()
    expect(result).toHaveLength(2)
    expect(result[0].path).toBe(older)
    expect(result[1].path).toBe(newer)
    expect(result[0].mtime).toBeLessThan(result[1].mtime)
  })
})

// ── seedTokenomics integration ──

describe('seedTokenomics + findCodexRolloutFiles integration', () => {
  let resourcesDir: string
  let configDir: string
  let codexHome: string
  let originalCodexHome: string | undefined

  beforeEach(() => {
    resourcesDir = makeTmpDir()
    configDir = path.join(resourcesDir, 'CONFIG')
    fs.mkdirSync(configDir, { recursive: true })
    codexHome = makeTmpDir()
    originalCodexHome = process.env.CODEX_HOME
    process.env.CODEX_HOME = codexHome
  })

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = originalCodexHome
    }
    try { fs.rmSync(resourcesDir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { fs.rmSync(codexHome, { recursive: true, force: true }) } catch { /* ignore */ }
    vi.restoreAllMocks()
  })

  it('ingests both a Claude transcript and a Codex rollout into cachedData.sessions', async () => {
    // -- Set up fake config dir (so getConfigDir() points to our tmp)
    vi.spyOn(
      await import('../../src/main/ipc/setup-handlers'),
      'getResourcesDirectory'
    ).mockReturnValue(resourcesDir)

    // -- Set up Claude history: .claude/projects/<proj>/session.jsonl
    const claudeDir = path.join(os.homedir(), '.claude', 'projects')
    const fakeProjectDir = path.join(resourcesDir, 'fake-claude-project')
    fs.mkdirSync(fakeProjectDir, { recursive: true })
    const claudeSessionId = 'claude-seed-test-session'
    const claudeFile = path.join(fakeProjectDir, `${claudeSessionId}.jsonl`)
    fs.writeFileSync(claudeFile, makeClaudeJSONL(claudeSessionId), 'utf-8')

    // Mock findClaudeHistoryFiles to return our synthetic file
    const claudeTelemetryMod = await import('../../src/main/providers/claude/telemetry')
    vi.spyOn(claudeTelemetryMod, 'findClaudeHistoryFiles').mockReturnValue([{
      path: claudeFile,
      mtime: Date.now(),
      projectDir: 'fake-claude-project',
    }])

    // -- Set up Codex rollout: <codexHome>/sessions/2026/05/04/rollout-x.jsonl
    const rolloutDir = path.join(codexHome, 'sessions', '2026', '05', '04')
    fs.mkdirSync(rolloutDir, { recursive: true })
    const rolloutDest = path.join(rolloutDir, 'rollout-seed-test.jsonl')
    fs.copyFileSync(ROLLOUT_FIXTURE, rolloutDest)

    // -- Run seedTokenomics
    const mod = await import('../../src/main/tokenomics-manager')
    const mockGetWindow = vi.fn(() => null)
    const result = await mod.seedTokenomics(mockGetWindow)

    // -- Both sessions must be present
    expect(Object.keys(result.sessions)).toContain(claudeSessionId)
    expect(Object.keys(result.sessions)).toContain(ROLLOUT_SESSION_ID)

    const claudeRec = result.sessions[claudeSessionId]
    expect(claudeRec.provider).toBe('claude')
    expect(claudeRec.model).toBe('claude-sonnet-4-6')
    expect(claudeRec.totalInputTokens).toBe(100)

    const codexRec = result.sessions[ROLLOUT_SESSION_ID]
    expect(codexRec.provider).toBe('codex')
    expect(codexRec.model).toBe('gpt-5.5')
    // input = input_tokens + cached_input_tokens = 21805 + 19328 = 41133
    expect(codexRec.totalInputTokens).toBe(41133)
  })
})
