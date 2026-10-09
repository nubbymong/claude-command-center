import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, rmSync, symlinkSync, realpathSync } from 'fs'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'

type SpawnFn = (file: string, args: string[], opts: Record<string, unknown>) => { status: number | null; stdout?: string; error?: Error }

// The picker is plain Node.js (CommonJS) and guards main() behind
// `require.main === module`, so require()-ing it here imports only the pure
// helpers without running the interactive picker.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const picker = require('../../../scripts/resume-picker.js') as {
  encodeProjectPath: (p: string) => string
  resolveProjectDir: (claudeProjectsDir: string, cwd: string, realpath?: (p: string) => string) => string | null
  parseWorktrees: (text: string) => Array<{ path: string; branch: string | null; isMain: boolean }>
  listWorktrees: (
    cwd: string,
    platform?: string,
    deps?: { spawn?: SpawnFn; env?: Record<string, string | undefined>; isFile?: (p: string) => boolean },
  ) => Array<{ path: string; branch: string | null; isMain: boolean }>
  resolveClaudeCmd: (platform?: string, env?: Record<string, string | undefined>, isFile?: (p: string) => boolean) => string | null
  buildSpawnTarget: (cmd: string, args: string[], platform?: string, env?: Record<string, string | undefined>) =>
    { file: string; argv: string[]; verbatim: boolean; env?: Record<string, string | undefined> } | null
  notStartedMessage: (cmd: string | null, args: string[], env?: Record<string, string | undefined>) => string
  launchSpec: (cmd: string | null, args: string[], base: Record<string, unknown>, platform?: string, env?: Record<string, string | undefined>) =>
    { file: string; argv: string[]; opts: Record<string, unknown>; message?: undefined } | { message: string }
  launchClaude: (resumeId: string | undefined, sourceCwd: string | undefined, deps: {
    spawn: SpawnFn; exit: (code: number) => void; argv: string[]; env: Record<string, string | undefined>; platform: string; isFile: (p: string) => boolean
  }) => void
  worktreeLabelFor: (wt: { path: string; branch: string | null; isMain: boolean }) => string | null
  scanWorktreeConversations: (
    wt: { path: string; branch: string | null; isMain: boolean },
    claudeProjectsDir: string,
  ) => Array<{ sessionId: string; mtime: number; size: number; filePath: string; sourceCwd: string; worktreeLabel: string | null; firstMessage: string | null; aiTitle: string | null; lastPrompt: string | null; lastMessages: string[] }>
  mergeAndLabel: (
    conversationsBySource: Array<Array<{ mtime: number; filePath: string }>>,
    cap?: number,
  ) => Array<{ mtime: number; filePath: string }>
  ensureCompanionDir: (projectDir: string, uuid: string) => boolean
  computeLayoutWidth: (columns: number | undefined) => number
  loadWorkNames: (configDir: string | undefined) => Map<string, string>
  readSidecarName: (transcriptFilePath: string) => string | null
  sanitizeMessageText: (raw: unknown) => string | null
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

  // P3.16a round 2 (Q1): Claude Code cuts a name longer than 200 characters at
  // 200 and adds a hash of the whole folder; the picker's copy of the rule
  // matches the shared one (src/shared/project-key.ts) and Claude Code's.
  it('a folder whose name is longer than 200 characters: cut at 200 with the hash Claude Code adds', () => {
    expect(picker.encodeProjectPath('C:\\Users\\jane\\' + 'a'.repeat(190))).toBe('C--Users-jane-' + 'a'.repeat(186) + '-vwg8id')
    expect(picker.encodeProjectPath('/tmp/' + 'x'.repeat(196))).toBe('-tmp-' + 'x'.repeat(195) + '-diaimx')
    expect(picker.encodeProjectPath('/tmp/' + 'x'.repeat(195))).toBe('-tmp-' + 'x'.repeat(195))
  })
})

// -- resolveProjectDir: the real path, as the app names it --
// PR-level ADR-009 round 1 (A3): Claude Code names a projects folder from the
// real path of the folder it runs in, and so does the app
// (transcript-discovery.ts claudeProjectDirName: fs.realpathSync, the JS one,
// and the folder as given when that cannot be read). The picker looks the
// folder up the same way, so a launch folder reached through a link or a
// junction finds the conversations Claude Code wrote.
describe('resume-picker resolveProjectDir (the real path)', () => {
  const PREFIX = 'ccc-rp-realpath-'
  let base: string
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), PREFIX)) })
  afterEach(() => {
    // Only the folder this test made, by its own prefix, in the folder it was made in.
    if (basename(base).startsWith(PREFIX) && dirname(base) === tmpdir()) rmSync(base, { recursive: true, force: true })
  })

  it('names the folder by its real path; one whose real path cannot be read keeps its own spelling', () => {
    const projects = join(base, 'projects')
    mkdirSync(join(projects, picker.encodeProjectPath('/work/real-project')), { recursive: true })
    mkdirSync(join(projects, picker.encodeProjectPath('/work/gone')), { recursive: true })
    const realOf = (p: string) => (p === '/work/linked-project' ? '/work/real-project' : p)
    expect(picker.resolveProjectDir(projects, '/work/linked-project', realOf)).toBe(join(projects, picker.encodeProjectPath('/work/real-project')))
    const unreadable = (_p: string): string => { throw new Error('ENOENT') }
    expect(picker.resolveProjectDir(projects, '/work/gone', unreadable)).toBe(join(projects, picker.encodeProjectPath('/work/gone')))
  })

  it('the real file system: a launch folder through a junction (Windows) or a link finds the folder named for its target', (ctx) => {
    const real = join(base, 'real-project')
    const link = join(base, 'linked-project')
    mkdirSync(real)
    // A temp volume that cannot hold the link: skipped, never passed. ENOENT and
    // EEXIST are this test's own setup going wrong, so they fail it.
    let linked = false
    try {
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir')
      linked = true
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EEXIST') throw err
    }
    if (!linked) return ctx.skip()
    const projects = join(base, 'projects')
    const named = picker.encodeProjectPath(realpathSync(real))
    mkdirSync(join(projects, named), { recursive: true })
    expect(picker.encodeProjectPath(link).toLowerCase()).not.toBe(named.toLowerCase())
    expect(picker.resolveProjectDir(projects, link)).toBe(join(projects, named))
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
    // Outside a repository git exits 128 with nothing on stdout → single-source
    // fallback. git, PATH and the file check are injected: nothing starts.
    const calls: string[][] = []
    const out = picker.listWorktrees('C:\\not-a-repo', 'win32', {
      env: { PATH: 'C:\\Git\\cmd' },
      isFile: () => true,
      spawn: (_file, args) => { calls.push(args); return { status: 128, stdout: '' } },
    })
    expect(calls).toEqual([['--no-pager', '-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain']])
    expect(out).toEqual([{ path: 'C:\\not-a-repo', branch: null, isMain: true }])
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

  it('surfaces ai-title + last-prompt; a command-only first message is skipped (#130)', () => {
    const wtPath = join(projectsDir, '..', 'titled-repo')
    const dir = join(projectsDir, picker.encodeProjectPath(wtPath))
    mkdirSync(dir, { recursive: true })
    const uuid = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
    const lines = [
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'wire up the release notes' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Add changelog infrastructure' }),
      // First user message is a pure slash command → sanitized to null, skipped.
      JSON.stringify({ type: 'user', message: { content: '<command-name>/compact</command-name><command-message>compact</command-message>' } }),
      JSON.stringify({ type: 'user', message: { content: 'now do the AGENTS.md migration' } }),
    ]
    const pad = JSON.stringify({ type: 'file-history-snapshot', data: 'x'.repeat(200) })
    for (let i = 0; i < 200; i++) lines.push(pad)
    writeFileSync(join(dir, `${uuid}.jsonl`), lines.join('\n') + '\n')
    const out = picker.scanWorktreeConversations({ path: wtPath, branch: 'main', isMain: true }, projectsDir)
    expect(out).toHaveLength(1)
    expect(out[0].aiTitle).toBe('Add changelog infrastructure')
    expect(out[0].lastPrompt).toBe('wire up the release notes')
    // The first *clean* user message wins for firstMessage (command-only skipped).
    expect(out[0].firstMessage).toBe('now do the AGENTS.md migration')
  })

  it('firstMessage is null when the head has no clean user text (→ display falls back)', () => {
    const wtPath = join(projectsDir, '..', 'nofirst-repo')
    const dir = join(projectsDir, picker.encodeProjectPath(wtPath))
    mkdirSync(dir, { recursive: true })
    const uuid = 'ffffffff-ffff-ffff-ffff-ffffffffffff'
    const lines = [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Only a title here' }),
      JSON.stringify({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }),
    ]
    const pad = JSON.stringify({ type: 'system', message: 'x'.repeat(200) })
    for (let i = 0; i < 200; i++) lines.push(pad)
    writeFileSync(join(dir, `${uuid}.jsonl`), lines.join('\n') + '\n')
    const out = picker.scanWorktreeConversations({ path: wtPath, branch: 'main', isMain: true }, projectsDir)
    expect(out).toHaveLength(1)
    expect(out[0].firstMessage).toBeNull()
    expect(out[0].aiTitle).toBe('Only a title here')
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
  it('renders to the real interface width (no artificial 120 clamp)', () => {
    expect(picker.computeLayoutWidth(200)).toBe(196) // cols - 4, wide window
    expect(picker.computeLayoutWidth(100)).toBe(96)
  })

  it('floors at 60 for a narrow terminal', () => {
    expect(picker.computeLayoutWidth(40)).toBe(60)
    expect(picker.computeLayoutWidth(10)).toBe(60)
  })

  it('caps at a 400-col sanity bound for pathological widths', () => {
    expect(picker.computeLayoutWidth(10000)).toBe(400)
  })

  it('falls back to 80 columns when width is unknown (→ 76)', () => {
    expect(picker.computeLayoutWidth(undefined)).toBe(76)
    expect(picker.computeLayoutWidth(0)).toBe(76)
  })
})

// ── sanitizeMessageText (#130: strip command/system XML) ────────────
describe('resume-picker sanitizeMessageText', () => {
  it('drops a pure slash-command invocation entirely (→ null)', () => {
    const raw = '<command-name>/compact</command-name><command-message>compact</command-message>'
    expect(picker.sanitizeMessageText(raw)).toBeNull()
  })

  it('strips command markup but keeps surrounding prose', () => {
    const raw = 'before <command-message>running foo</command-message> after'
    expect(picker.sanitizeMessageText(raw)).toBe('before after')
  })

  it('strips command-args, local-command output, and system-reminder blocks', () => {
    expect(picker.sanitizeMessageText('<command-args>--flag x</command-args>real')).toBe('real')
    expect(picker.sanitizeMessageText('keep<local-command-stdout>noise</local-command-stdout>')).toBe('keep')
    expect(picker.sanitizeMessageText('<system-reminder>be nice</system-reminder>fix the bug')).toBe('fix the bug')
  })

  it('strips a local-command-caveat block (real-world head noise)', () => {
    expect(picker.sanitizeMessageText('<local-command-caveat>Caveat: messages below were generated…</local-command-caveat>the real ask')).toBe('the real ask')
  })

  it('removes leftover unpaired wrapper tags and collapses whitespace', () => {
    expect(picker.sanitizeMessageText('a  <command-message>\n\n b')).toBe('a b')
  })

  it('is fail-safe for non-strings and empties', () => {
    expect(picker.sanitizeMessageText(undefined)).toBeNull()
    expect(picker.sanitizeMessageText(123)).toBeNull()
    expect(picker.sanitizeMessageText('   ')).toBeNull()
  })

  it('leaves normal prose untouched (whitespace-collapsed)', () => {
    expect(picker.sanitizeMessageText('Fix the login redirect loop')).toBe('Fix the login redirect loop')
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

// ── readSidecarName (#536: name carried onto the transcript) ─────────
describe('resume-picker readSidecarName', () => {
  let dir: string
  const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccc-sidecar-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
  const transcript = () => join(dir, `${UUID}.jsonl`)
  const sidecar = () => join(dir, `${UUID}.ccc-name.json`)

  it('reads the trimmed name from <uuid>.ccc-name.json beside the transcript', () => {
    writeFileSync(sidecar(), JSON.stringify({ name: '  aai-core | INSIGHTS FU  ', updatedAt: 1 }), 'utf-8')
    expect(picker.readSidecarName(transcript())).toBe('aai-core | INSIGHTS FU')
  })

  it('fail-safe: missing sidecar, bad JSON, blank name, or non-.jsonl path → null', () => {
    expect(picker.readSidecarName(transcript())).toBeNull()          // no sidecar
    writeFileSync(sidecar(), '{ not json', 'utf-8')
    expect(picker.readSidecarName(transcript())).toBeNull()          // bad JSON
    writeFileSync(sidecar(), JSON.stringify({ name: '   ' }), 'utf-8')
    expect(picker.readSidecarName(transcript())).toBeNull()          // blank
    expect(picker.readSidecarName(join(dir, 'notes.txt'))).toBeNull() // not a transcript
  })
})

// ── Programs from PATH's folders ───────────────────────────────────
// git and Claude Code are run only from the folders PATH names: by a full
// path, without a shell, never looked up in the project folder. Everything
// here is injected (PATH, the file check, the spawn); nothing is started.
describe('git and Claude Code are run only from the folders PATH names', () => {
  // No process may start in this block: a lookup that tried one fails here.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('child_process') as typeof import('child_process')
  const spies: Array<{ mockRestore: () => void }> = []
  beforeEach(() => {
    for (const name of ['execSync', 'execFileSync', 'exec', 'execFile'] as const) {
      spies.push(vi.spyOn(cp, name).mockImplementation((() => { throw new Error('no process may start here') }) as never))
    }
  })
  afterEach(() => { while (spies.length) spies.pop()!.mockRestore() })

  const PORCELAIN = 'worktree C:\\proj\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree C:\\proj-wt\\feature\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feature\n\n'
  const run = (env: Record<string, string | undefined>, isFile: (p: string) => boolean, platform = 'win32', result: { status: number | null; stdout?: string; error?: Error } = { status: 0, stdout: PORCELAIN }) => {
    const calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }> = []
    const spawn: SpawnFn = (file, args, opts) => { calls.push({ file, args, opts }); return result }
    const out = picker.listWorktrees(platform === 'win32' ? 'C:\\proj' : '/proj', platform, { spawn, env, isFile })
    return { calls, out }
  }

  it('starts git by its full path from a folder PATH names, without a shell, and never from the project folder', () => {
    // Every candidate "exists": only the folder rule decides which one runs.
    const { calls, out } = run({ Path: '.;rel\\bin;%GITDIR%\\cmd; "C:\\Git\\cmd" ;C:\\Other', NoDefaultCurrentDirectoryInExePath: '0', nodefaultcurrentdirectoryinexepath: '', KEEP: 'kept' }, () => true)
    expect(calls).toHaveLength(1)
    expect(calls[0].file).toBe('C:\\Git\\cmd\\git.exe')
    expect(calls[0].args).toEqual(['--no-pager', '-c', 'core.fsmonitor=false', 'worktree', 'list', '--porcelain'])
    expect(calls[0].opts.shell).toBe(false)
    expect(calls[0].opts.cwd).toBe('C:\\proj')
    const env = calls[0].opts.env as Record<string, string>
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH')).toEqual(['NoDefaultCurrentDirectoryInExePath'])
    expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(env.KEEP).toBe('kept')
    expect(out.map((w) => w.path)).toEqual(['C:\\proj', 'C:\\proj-wt\\feature'])
  })

  it('reads PATH the way Windows starts a program from it: a share, either slash, a trailing dot dropped', () => {
    expect(run({ PATH: 'C:\\tools.\\bin.;D:\\x' }, (p) => p === 'C:\\tools\\bin\\git.exe').calls[0].file).toBe('C:\\tools\\bin\\git.exe')
    expect(run({ PATH: '\\\\srv\\share\\git' }, (p) => p === '\\\\srv\\share\\git\\git.exe').calls[0].file).toBe('\\\\srv\\share\\git\\git.exe')
    expect(run({ PATH: 'C:/Git/cmd' }, (p) => p.toLowerCase() === 'c:\\git\\cmd\\git.exe').calls[0].file).toBe('C:\\Git\\cmd\\git.exe')
    // Not folders a lookup reads: a lone server name, the device namespace, a drive-relative name,
    // and a folder named through a variable that was never expanded.
    expect(run({ PATH: '\\\\srv;\\\\?\\C:\\Git;\\\\.\\C:\\Git;C:Git;\\Git;C:\\%GITDIR%\\cmd' }, () => true).calls).toEqual([])
    expect(picker.resolveClaudeCmd('win32', { PATH: 'C:\\%NPM%;C:\\npm' }, () => true)).toBe('C:\\npm\\claude.exe')
  })

  it('with no git in PATH\'s folders, or a git that fails, it falls back to the one folder and starts nothing else', () => {
    const none = run({ PATH: 'C:\\Git\\cmd' }, () => false)
    expect(none.calls).toEqual([])
    expect(none.out).toEqual([{ path: 'C:\\proj', branch: null, isMain: true }])
    const failed = run({ PATH: 'C:\\Git\\cmd' }, () => true, 'win32', { status: 128, stdout: '' })
    expect(failed.calls).toHaveLength(1)
    expect(failed.out).toEqual([{ path: 'C:\\proj', branch: null, isMain: true }])
    // A file check that throws (a share that does not answer) is "not there".
    expect(run({ PATH: '\\\\down\\share;C:\\Git\\cmd' }, (p) => { if (p.startsWith('\\\\')) throw new Error('unreachable'); return true }).calls[0].file).toBe('C:\\Git\\cmd\\git.exe')
  })

  it('elsewhere: an absolute folder only, and the environment passed on as it is', () => {
    const { calls } = run({ PATH: 'bin:./tools::/usr/bin', HOME: '/home/jo' }, () => true, 'linux')
    expect(calls[0].file).toBe('/usr/bin/git')
    expect(calls[0].opts.shell).toBe(false)
    expect(calls[0].opts.env).toEqual({ PATH: 'bin:./tools::/usr/bin', HOME: '/home/jo' })
  })

  it('elsewhere: a git file the user may not run is passed over, as the system\'s own lookup does', () => {
    // The file checks are answered here: nothing on disk is read.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeFs = require('fs') as typeof import('fs')
    const stat = vi.spyOn(nodeFs, 'statSync').mockImplementation(((p: string) => ({ isFile: () => p === '/a/git' || p === '/b/git' })) as never)
    const access = vi.spyOn(nodeFs, 'accessSync').mockImplementation(((p: string) => {
      if (p === '/a/git') throw Object.assign(new Error('not allowed'), { code: 'EACCES' })
    }) as never)
    try {
      const calls: string[] = []
      picker.listWorktrees('/proj', 'linux', { env: { PATH: '/a:/b' }, spawn: (file) => { calls.push(file); return { status: 0, stdout: '' } } })
      expect(calls).toEqual(['/b/git'])
      expect(access).toHaveBeenCalledWith('/b/git', nodeFs.constants.X_OK)
    } finally {
      stat.mockRestore()
      access.mockRestore()
    }
  })

  it('finds Claude Code in PATH\'s folders: the native claude.exe in any of them first, then claude.cmd', () => {
    const files = new Set(['C:\\npm\\claude.cmd', 'C:\\native\\claude.exe', 'C:\\proj\\claude.exe'])
    const isFile = (p: string) => files.has(p)
    expect(picker.resolveClaudeCmd('win32', { Path: '.;C:\\npm;C:\\native' }, isFile)).toBe('C:\\native\\claude.exe')
    expect(picker.resolveClaudeCmd('win32', { Path: '.;C:\\npm' }, isFile)).toBe('C:\\npm\\claude.cmd')
    // None there: no bare name to fall back on; the launch refuses, visibly.
    expect(picker.resolveClaudeCmd('win32', { Path: '.;relative;%X%' }, isFile)).toBeNull()
    expect(picker.resolveClaudeCmd('win32', {}, () => true)).toBeNull()
    // Elsewhere the name, as before.
    expect(picker.resolveClaudeCmd('darwin', { PATH: '/usr/bin' }, () => false)).toBe('claude')
  })

  it('finds Claude Code without starting anything', () => {
    expect(picker.resolveClaudeCmd('win32', { PATH: 'C:\\native' }, (p) => p === 'C:\\native\\claude.exe')).toBe('C:\\native\\claude.exe')
    expect(cp.execSync).not.toHaveBeenCalled()
    expect(cp.execFileSync).not.toHaveBeenCalled()
    const src = readFileSync(join(__dirname, '..', '..', '..', 'scripts', 'resume-picker.js'), 'utf-8')
    expect(src).not.toMatch(/execSync\s*\(/)
    expect(src).not.toMatch(/['"`]where[\s'"`]/)
    expect(src).not.toMatch(/spawnSync\(\s*['"`]git['"`]/)
  })

  it('an npm claude.cmd runs with the same rule, so the programs it starts by name come from PATH\'s folders', () => {
    const t = picker.buildSpawnTarget('C:\\npm\\claude.cmd', ['--model', 'opus'], 'win32', { SystemRoot: 'C:\\Windows', NODEFAULTCURRENTDIRECTORYINEXEPATH: '0', KEEP: 'kept' })!
    expect(Object.keys(t.env!).filter((k) => k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH')).toEqual(['NoDefaultCurrentDirectoryInExePath'])
    expect(t.env!.NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(t.env!.KEEP).toBe('kept')
    // The native binary starts as it is, with the environment it inherits.
    expect(picker.buildSpawnTarget('C:\\native\\claude.exe', ['--model', 'opus'], 'win32', { SystemRoot: 'C:\\Windows' })!.env).toBeUndefined()
  })

  // Both launches -- the first, and the fresh one after a resume that fails --
  // run exactly what one launch step returns. The spawn and the exit are
  // injected: nothing starts and nothing exits.
  const RESUME = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const NPM_ENV = { SystemRoot: 'C:\\Windows', Path: 'C:\\npm', NODEFAULTCURRENTDIRECTORYINEXEPATH: '0', KEEP: 'kept' }
  const npmOnly = (p: string) => p === 'C:\\npm\\claude.cmd'
  const BASE = { stdio: 'inherit', shell: false, windowsHide: false }
  type Launched = { calls: Array<{ file: string; args: string[]; opts: Record<string, unknown> }>; exits: number[]; said: string }
  const launch = (o: { resumeId?: string; statuses?: number[]; argv?: string[]; env: Record<string, string | undefined>; isFile: (p: string) => boolean }): Launched => {
    const calls: Launched['calls'] = []
    const exits: number[] = []
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      picker.launchClaude(o.resumeId, undefined, {
        spawn: (file, args, opts) => { calls.push({ file, args, opts }); return { status: (o.statuses ?? [])[calls.length - 1] ?? 0 } },
        exit: (code) => { exits.push(code) },
        argv: o.argv ?? ['--model', 'opus'],
        env: o.env,
        platform: 'win32',
        isFile: o.isFile,
      })
      return { calls, exits, said: err.mock.calls.map((c) => String(c[0])).join('\n') }
    } finally {
      err.mockRestore()
      log.mockRestore()
    }
  }

  it('one launch step decides the program, its arguments and its options, or what the launch says instead', () => {
    const base = { ...BASE, cwd: 'C:\\proj-wt\\feature' }
    const shim = picker.launchSpec('C:\\npm\\claude.cmd', ['--model', 'opus'], base, 'win32', NPM_ENV)
    expect('file' in shim && shim.file).toBe('C:\\Windows\\System32\\cmd.exe')
    const opts = (shim as { opts: Record<string, unknown> }).opts
    expect(opts).toMatchObject({ ...base, windowsVerbatimArguments: true })
    expect((opts.env as Record<string, string>).NoDefaultCurrentDirectoryInExePath).toBe('1')
    expect(base).toEqual({ ...BASE, cwd: 'C:\\proj-wt\\feature' })
    expect(picker.launchSpec('C:\\native\\claude.exe', ['--model', 'opus'], base, 'win32', NPM_ENV))
      .toEqual({ file: 'C:\\native\\claude.exe', argv: ['--model', 'opus'], opts: { ...base, windowsVerbatimArguments: false } })
    expect(picker.launchSpec(null, ['--model', 'opus'], base, 'win32', NPM_ENV)).toEqual({ message: picker.notStartedMessage(null, ['--model', 'opus'], NPM_ENV) })
    expect((picker.launchSpec('C:\\npm\\claude.cmd', ['--model', '1%'], base, 'win32', NPM_ENV) as { message: string }).message).toContain('the value of --model holds')
  })

  it('an npm claude.cmd starts with the rule in its environment, on the first launch and on the fresh one after a resume fails', () => {
    const { calls, exits } = launch({ resumeId: RESUME, statuses: [1, 0], env: NPM_ENV, isFile: npmOnly })
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.file).toBe('C:\\Windows\\System32\\cmd.exe')
      expect(c.opts).toMatchObject({ ...BASE, windowsVerbatimArguments: true })
      const env = c.opts.env as Record<string, string>
      expect(Object.keys(env).filter((k) => k.toUpperCase() === 'NODEFAULTCURRENTDIRECTORYINEXEPATH')).toEqual(['NoDefaultCurrentDirectoryInExePath'])
      expect(env.NoDefaultCurrentDirectoryInExePath).toBe('1')
      expect(env.KEEP).toBe('kept')
    }
    expect(calls[0].args).toEqual(['/d', '/v:off', '/s', '/c', `""C:\\npm\\claude.cmd" "--resume" "${RESUME}" "--model" "opus""`])
    expect(calls[1].args).toEqual(['/d', '/v:off', '/s', '/c', '""C:\\npm\\claude.cmd" "--model" "opus""'])
    expect(exits).toEqual([0])
  })

  it('the native claude.exe starts as it is, with the environment it inherits', () => {
    const { calls, exits } = launch({ env: { SystemRoot: 'C:\\Windows', Path: 'C:\\npm;C:\\native' }, isFile: (p) => p === 'C:\\native\\claude.exe' || npmOnly(p) })
    expect(calls).toEqual([{ file: 'C:\\native\\claude.exe', args: ['--model', 'opus'], opts: { ...BASE, windowsVerbatimArguments: false } }])
    expect(exits).toEqual([0])
  })

  it('the launch refuses, visibly, when Claude Code is not in PATH\'s folders: nothing starts', () => {
    const { calls, exits, said } = launch({ env: { SystemRoot: 'C:\\Windows', Path: '.;relative;C:\\npm' }, isFile: () => false })
    expect(calls).toEqual([])
    expect(exits).toEqual([1])
    expect(said).toContain('Not starting Claude Code: it was not found in a folder PATH names')
  })

  it('an argument the npm route cannot pass stops the launch before anything starts, and says which', () => {
    const { calls, exits, said } = launch({ env: NPM_ENV, isFile: npmOnly, argv: ['--agents', JSON.stringify([{ name: 'coverage', prompt: 'cover 100%' }])] })
    expect(calls).toEqual([])
    expect(exits).toEqual([1])
    expect(said).toContain('Not starting Claude Code: the agent template "coverage" holds a % sign')
  })
})
