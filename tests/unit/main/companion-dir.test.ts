/**
 * Unit tests for the companion-dir helper (resume-picker bug — CRITICAL).
 *
 * ROOT CAUSE: the Claude CLI only creates a `<uuid>/` companion directory beside
 * a `<uuid>.jsonl` transcript when that conversation spawns a subagent / workflow
 * / large tool-result. A conversation worked on DIRECTLY (no delegation) has the
 * transcript but NO companion dir — and both the resume picker AND `claude
 * --resume <uuid>` only surface conversations that have one. So direct-work
 * conversations become invisible and unresumable (the user lost real work).
 *
 * These helpers make a transcript resumable by ENSURING its companion dir exists,
 * individually (ensureCompanionDir) and across the whole projects store on app
 * launch (backfillCompanionDirs). Both are idempotent, additive, and NEVER delete
 * — see [[feedback-no-wipe-configs]]. Tests run against a real fs temp dir
 * (mkdtemp isolation) using the production node-fs deps.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  ensureCompanionDir,
  backfillCompanionDirs,
  nodeFsCompanionDeps,
  type CompanionDirDeps,
} from '../../../src/main/logging/companion-dir'

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const UUID_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

function seedTranscript(dir: string, uuid: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${uuid}.jsonl`)
  writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n')
  return file
}

// ── ensureCompanionDir ─────────────────────────────────────────────
describe('ensureCompanionDir', () => {
  let projectDir: string
  beforeEach(() => { projectDir = mkdtempSync(join(tmpdir(), 'ccc-companion-')) })
  afterEach(() => { try { rmSync(projectDir, { recursive: true, force: true }) } catch {} })

  it('creates <uuid>/ with subagents/ and workflows/ when the transcript exists and the dir is missing', () => {
    seedTranscript(projectDir, UUID_A)
    const ok = ensureCompanionDir(projectDir, UUID_A, nodeFsCompanionDeps)
    expect(ok).toBe(true)
    expect(statSync(join(projectDir, UUID_A)).isDirectory()).toBe(true)
    expect(statSync(join(projectDir, UUID_A, 'subagents')).isDirectory()).toBe(true)
    expect(statSync(join(projectDir, UUID_A, 'workflows')).isDirectory()).toBe(true)
  })

  it('is idempotent and NEVER deletes existing companion contents', () => {
    seedTranscript(projectDir, UUID_A)
    mkdirSync(join(projectDir, UUID_A, 'subagents'), { recursive: true })
    const marker = join(projectDir, UUID_A, 'subagents', 'agent-keep.jsonl')
    writeFileSync(marker, 'real subagent transcript')
    const ok = ensureCompanionDir(projectDir, UUID_A, nodeFsCompanionDeps)
    expect(ok).toBe(true)
    // existing content untouched
    expect(readFileSync(marker, 'utf-8')).toBe('real subagent transcript')
  })

  it('refuses to create an ORPHAN companion dir when no transcript exists', () => {
    const ok = ensureCompanionDir(projectDir, UUID_A, nodeFsCompanionDeps)
    expect(ok).toBe(false)
    expect(existsSync(join(projectDir, UUID_A))).toBe(false)
  })

  it('heals a partially-created companion dir (adds a missing subdir when the dir already exists)', () => {
    // If an earlier ensure half-completed (e.g. a transient fs error between the
    // two mkdirs), the <uuid>/ dir exists with only one subdir. A later ensure
    // must heal it — recursive mkdir is a no-op for the present subdir. Contract:
    // a true return means BOTH subdirs exist.
    seedTranscript(projectDir, UUID_A)
    mkdirSync(join(projectDir, UUID_A, 'subagents'), { recursive: true }) // workflows missing
    const ok = ensureCompanionDir(projectDir, UUID_A, nodeFsCompanionDeps)
    expect(ok).toBe(true)
    expect(statSync(join(projectDir, UUID_A, 'workflows')).isDirectory()).toBe(true)
  })

  it('returns false when <uuid> exists but is a FILE, not a directory', () => {
    seedTranscript(projectDir, UUID_A)
    writeFileSync(join(projectDir, UUID_A), 'not a dir') // collides with the would-be companion dir name
    const ok = ensureCompanionDir(projectDir, UUID_A, nodeFsCompanionDeps)
    expect(ok).toBe(false)
  })

  it('fails safe (returns false, never throws) when a dep throws', () => {
    seedTranscript(projectDir, UUID_A)
    const throwingDeps: CompanionDirDeps = {
      ...nodeFsCompanionDeps,
      mkdirSync: () => { throw new Error('EACCES') },
    }
    expect(() => ensureCompanionDir(projectDir, UUID_A, throwingDeps)).not.toThrow()
    expect(ensureCompanionDir(projectDir, UUID_A, throwingDeps)).toBe(false)
  })
})

// ── backfillCompanionDirs ──────────────────────────────────────────
describe('backfillCompanionDirs', () => {
  let projectsRoot: string
  beforeEach(() => { projectsRoot = mkdtempSync(join(tmpdir(), 'ccc-backfill-')) })
  afterEach(() => { try { rmSync(projectsRoot, { recursive: true, force: true }) } catch {} })

  it('creates a companion dir for every dir-less transcript across all project folders', () => {
    const projA = join(projectsRoot, 'F--proj-a')
    const projB = join(projectsRoot, 'F--proj-b')
    seedTranscript(projA, UUID_A) // dir-less
    seedTranscript(projA, UUID_B) // will already have a dir
    mkdirSync(join(projA, UUID_B), { recursive: true })
    seedTranscript(projB, UUID_C) // dir-less

    const res = backfillCompanionDirs(projectsRoot, nodeFsCompanionDeps)

    expect(statSync(join(projA, UUID_A)).isDirectory()).toBe(true)
    expect(statSync(join(projB, UUID_C)).isDirectory()).toBe(true)
    expect(res.projectFolders).toBe(2)
    expect(res.scanned).toBe(3)
    expect(res.created).toBe(2) // UUID_B already had a dir
  })

  it('is idempotent: a second run creates nothing and preserves existing contents', () => {
    const projA = join(projectsRoot, 'F--proj-a')
    seedTranscript(projA, UUID_A)
    backfillCompanionDirs(projectsRoot, nodeFsCompanionDeps)
    // drop a marker inside the freshly-created companion dir
    const marker = join(projA, UUID_A, 'subagents', 'marker.txt')
    writeFileSync(marker, 'keep me')

    const res2 = backfillCompanionDirs(projectsRoot, nodeFsCompanionDeps)
    expect(res2.created).toBe(0)
    expect(readFileSync(marker, 'utf-8')).toBe('keep me')
  })

  it('ignores non-.jsonl files and non-directory entries at the root', () => {
    writeFileSync(join(projectsRoot, 'loose-file.txt'), 'x') // not a project folder
    const projA = join(projectsRoot, 'F--proj-a')
    seedTranscript(projA, UUID_A)
    writeFileSync(join(projA, 'notes.md'), 'notes') // not a transcript

    const res = backfillCompanionDirs(projectsRoot, nodeFsCompanionDeps)
    expect(res.projectFolders).toBe(1)
    expect(res.scanned).toBe(1)
    expect(res.created).toBe(1)
    expect(existsSync(join(projA, 'notes'))).toBe(false) // never made a dir for the .md
  })

  it('never clobbers a stray same-named FILE during the sweep (never-wipe invariant)', () => {
    // A file named exactly <uuid> (no extension) sitting beside <uuid>.jsonl must
    // survive the sweep untouched: the dirNames pre-filter only suppresses
    // directory entries, so ensureCompanionDir IS invoked and must refuse via its
    // file-vs-dir guard rather than mkdir over the file. Protects [[feedback-no-wipe-configs]].
    const projA = join(projectsRoot, 'F--proj-a')
    seedTranscript(projA, UUID_A)
    writeFileSync(join(projA, UUID_A), 'a real file, not a companion dir')
    const res = backfillCompanionDirs(projectsRoot, nodeFsCompanionDeps)
    expect(res.scanned).toBe(1)
    expect(res.created).toBe(0)
    expect(statSync(join(projA, UUID_A)).isFile()).toBe(true)
    expect(readFileSync(join(projA, UUID_A), 'utf-8')).toBe('a real file, not a companion dir')
  })

  it('returns zero counts (no throw) when the projects root does not exist', () => {
    const res = backfillCompanionDirs(join(projectsRoot, 'does-not-exist'), nodeFsCompanionDeps)
    expect(res).toEqual({ projectFolders: 0, scanned: 0, created: 0 })
  })

  it('skips an unreadable project folder without aborting the whole sweep', () => {
    const projGood = join(projectsRoot, 'F--good')
    const projBad = join(projectsRoot, 'F--bad')
    seedTranscript(projGood, UUID_A)
    seedTranscript(projBad, UUID_B)
    const badDir = projBad
    const deps: CompanionDirDeps = {
      ...nodeFsCompanionDeps,
      readdirSync: (p: string) => {
        if (p === badDir) throw new Error('EACCES')
        return nodeFsCompanionDeps.readdirSync(p)
      },
    }
    const res = backfillCompanionDirs(projectsRoot, deps)
    // the good folder was still processed
    expect(statSync(join(projGood, UUID_A)).isDirectory()).toBe(true)
    expect(res.created).toBe(1)
  })
})
