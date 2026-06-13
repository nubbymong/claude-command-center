/**
 * companion-dir.ts — make direct-work conversations resumable.
 *
 * The Claude CLI stores each conversation as `<projectDir>/<uuid>.jsonl`. It
 * ALSO creates a same-named `<projectDir>/<uuid>/` companion directory — but
 * only LAZILY, the first time that conversation writes a subagent transcript, a
 * workflow transcript, or a large tool-result. A conversation worked on DIRECTLY
 * (no delegation) therefore has the `.jsonl` but NO companion dir.
 *
 * Both CCC's resume picker (scripts/resume-picker.js) and the CLI's own
 * `claude --resume <uuid>` only surface conversations that have a companion dir,
 * so direct-work conversations become invisible and unresumable — the user lost
 * real, critical work to this repeatedly.
 *
 * These helpers fix that by ENSURING the companion dir exists. They are
 * idempotent, additive, and NEVER delete anything (see [[feedback-no-wipe-configs]]).
 * The created shape (`<uuid>/subagents/` + `<uuid>/workflows/`) mirrors the
 * structure the CLI creates itself and matches the manual recovery that was
 * verified to make a previously-dir-less conversation resumable.
 *
 * Pure + dependency-injected: all fs access goes through CompanionDirDeps so the
 * logic is unit-tested against a temp dir (or fakes) without monkey-patching fs.
 * No default export (project convention).
 */
import * as fs from 'fs'
import * as path from 'path'

/** The minimal fs surface these helpers need. Injected for testability. */
export interface CompanionDirDeps {
  existsSync: (p: string) => boolean
  mkdirSync: (p: string, opts: { recursive: boolean }) => void
  readdirSync: (p: string) => string[]
  statSync: (p: string) => { isDirectory: () => boolean }
}

/** Production deps: thin wrappers over node fs. */
export const nodeFsCompanionDeps: CompanionDirDeps = {
  existsSync: (p) => fs.existsSync(p),
  mkdirSync: (p, opts) => { fs.mkdirSync(p, opts) },
  readdirSync: (p) => fs.readdirSync(p),
  statSync: (p) => fs.statSync(p),
}

/**
 * Ensure the companion directory for ONE transcript exists.
 *
 * Creates `<projectDir>/<uuid>/` plus empty `subagents/` and `workflows/`
 * subdirs (a recursive mkdir of each subdir creates the `<uuid>/` parent too).
 *
 * Guarantees:
 *   - ORPHAN-SAFE: only acts when `<projectDir>/<uuid>.jsonl` exists. Never
 *     fabricates a companion dir for a uuid that has no transcript.
 *   - IDEMPOTENT: a no-op when the companion dir already exists; existing
 *     contents are never touched or deleted.
 *   - FAIL-SAFE: any fs error returns false and never throws.
 *
 * Returns true when the companion dir exists as a directory afterwards (created
 * or already present); false when skipped (no transcript / name collides with a
 * file) or on error.
 */
export function ensureCompanionDir(projectDir: string, uuid: string, deps: CompanionDirDeps): boolean {
  try {
    if (!projectDir || !uuid) return false
    const transcript = path.join(projectDir, `${uuid}.jsonl`)
    if (!deps.existsSync(transcript)) return false // never create an orphan dir

    const companion = path.join(projectDir, uuid)
    if (deps.existsSync(companion)) {
      // A stray same-named FILE must never be mkdir'd over (would not pass the
      // picker's directory gate either) — refuse it.
      if (!deps.statSync(companion).isDirectory()) return false
      // Otherwise fall through: recursive mkdir HEALS a partially-created
      // companion dir (a no-op for a subdir already present) so a true return
      // always means both subdirs exist.
    }

    // Create the dir + the two lazily-created subdirs the CLI uses (a recursive
    // mkdir of each subdir creates the `<uuid>/` parent too; never deletes).
    deps.mkdirSync(path.join(companion, 'subagents'), { recursive: true })
    deps.mkdirSync(path.join(companion, 'workflows'), { recursive: true })
    return true
  } catch {
    return false
  }
}

/** Counts returned by {@link backfillCompanionDirs} for logging. */
export interface BackfillResult {
  /** Project folders (immediate subdirs of projectsRoot) examined. */
  projectFolders: number
  /** Total `.jsonl` transcripts examined. */
  scanned: number
  /** Companion dirs created this sweep. */
  created: number
}

/**
 * Idempotent backfill across the whole Claude projects store.
 *
 * For every transcript under `projectsRoot/<mangled-cwd>/<uuid>.jsonl` that
 * lacks a companion dir, create one. Walks each immediate subfolder (one per
 * mangled cwd). Fail-safe at every level — an unreadable folder or file is
 * skipped, never aborting the sweep — and NEVER deletes anything.
 *
 * `projectsRoot` is the canonical `~/.claude/projects` (per-account profile
 * `.claude/projects` dirs are junctions to it, so one sweep covers all accounts).
 */
export function backfillCompanionDirs(projectsRoot: string, deps: CompanionDirDeps): BackfillResult {
  const result: BackfillResult = { projectFolders: 0, scanned: 0, created: 0 }

  let folders: string[]
  try {
    folders = deps.readdirSync(projectsRoot)
  } catch {
    return result // projects store not present yet — nothing to do
  }

  for (const folder of folders) {
    const projectDir = path.join(projectsRoot, folder)
    let isDir = false
    try { isDir = deps.statSync(projectDir).isDirectory() } catch { isDir = false }
    if (!isDir) continue
    result.projectFolders++

    let entries: string[]
    try { entries = deps.readdirSync(projectDir) } catch { continue }

    // Names of entries that are already directories (existing companion dirs).
    const dirNames = new Set<string>()
    for (const e of entries) {
      try { if (deps.statSync(path.join(projectDir, e)).isDirectory()) dirNames.add(e) } catch { /* skip */ }
    }

    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue
      result.scanned++
      const stem = e.slice(0, -'.jsonl'.length)
      if (dirNames.has(stem)) continue // already has a companion dir
      if (ensureCompanionDir(projectDir, stem, deps)) result.created++
    }
  }

  return result
}
