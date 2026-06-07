import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// The picker is plain Node.js (CommonJS) and guards main() behind
// `require.main === module`, so require()-ing it here imports only the pure
// helpers without running the interactive picker.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('../../../scripts/resume-picker.js') as {
  encodeProjectPath: (p: string) => string
  parseWorktrees: (text: string) => Array<{ path: string; branch: string | null; isMain: boolean }>
  listWorktrees: (cwd: string) => Array<{ path: string; branch: string | null; isMain: boolean }>
  worktreeLabelFor: (wt: { path: string; branch: string | null; isMain: boolean }) => string | null
  scanWorktreeConversations: (
    wt: { path: string; branch: string | null; isMain: boolean },
    claudeProjectsDir: string,
  ) => Array<{ sessionId: string; mtime: number; size: number; filePath: string; sourceCwd: string; worktreeLabel: string | null; firstMessage: string; lastMessages: string[] }>
  mergeAndLabel: (
    conversationsBySource: Array<Array<{ mtime: number; filePath: string }>>,
    cap?: number,
  ) => Array<{ mtime: number; filePath: string }>
}

// ── encodeProjectPath ──────────────────────────────────────────────
// SOURCE OF TRUTH: src/main/logging/transcript-discovery.ts → mangleCwdToProjectDir.
// Verified pairs (2026-06-06) against real ~/.claude/projects dirs.
describe('resume-picker encodeProjectPath (mangle rule)', () => {
  it('the worktree dotted path produces the REAL on-disk folder name', () => {
    // The bug: the old rule left `.` untouched and only replaced `: \ _`, so it
    // produced F--platform-v9-.claude-worktrees-... which did NOT match disk.
    expect(picker.encodeProjectPath('F:\\platform_v9\\.claude-worktrees\\warm-toolchain'))
      .toBe('F--platform-v9--claude-worktrees-warm-toolchain')
  })

  it('a simple project path', () => {
    expect(picker.encodeProjectPath('F:\\CLAUDE_MULTI_APP')).toBe('F--CLAUDE-MULTI-APP')
    expect(picker.encodeProjectPath('C:\\Users\\nicho')).toBe('C--Users-nicho')
  })

  it('underscores become hyphens', () => {
    expect(picker.encodeProjectPath('f:\\platform_v9')).toBe('f--platform-v9')
  })

  it('preserves case (no lowercasing)', () => {
    expect(picker.encodeProjectPath('F:\\MixedCase_Path')).toBe('F--MixedCase-Path')
  })

  it('does not collapse separator runs (\\\\ → --)', () => {
    expect(picker.encodeProjectPath('a\\\\b')).toBe('a--b')
  })
})

// ── parseWorktrees ─────────────────────────────────────────────────
describe('resume-picker parseWorktrees', () => {
  it('parses a multi-worktree porcelain listing, flags main + branches', () => {
    const text = [
      'worktree F:/platform_v9',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree F:/platform_v9/.claude-worktrees/warm-toolchain',
      'HEAD def456',
      'branch refs/heads/feat/warm',
      '',
    ].join('\n')
    const out = picker.parseWorktrees(text)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ path: 'F:/platform_v9', branch: 'main', isMain: true })
    expect(out[1]).toEqual({
      path: 'F:/platform_v9/.claude-worktrees/warm-toolchain',
      branch: 'feat/warm',
      isMain: false,
    })
  })

  it('handles a detached (no branch) worktree', () => {
    const text = [
      'worktree /repo/main',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /repo/wt-detached',
      'HEAD def',
      'detached',
      '',
    ].join('\n')
    const out = picker.parseWorktrees(text)
    expect(out).toHaveLength(2)
    expect(out[1].branch).toBeNull()
    expect(out[1].isMain).toBe(false)
  })

  it('tolerates missing trailing blank line between records', () => {
    const text = [
      'worktree /repo/main',
      'branch refs/heads/main',
      'worktree /repo/wt',
      'branch refs/heads/wt',
    ].join('\n')
    const out = picker.parseWorktrees(text)
    expect(out.map(w => w.path)).toEqual(['/repo/main', '/repo/wt'])
    expect(out[0].isMain).toBe(true)
  })

  it('returns [] for empty / garbage input (fail-safe)', () => {
    expect(picker.parseWorktrees('')).toEqual([])
    expect(picker.parseWorktrees('not porcelain at all\nrandom junk')).toEqual([])
    // @ts-expect-error — defensive: non-string input must not throw
    expect(picker.parseWorktrees(null)).toEqual([])
    // @ts-expect-error — defensive
    expect(picker.parseWorktrees(undefined)).toEqual([])
  })
})

// ── worktreeLabelFor ───────────────────────────────────────────────
describe('resume-picker worktreeLabelFor', () => {
  it('returns null for the main worktree', () => {
    expect(picker.worktreeLabelFor({ path: 'F:/platform_v9', branch: 'main', isMain: true })).toBeNull()
  })

  it('uses the directory basename for a non-main worktree', () => {
    expect(picker.worktreeLabelFor({
      path: 'F:/platform_v9/.claude-worktrees/warm-toolchain',
      branch: 'feat/warm',
      isMain: false,
    })).toBe('warm-toolchain')
  })

  it('falls back to the branch name when there is no basename', () => {
    expect(picker.worktreeLabelFor({ path: '', branch: 'feat/x', isMain: false })).toBe('feat/x')
  })
})

// ── listWorktrees fail-safe ────────────────────────────────────────
describe('resume-picker listWorktrees (fail-safe)', () => {
  it('returns a single synthetic main record when cwd is not a git repo', () => {
    // A fresh temp dir is not a git repo → git errors → single-source fallback.
    const notARepo = mkdtempSync(join(tmpdir(), 'ccc-rp-notrepo-'))
    try {
      const out = picker.listWorktrees(notARepo)
      expect(out).toHaveLength(1)
      expect(out[0].path).toBe(notARepo)
      expect(out[0].isMain).toBe(true)
    } finally {
      rmSync(notARepo, { recursive: true, force: true })
    }
  })
})

// ── scanWorktreeConversations ──────────────────────────────────────
describe('resume-picker scanWorktreeConversations', () => {
  let projectsDir: string

  // Build one valid (>20480 byte) transcript with a companion dir under the
  // mangled folder for the given worktree path.
  function seedConversation(worktreePath: string, uuid: string, firstMsg: string, mtimeMs?: number) {
    const mangled = picker.encodeProjectPath(worktreePath)
    const dir = join(projectsDir, mangled)
    mkdirSync(dir, { recursive: true })
    // companion dir (current Claude CLI format requirement)
    mkdirSync(join(dir, uuid), { recursive: true })
    const head = JSON.stringify({ type: 'user', message: { content: firstMsg } })
    // Pad past the 20480-byte ghost filter.
    const padLine = JSON.stringify({ type: 'system', message: 'x'.repeat(200) })
    const lines = [head]
    for (let i = 0; i < 200; i++) lines.push(padLine)
    const file = join(dir, `${uuid}.jsonl`)
    writeFileSync(file, lines.join('\n') + '\n')
    if (mtimeMs !== undefined) {
      // utimesSync takes seconds.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('fs').utimesSync(file, mtimeMs / 1000, mtimeMs / 1000)
    }
    return file
  }

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), 'ccc-rp-projects-'))
  })

  afterEach(() => {
    try { rmSync(projectsDir, { recursive: true, force: true }) } catch {}
  })

  it('tags a main-worktree conversation with sourceCwd and null label', () => {
    const wtPath = join(projectsDir, '..', 'main-repo') // arbitrary path, only its mangle matters
    seedConversation(wtPath, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'hello main')
    const out = picker.scanWorktreeConversations({ path: wtPath, branch: 'main', isMain: true }, projectsDir)
    expect(out).toHaveLength(1)
    expect(out[0].sourceCwd).toBe(wtPath)
    expect(out[0].worktreeLabel).toBeNull()
    expect(out[0].firstMessage).toBe('hello main')
  })

  it('tags a non-main worktree conversation with its basename label', () => {
    const wtPath = join(projectsDir, '..', '.claude-worktrees', 'warm-toolchain')
    seedConversation(wtPath, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'hello worktree')
    const out = picker.scanWorktreeConversations(
      { path: wtPath, branch: 'feat/warm', isMain: false },
      projectsDir,
    )
    expect(out).toHaveLength(1)
    expect(out[0].worktreeLabel).toBe('warm-toolchain')
    expect(out[0].sourceCwd).toBe(wtPath)
  })

  it('returns [] when the project dir is missing (fail-safe)', () => {
    const out = picker.scanWorktreeConversations(
      { path: 'Z:/nonexistent/path', branch: null, isMain: true },
      projectsDir,
    )
    expect(out).toEqual([])
  })
})

// ── mergeAndLabel ──────────────────────────────────────────────────
describe('resume-picker mergeAndLabel', () => {
  it('merges sources, sorts by mtime desc, and preserves worktree labels', () => {
    const main = [
      { sessionId: 'm1', mtime: 100, filePath: '/p/main/m1.jsonl', worktreeLabel: null },
      { sessionId: 'm2', mtime: 300, filePath: '/p/main/m2.jsonl', worktreeLabel: null },
    ]
    const wt = [
      { sessionId: 'w1', mtime: 200, filePath: '/p/wt/w1.jsonl', worktreeLabel: 'warm-toolchain' },
    ]
    const out = picker.mergeAndLabel([main, wt] as never)
    expect(out.map((c: { sessionId: string }) => c.sessionId)).toEqual(['m2', 'w1', 'm1'])
    const w = out.find((c: { sessionId: string }) => c.sessionId === 'w1') as { worktreeLabel: string }
    expect(w.worktreeLabel).toBe('warm-toolchain')
  })

  it('caps the merged list', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      sessionId: `s${i}`, mtime: i, filePath: `/p/s${i}.jsonl`, worktreeLabel: null,
    }))
    const out = picker.mergeAndLabel([many] as never, 20)
    expect(out).toHaveLength(20)
    // Highest mtime first.
    expect((out[0] as { sessionId: string }).sessionId).toBe('s39')
  })

  it('dedupes by resolved filePath (same project dir scanned twice)', () => {
    const a = [{ sessionId: 'x', mtime: 10, filePath: '/p/x.jsonl', worktreeLabel: null }]
    const b = [{ sessionId: 'x', mtime: 10, filePath: '/p/x.jsonl', worktreeLabel: null }]
    const out = picker.mergeAndLabel([a, b] as never)
    expect(out).toHaveLength(1)
  })

  it('tolerates non-array sources (fail-safe)', () => {
    const out = picker.mergeAndLabel([null, undefined, [{ sessionId: 'y', mtime: 1, filePath: '/p/y.jsonl', worktreeLabel: null }]] as never)
    expect(out).toHaveLength(1)
  })
})
