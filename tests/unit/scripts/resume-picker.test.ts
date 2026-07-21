import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync } from 'fs'
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
  ensureCompanionDir: (projectDir: string, uuid: string) => boolean
  computeLayoutWidth: (columns: number | undefined) => number
  loadWorkNames: (configDir: string | undefined) => Map<string, string>
}

// ── encodeProjectPath ──────────────────────────────────────────────
// SOURCE OF TRUTH: src/main/logging/transcript-discovery.ts → mangleCwdToProjectDir.
// Verified pairs (2026-06-06) against real ~/.claude/projects dirs.
describe('resume-picker encodeProjectPath (mangle rule)', () => {
  it('the worktree dotted path produces the REAL on-disk folder name', () => {
    // The bug: the old rule left `.` untouched and only replaced `: \ _`, so it
    // produced F--sample-app-.claude-worktrees-... which did NOT match disk.
    expect(picker.encodeProjectPath('F:\\sample_app\\.claude-worktrees\\warm-toolchain'))
      .toBe('F--sample-app--claude-worktrees-warm-toolchain')
  })

  it('a simple project path', () => {
    expect(picker.encodeProjectPath('F:\\MY_PROJECT')).toBe('F--MY-PROJECT')
    expect(picker.encodeProjectPath('C:\\Users\\jane')).toBe('C--Users-jane')
  })

  it('underscores become hyphens', () => {
    expect(picker.encodeProjectPath('f:\\sample_app')).toBe('f--sample-app')
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
      'worktree F:/sample_app',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree F:/sample_app/.claude-worktrees/warm-toolchain',
      'HEAD def456',
      'branch refs/heads/feat/warm',
      '',
    ].join('\n')
    const out = picker.parseWorktrees(text)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ path: 'F:/sample_app', branch: 'main', isMain: true })
    expect(out[1]).toEqual({
      path: 'F:/sample_app/.claude-worktrees/warm-toolchain',
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
    expect(picker.worktreeLabelFor({ path: 'F:/sample_app', branch: 'main', isMain: true })).toBeNull()
  })

  it('uses the directory basename for a non-main worktree', () => {
    expect(picker.worktreeLabelFor({
      path: 'F:/sample_app/.claude-worktrees/warm-toolchain',
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
  function seedConversation(
    worktreePath: string,
    uuid: string,
    firstMsg: string,
    mtimeMs?: number,
    withCompanionDir = true,
  ) {
    const mangled = picker.encodeProjectPath(worktreePath)
    const dir = join(projectsDir, mangled)
    mkdirSync(dir, { recursive: true })
    // companion dir — present for conversations that spawned a subagent/workflow,
    // ABSENT for direct-work conversations (the bug: those used to be hidden).
    if (withCompanionDir) mkdirSync(join(dir, uuid), { recursive: true })
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

  it('THE FIX: lists a direct-work transcript that has NO companion dir', () => {
    // The root-cause bug: a conversation that never spawned a subagent/workflow
    // has no companion dir, so the old companion-dir gate hid it from the picker
    // (and the user lost it). It must now appear in the list.
    const wtPath = join(projectsDir, '..', 'direct-repo')
    seedConversation(wtPath, 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'direct work, no subagents', undefined, false)
    const out = picker.scanWorktreeConversations({ path: wtPath, branch: 'main', isMain: true }, projectsDir)
    expect(out).toHaveLength(1)
    expect(out[0].sessionId).toBe('dddddddd-dddd-dddd-dddd-dddddddddddd')
    expect(out[0].firstMessage).toBe('direct work, no subagents')
  })

  it('lists BOTH dir-less and dir-having transcripts together', () => {
    const wtPath = join(projectsDir, '..', 'mixed-repo')
    seedConversation(wtPath, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'has companion', undefined, true)
    seedConversation(wtPath, 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'no companion', undefined, false)
    const out = picker.scanWorktreeConversations({ path: wtPath, branch: 'main', isMain: true }, projectsDir)
    expect(out.map((c) => c.sessionId).sort()).toEqual([
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    ])
  })
})

// ── ensureCompanionDir (inline, mirrors src/main/logging/companion-dir.ts) ──
describe('resume-picker ensureCompanionDir', () => {
  let projectDir: string
  const UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

  beforeEach(() => { projectDir = mkdtempSync(join(tmpdir(), 'ccc-rp-companion-')) })
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }) } catch {} })

  function seedTranscript(uuid: string) {
    writeFileSync(join(projectDir, `${uuid}.jsonl`), '{}\n')
  }

  it('creates <uuid>/ with subagents/ and workflows/ when the transcript exists', () => {
    seedTranscript(UUID)
    expect(picker.ensureCompanionDir(projectDir, UUID)).toBe(true)
    expect(statSync(join(projectDir, UUID)).isDirectory()).toBe(true)
    expect(statSync(join(projectDir, UUID, 'subagents')).isDirectory()).toBe(true)
    expect(statSync(join(projectDir, UUID, 'workflows')).isDirectory()).toBe(true)
  })

  it('is idempotent and never deletes existing contents', () => {
    seedTranscript(UUID)
    mkdirSync(join(projectDir, UUID, 'subagents'), { recursive: true })
    writeFileSync(join(projectDir, UUID, 'subagents', 'keep.jsonl'), 'real')
    expect(picker.ensureCompanionDir(projectDir, UUID)).toBe(true)
    expect(readFileSync(join(projectDir, UUID, 'subagents', 'keep.jsonl'), 'utf-8')).toBe('real')
  })

  it('refuses to create an orphan dir when no transcript exists', () => {
    expect(picker.ensureCompanionDir(projectDir, UUID)).toBe(false)
    expect(existsSync(join(projectDir, UUID))).toBe(false)
  })

  it('heals a partially-created companion dir (adds a missing subdir)', () => {
    seedTranscript(UUID)
    mkdirSync(join(projectDir, UUID, 'subagents'), { recursive: true }) // workflows missing
    expect(picker.ensureCompanionDir(projectDir, UUID)).toBe(true)
    expect(statSync(join(projectDir, UUID, 'workflows')).isDirectory()).toBe(true)
  })

  it('returns false and never clobbers a stray same-named FILE', () => {
    seedTranscript(UUID)
    writeFileSync(join(projectDir, UUID), 'real file')
    expect(picker.ensureCompanionDir(projectDir, UUID)).toBe(false)
    expect(statSync(join(projectDir, UUID)).isFile()).toBe(true)
    expect(readFileSync(join(projectDir, UUID), 'utf-8')).toBe('real file')
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

// ── computeLayoutWidth (#130 width fix) ─────────────────────────────
describe('resume-picker computeLayoutWidth', () => {
  it('honors a wide terminal instead of the old 78-col clamp (capped at 120)', () => {
    expect(picker.computeLayoutWidth(200)).toBe(120)
    expect(picker.computeLayoutWidth(100)).toBe(96) // cols - 4
  })

  it('floors at 60 for a narrow terminal', () => {
    expect(picker.computeLayoutWidth(40)).toBe(60)
    expect(picker.computeLayoutWidth(10)).toBe(60)
  })

  it('falls back to 80 columns when width is unknown (→ 76)', () => {
    expect(picker.computeLayoutWidth(undefined)).toBe(76)
    expect(picker.computeLayoutWidth(0)).toBe(76)
  })
})

// ── loadWorkNames (#130: surface the renamed session's work name) ────
describe('resume-picker loadWorkNames', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccc-worknames-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const write = (state: unknown) =>
    writeFileSync(join(dir, 'session-state.json'), JSON.stringify(state), 'utf-8')

  it('maps resumeUuid -> customName for renamed sessions', () => {
    write({
      sessions: [
        { id: 'a', resumeUuid: 'uuid-1', customName: 'Billing refactor' },
        { id: 'b', resumeUuid: 'uuid-2', customName: '  Docs sweep  ' }, // trimmed
      ],
    })
    const map = picker.loadWorkNames(dir)
    expect(map.get('uuid-1')).toBe('Billing refactor')
    expect(map.get('uuid-2')).toBe('Docs sweep')
    expect(map.size).toBe(2)
  })

  it('skips sessions without a customName or without a resumeUuid', () => {
    write({
      sessions: [
        { id: 'a', resumeUuid: 'uuid-1' },                    // no name
        { id: 'b', customName: 'Named but no uuid' },         // no uuid
        { id: 'c', resumeUuid: 'uuid-3', customName: '   ' }, // blank name
        { id: 'd', resumeUuid: 'uuid-4', customName: 'Keep' },
      ],
    })
    const map = picker.loadWorkNames(dir)
    expect(map.size).toBe(1)
    expect(map.get('uuid-4')).toBe('Keep')
  })

  it('is fail-safe: missing dir, missing file, or bad JSON → empty map', () => {
    expect(picker.loadWorkNames(undefined).size).toBe(0)
    expect(picker.loadWorkNames(dir).size).toBe(0) // no file written yet
    writeFileSync(join(dir, 'session-state.json'), '{ not json', 'utf-8')
    expect(picker.loadWorkNames(dir).size).toBe(0)
  })
})
