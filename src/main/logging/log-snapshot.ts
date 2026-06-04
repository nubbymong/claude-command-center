/**
 * log-snapshot.ts — one-time, read-only safety snapshot/marker taken before the
 * legacy-log migration. STRICTLY read-only on the source logs dir: it enumerates
 * <dataDir>/logs recursively and records each file's size+mtime into a manifest
 * under <resources>/claude-config-backups/logs-migration/, plus a FROZEN marker
 * the importer/reclaim consult. It NEVER writes, renames, or deletes anything
 * under the logs dir. Idempotent: once the manifest exists it is left untouched.
 *
 * It also writes an import-completion marker (import-complete.json) recording the
 * exact logsDir that was imported + the run's stats. Unlike the FROZEN snapshot
 * (which proves "snapshot taken" and is never overwritten), the completion marker
 * proves "import succeeded" and is rewritten on every successful run; the reclaim
 * safety gate consults it (frozen AND completion.logsDir === resolved logsDir).
 *
 * No better-sqlite3, no electron import (so it stays bundle-safe and testable).
 * No default export (project convention).
 */
import * as fs from 'fs'
import * as path from 'path'
import { getDataDirectory, getResourcesDirectory } from '../data-paths'

interface SnapshotEntry {
  rel: string
  size: number
  mtimeMs: number
}

/** Stats recorded alongside the import-completion marker. */
export interface LegacyImportStats {
  totalSessions: number
  importedSessions: number
  skippedSessions: number
  importedEvents: number
  unparseableCount: number
}

/** Shape of the parsed import-complete.json marker. */
export interface LegacyImportCompletion extends LegacyImportStats {
  completedAt: number
  logsDir: string
}

function snapshotDir(resourcesDir: string): string {
  return path.join(resourcesDir, 'claude-config-backups', 'logs-migration')
}

/** True once a snapshot has been taken (the FROZEN marker exists). */
export function isLegacyLogsFrozen(opts?: { resourcesDir?: string }): boolean {
  const resourcesDir = opts?.resourcesDir ?? getResourcesDirectory()
  return fs.existsSync(path.join(snapshotDir(resourcesDir), 'FROZEN'))
}

/** Recursively enumerate `dir` in a stable order, collecting size+mtime only. */
function enumerate(dir: string, rel: string, out: SnapshotEntry[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const ent of entries) {
    const abs = path.join(dir, ent.name)
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      enumerate(abs, r, out)
    } else if (ent.isFile()) {
      try {
        const s = fs.statSync(abs)
        out.push({ rel: r, size: s.size, mtimeMs: s.mtimeMs })
      } catch {
        // Unreadable file — skip from the manifest (the parser will also report it).
      }
    }
  }
}

/**
 * Take the one-time snapshot. Returns the snapshot dir path on first run, or null
 * if there is no logs dir to snapshot OR a snapshot already exists (idempotent).
 * Params injectable for tests.
 */
export function snapshotLegacyLogs(opts?: { logsDir?: string; resourcesDir?: string }): string | null {
  const logsDir = opts?.logsDir ?? path.join(getDataDirectory(), 'logs')
  const resourcesDir = opts?.resourcesDir ?? getResourcesDirectory()
  const dest = snapshotDir(resourcesDir)

  if (!fs.existsSync(logsDir)) return null
  if (fs.existsSync(path.join(dest, 'FROZEN'))) return null // already snapshotted -> never overwrite

  const files: SnapshotEntry[] = []
  enumerate(logsDir, '', files)

  const totalBytes = files.reduce((n, f) => n + f.size, 0)
  const manifest = {
    takenAt: Date.now(),
    sourceDir: logsDir,
    fileCount: files.length,
    totalBytes,
    files,
  }

  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'manifest.json'), JSON.stringify(manifest), 'utf-8')
  // FROZEN marker, written LAST so a crash mid-write never leaves a half-marker
  // that would fool isLegacyLogsFrozen into thinking the snapshot is complete.
  fs.writeFileSync(path.join(dest, 'FROZEN'), `frozen ${new Date(manifest.takenAt).toISOString()}\n`, 'utf-8')
  return dest
}

/**
 * Record that a legacy-log import RAN TO COMPLETION over `logsDir`. Writes
 * <snapshotDir>/import-complete.json = { completedAt, logsDir, ...stats }. Unlike
 * the FROZEN snapshot this is REWRITTEN on every successful run (a re-run refreshes
 * it). Creates the snapshot dir if absent. The reclaim safety gate reads this back
 * and only permits deletion when the recorded logsDir matches the live one.
 * Params injectable for tests.
 */
export function markLegacyImportComplete(opts: {
  resourcesDir?: string
  logsDir: string
  stats: LegacyImportStats
}): void {
  const resourcesDir = opts.resourcesDir ?? getResourcesDirectory()
  const dest = snapshotDir(resourcesDir)
  const marker: LegacyImportCompletion = {
    completedAt: Date.now(),
    logsDir: opts.logsDir,
    totalSessions: opts.stats.totalSessions,
    importedSessions: opts.stats.importedSessions,
    skippedSessions: opts.stats.skippedSessions,
    importedEvents: opts.stats.importedEvents,
    unparseableCount: opts.stats.unparseableCount,
  }
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'import-complete.json'), JSON.stringify(marker), 'utf-8')
}

/**
 * Read back the import-completion marker, or null if it is absent or unparseable.
 * Params injectable for tests.
 */
export function readLegacyImportCompletion(opts?: { resourcesDir?: string }): LegacyImportCompletion | null {
  const resourcesDir = opts?.resourcesDir ?? getResourcesDirectory()
  try {
    const raw = fs.readFileSync(path.join(snapshotDir(resourcesDir), 'import-complete.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    // Minimal shape check (completedAt + logsDir) — the writer controls the schema;
    // callers that read the stats fields are responsible for their own checks.
    if (parsed && typeof parsed === 'object' && typeof parsed.completedAt === 'number' && typeof parsed.logsDir === 'string') {
      return parsed as LegacyImportCompletion
    }
    return null
  } catch {
    return null
  }
}
