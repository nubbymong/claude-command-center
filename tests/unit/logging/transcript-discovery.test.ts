/**
 * Pure unit tests for transcript-discovery.ts.
 *
 * IMPORTANT: This is a plain vitest test — NOT a native test. The module has
 * zero runtime deps beyond node built-ins (os, path, fs), so no Electron ABI
 * or sqlite is involved. Do NOT rename to *.native.test.ts.
 *
 * Mangle rule verified 2026-06-06 against real ~/.claude/projects dirs on
 * the dev machine:
 *   Input cwd                                            → Real dir observed
 *   ─────────────────────────────────────────────────────────────────────────
 *   F:\CLAUDE_MULTI_APP                                  → F--CLAUDE-MULTI-APP
 *   f:\platform_v9                                       → f--platform-v9
 *   F:\platform_v9\.claude-worktrees\warm-toolchain      → F--platform-v9--claude-worktrees-warm-toolchain
 *   C:\Users\nicho                                       → C--Users-nicho
 *
 * Rule: cwd.replace(/[^A-Za-z0-9]/g, '-')
 *   Every non-alphanumeric char (colon, backslash, forward-slash, underscore, dot, space)
 *   becomes ONE hyphen. No run-collapsing. Input case preserved.
 */

import { describe, it, expect } from 'vitest'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  canonicalizeTranscriptPath,
  mangleCwdToProjectDir,
  makeHeuristicBinder,
} from '../../../src/main/logging/transcript-discovery'

// ---------------------------------------------------------------------------
// canonicalizeTranscriptPath
// ---------------------------------------------------------------------------

describe('canonicalizeTranscriptPath', () => {
  const homedir = os.homedir()

  it('rewrites a fake-HOME junction path to canonical homedir path', () => {
    // Simulate: resources/account-profiles/p1/.claude/projects/f--x/a.jsonl
    const fakeHome = 'F:\\RES\\account-profiles\\p1'
    const input = `${fakeHome}\\.claude\\projects\\f--x\\a.jsonl`
    const result = canonicalizeTranscriptPath(input)
    const expected = path.join(homedir, '.claude', 'projects', 'f--x', 'a.jsonl')
    expect(result).toBe(expected)
  })

  it('rewrites a retired per-session account-homes path to canonical homedir path', () => {
    // Simulate: resources/account-homes/sess-9/.claude/projects/f--x/a.jsonl
    const sessionHome = 'F:\\RES\\account-homes\\sess-9'
    const input = `${sessionHome}\\.claude\\projects\\f--x\\a.jsonl`
    const result = canonicalizeTranscriptPath(input)
    const expected = path.join(homedir, '.claude', 'projects', 'f--x', 'a.jsonl')
    expect(result).toBe(expected)
  })

  it('passes through an already-canonical path unchanged (normalized)', () => {
    const canonical = path.join(homedir, '.claude', 'projects', 'F--CLAUDE-MULTI-APP', 'conv-uuid.jsonl')
    const result = canonicalizeTranscriptPath(canonical)
    expect(result).toBe(path.normalize(canonical))
  })

  it('tolerates forward-slash separators in input', () => {
    const input = 'F:/RES/account-profiles/p2/.claude/projects/f--x/b.jsonl'
    const result = canonicalizeTranscriptPath(input)
    const expected = path.join(homedir, '.claude', 'projects', 'f--x', 'b.jsonl')
    expect(result).toBe(expected)
  })

  it('returns null for a path with no .claude/projects segment', () => {
    expect(canonicalizeTranscriptPath('C:\\random\\file.txt')).toBeNull()
    expect(canonicalizeTranscriptPath('/home/user/notes.jsonl')).toBeNull()
    expect(canonicalizeTranscriptPath('')).toBeNull()
  })

  it('.claude dir in prefix (no /projects) does not confuse the segment matcher', () => {
    // A path where a leading directory is literally named ".claude" (no /projects
    // after it) — the only valid segment is the second .claude/projects.
    const input = 'C:\\.claude\\some-dir\\.claude\\projects\\proj\\conv.jsonl'
    const result = canonicalizeTranscriptPath(input)
    const expected = path.join(homedir, '.claude', 'projects', 'proj', 'conv.jsonl')
    expect(result).toBe(expected)
  })

  it('uses the LAST .claude/projects segment when TWO full .claude/projects pairs appear (degenerate / nested junction)', () => {
    // Counter-example from the spec:
    //   F:/outer/.claude/projects/inner/.claude/projects/proj/conv.jsonl
    // The first .claude/projects segment is part of the fake-home prefix;
    // the second is the canonical one — rest must be `proj/conv.jsonl`, not
    // `inner/.claude/projects/proj/conv.jsonl`.
    const input = 'F:/outer/.claude/projects/inner/.claude/projects/proj/conv.jsonl'
    const result = canonicalizeTranscriptPath(input)
    const expected = path.join(homedir, '.claude', 'projects', 'proj', 'conv.jsonl')
    expect(result).toBe(expected)
  })

  it('is case-insensitive for .claude/projects matching on Windows-style paths', () => {
    const input = 'F:\\RES\\account-profiles\\p1\\.CLAUDE\\Projects\\f--x\\a.jsonl'
    const result = canonicalizeTranscriptPath(input)
    const expected = path.join(homedir, '.claude', 'projects', 'f--x', 'a.jsonl')
    expect(result).toBe(expected)
  })
})

// ---------------------------------------------------------------------------
// mangleCwdToProjectDir
// ---------------------------------------------------------------------------

describe('mangleCwdToProjectDir', () => {
  /**
   * All four pairs below are verified against the developer machine's real
   * ~/.claude/projects directory listing (2026-06-06).
   *
   * Rule: cwd.replace(/[^A-Za-z0-9]/g, '-')
   *   Every non-alphanumeric char → ONE hyphen. No run-collapsing. Case preserved.
   *
   * NOTE: src/main/utils/claude-project-path.ts uses an OLDER/LOOSER rule
   * (preserves underscores, collapses separator runs). It is intentionally NOT
   * changed here — the divergence is flagged in mangleCwdToProjectDir's doc comment.
   */

  // ── Pair 1: verified against real store 2026-06-06 ──
  it('F:\\CLAUDE_MULTI_APP → F--CLAUDE-MULTI-APP (underscore → hyphen; verified real dir)', () => {
    expect(mangleCwdToProjectDir('F:\\CLAUDE_MULTI_APP')).toBe('F--CLAUDE-MULTI-APP')
  })

  // ── Pair 2: verified against real store 2026-06-06 ──
  it('f:\\platform_v9 → f--platform-v9 (lowercase preserved, underscore → hyphen; verified real dir)', () => {
    expect(mangleCwdToProjectDir('f:\\platform_v9')).toBe('f--platform-v9')
  })

  // ── Pair 3: verified against real store 2026-06-06 ──
  it('F:\\platform_v9\\.claude-worktrees\\warm-toolchain → F--platform-v9--claude-worktrees-warm-toolchain (dot → hyphen, NO run-collapsing; verified real dir)', () => {
    expect(mangleCwdToProjectDir('F:\\platform_v9\\.claude-worktrees\\warm-toolchain')).toBe(
      'F--platform-v9--claude-worktrees-warm-toolchain',
    )
  })

  // ── Pair 4: verified against real store 2026-06-06 ──
  it('C:\\Users\\nicho → C--Users-nicho (verified real dir)', () => {
    expect(mangleCwdToProjectDir('C:\\Users\\nicho')).toBe('C--Users-nicho')
  })

  // ── Synthetic: dots and spaces replaced, no collapsing ──
  it('/home/a b/x.y → -home-a-b-x-y (space → hyphen, dot → hyphen, synthetic)', () => {
    expect(mangleCwdToProjectDir('/home/a b/x.y')).toBe('-home-a-b-x-y')
  })

  // ── Confirm no-run-collapsing: backslash after colon = two hyphens ──
  it('consecutive non-alnum chars each become their own hyphen (no run-collapsing)', () => {
    // F: → F- then \ → - giving F-- (not F-)
    expect(mangleCwdToProjectDir('F:\\test')).toBe('F--test')
  })

  it('path with only alphanumerics passes through unchanged', () => {
    expect(mangleCwdToProjectDir('nodrivepath')).toBe('nodrivepath')
  })
})

// ---------------------------------------------------------------------------
// makeHeuristicBinder
// ---------------------------------------------------------------------------

describe('makeHeuristicBinder', () => {
  /**
   * Creates a temporary directory tree simulating ~/.claude/projects/<mangled>/
   * and exercises the binder with injected fs and now() stubs.
   */

  function makeTmpProjectsRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-disc-test-'))
  }

  function writeJsonl(dir: string, name: string, mtimeMs: number): string {
    const filePath = path.join(dir, name)
    fs.writeFileSync(filePath, '{"type":"user"}\n')
    fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs))
    return filePath
  }

  it('picks the newest .jsonl with mtime >= startedAtMs - 60_000', () => {
    const root = makeTmpProjectsRoot()
    const cwd = 'F:\\my-project'
    const mangled = mangleCwdToProjectDir(cwd)
    const projDir = path.join(root, mangled)
    fs.mkdirSync(projDir, { recursive: true })

    const startedAt = 1_000_000
    // oldest: before the 60s window
    writeJsonl(projDir, 'old.jsonl', startedAt - 120_000)
    // in-window: exactly at startedAt - 60_000
    writeJsonl(projDir, 'boundary.jsonl', startedAt - 60_000)
    // newest: after startedAt
    const newestPath = writeJsonl(projDir, 'newest.jsonl', startedAt + 5_000)

    const binder = makeHeuristicBinder({ projectsRoot: root })
    const binding = binder.bindOnce('sess-1', cwd, startedAt)

    expect(binding).not.toBeNull()
    expect(binding!.confidence).toBe('heuristic')
    // Must be the newest file (in-window)
    expect(binding!.path).toBe(path.normalize(newestPath))
  })

  it('ignores .jsonl files older than startedAtMs - 60_000', () => {
    const root = makeTmpProjectsRoot()
    const cwd = 'F:\\old-project'
    const projDir = path.join(root, mangleCwdToProjectDir(cwd))
    fs.mkdirSync(projDir, { recursive: true })

    const startedAt = 1_000_000
    // Only old files, none in window
    writeJsonl(projDir, 'too-old.jsonl', startedAt - 120_000)

    const binder = makeHeuristicBinder({ projectsRoot: root })
    const binding = binder.bindOnce('sess-2', cwd, startedAt)
    expect(binding).toBeNull()
  })

  it('returns null when project dir does not exist', () => {
    const root = makeTmpProjectsRoot()
    const cwd = 'F:\\nonexistent-project'
    // No dir created for this cwd

    const binder = makeHeuristicBinder({ projectsRoot: root })
    const binding = binder.bindOnce('sess-3', cwd, Date.now())
    expect(binding).toBeNull()
  })

  it('returns canonical path (rewrites .claude/projects prefix to homedir)', () => {
    // Use a fake projectsRoot that itself contains .claude/projects so the
    // canonicalization logic has a segment to rewrite.
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-disc-canon-'))
    const fakeRoot = path.join(tmpBase, '.claude', 'projects')
    const cwd = 'F:\\canonical-test'
    const mangled = mangleCwdToProjectDir(cwd)
    const projDir = path.join(fakeRoot, mangled)
    fs.mkdirSync(projDir, { recursive: true })

    const startedAt = 2_000_000
    writeJsonl(projDir, 'conv.jsonl', startedAt + 1_000)

    const binder = makeHeuristicBinder({ projectsRoot: fakeRoot })
    const binding = binder.bindOnce('sess-canon', cwd, startedAt)

    expect(binding).not.toBeNull()
    expect(binding!.confidence).toBe('heuristic')
    // The path must be rewritten so the .claude/projects prefix matches homedir.
    const expected = path.join(os.homedir(), '.claude', 'projects', mangled, 'conv.jsonl')
    expect(binding!.path).toBe(expected)
  })

  describe('BIND-ONCE semantics', () => {
    it('second call for same sessionId returns IDENTICAL binding even after newer file appears', () => {
      const root = makeTmpProjectsRoot()
      const cwd = 'F:\\bind-once-test'
      const mangled = mangleCwdToProjectDir(cwd)
      const projDir = path.join(root, mangled)
      fs.mkdirSync(projDir, { recursive: true })

      const startedAt = 3_000_000
      const firstPath = writeJsonl(projDir, 'first.jsonl', startedAt + 1_000)

      const binder = makeHeuristicBinder({ projectsRoot: root })
      const binding1 = binder.bindOnce('sess-bo', cwd, startedAt)
      expect(binding1).not.toBeNull()

      // Now add a newer file
      writeJsonl(projDir, 'newer.jsonl', startedAt + 9_000)

      // Second call must return the SAME binding (not the newer file)
      const binding2 = binder.bindOnce('sess-bo', cwd, startedAt)
      expect(binding2).toBe(binding1) // same object reference

      // The path is the raw tmpdir path (no .claude/projects segment to canonicalize).
      expect(binding2!.path).toBe(path.normalize(firstPath))
    })

    it('a failed first call (null) may succeed on retry', () => {
      const root = makeTmpProjectsRoot()
      const cwd = 'F:\\retry-test'
      const projDir = path.join(root, mangleCwdToProjectDir(cwd))
      // Do NOT create the dir yet → first call returns null

      const binder = makeHeuristicBinder({ projectsRoot: root })
      const binding1 = binder.bindOnce('sess-retry', cwd, 4_000_000)
      expect(binding1).toBeNull()

      // Now create the dir + file
      fs.mkdirSync(projDir, { recursive: true })
      writeJsonl(projDir, 'late.jsonl', 4_000_000 + 1_000)

      // Retry should succeed
      const binding2 = binder.bindOnce('sess-retry', cwd, 4_000_000)
      expect(binding2).not.toBeNull()
      expect(binding2!.confidence).toBe('heuristic')
    })

    it('different sessionIds bind independently', () => {
      const root = makeTmpProjectsRoot()
      const cwd = 'F:\\shared-project'
      const projDir = path.join(root, mangleCwdToProjectDir(cwd))
      fs.mkdirSync(projDir, { recursive: true })

      const startedAt = 5_000_000
      const pathA = writeJsonl(projDir, 'conv-a.jsonl', startedAt + 1_000)
      const pathB = writeJsonl(projDir, 'conv-b.jsonl', startedAt + 2_000)

      const binder = makeHeuristicBinder({ projectsRoot: root })
      // sess-A binds first — picks conv-b (newest at time of call)
      const bindingA = binder.bindOnce('sess-A', cwd, startedAt)
      expect(bindingA).not.toBeNull()

      // Add an even newer file — sess-B picks it; sess-A is unaffected
      const pathC = writeJsonl(projDir, 'conv-c.jsonl', startedAt + 5_000)
      const bindingB = binder.bindOnce('sess-B', cwd, startedAt)
      expect(bindingB).not.toBeNull()

      // sess-A stays on its original binding, sess-B gets the newer one
      // The tmpdir root has no .claude/projects segment, so paths are raw (not canonicalized).
      const mangled = mangleCwdToProjectDir(cwd)
      const rawBase = path.join(root, mangled)
      expect(bindingA!.path).toBe(path.normalize(path.join(rawBase, 'conv-b.jsonl')))
      expect(bindingB!.path).toBe(path.normalize(path.join(rawBase, 'conv-c.jsonl')))

      // Calling again for sess-A still returns its original
      expect(binder.bindOnce('sess-A', cwd, startedAt)).toBe(bindingA)

      void pathA
      void pathB
      void pathC
    })
  })

  it('boundary: mtime exactly at startedAtMs - 60_000 is INCLUDED', () => {
    const root = makeTmpProjectsRoot()
    const cwd = 'F:\\boundary-test'
    const projDir = path.join(root, mangleCwdToProjectDir(cwd))
    fs.mkdirSync(projDir, { recursive: true })

    const startedAt = 6_000_000
    const boundary = writeJsonl(projDir, 'boundary.jsonl', startedAt - 60_000)

    const binder = makeHeuristicBinder({ projectsRoot: root })
    const binding = binder.bindOnce('sess-bnd', cwd, startedAt)
    expect(binding).not.toBeNull()
    void boundary
  })
})
