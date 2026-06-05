/**
 * Pure unit test (system Node) for the migration snapshot/marker. Builds a fake
 * logs tree + a fake resources dir under mkdtemp; asserts the snapshot enumerates
 * the source read-only and NEVER mutates it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, statSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  snapshotLegacyLogs,
  isLegacyLogsFrozen,
  markLegacyImportComplete,
  readLegacyImportCompletion,
} from '../../../src/main/logging/log-snapshot'

function snap(dir: string): Record<string, { size: number; mtimeMs: number }> {
  // Capture a recursive {relpath -> size+mtime} fingerprint of `dir` so the test
  // can prove the source is byte-identical before vs after the snapshot call.
  const out: Record<string, { size: number; mtimeMs: number }> = {}
  const walk = (d: string, rel: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(d, ent.name)
      const r = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) walk(abs, r)
      else { const s = statSync(abs); out[r] = { size: s.size, mtimeMs: s.mtimeMs } }
    }
  }
  walk(dir, '')
  return out
}

describe('log-snapshot', () => {
  let root: string
  let logsDir: string
  let resourcesDir: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'logsnap-'))
    logsDir = join(root, 'logs')
    resourcesDir = join(root, 'resources')
    mkdirSync(join(logsDir, 'APP_DEV', 's1'), { recursive: true })
    writeFileSync(join(logsDir, 'APP_DEV', 's1', 'session.jsonl'), '{"ts":1,"type":"start"}\n')
    writeFileSync(join(logsDir, 'APP_DEV', 's1', 'meta.json'), '{"configLabel":"APP_DEV"}')
    mkdirSync(resourcesDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('writes a manifest + FROZEN marker under resources, without touching the source', () => {
    const before = snap(logsDir)
    const result = snapshotLegacyLogs({ logsDir, resourcesDir })
    const after = snap(logsDir)

    // Source byte-identical (no writes, no new files, no deletes).
    expect(after).toEqual(before)

    // A manifest + marker were created under resources.
    expect(result).not.toBeNull()
    const dest = result as string
    expect(existsSync(join(dest, 'manifest.json'))).toBe(true)
    expect(existsSync(join(dest, 'FROZEN'))).toBe(true)
    expect(isLegacyLogsFrozen({ resourcesDir })).toBe(true)

    // Manifest lists the one session file with its size.
    const manifest = JSON.parse(readFileSync(join(dest, 'manifest.json'), 'utf-8'))
    expect(manifest.fileCount).toBe(2) // session.jsonl + meta.json
    expect(manifest.files.some((f: { rel: string }) => f.rel.endsWith('session.jsonl'))).toBe(true)
  })

  it('is idempotent: a second call does not overwrite the first manifest', () => {
    const first = snapshotLegacyLogs({ logsDir, resourcesDir }) as string
    const manifestPath = join(first, 'manifest.json')
    const firstMtime = statSync(manifestPath).mtimeMs
    const second = snapshotLegacyLogs({ logsDir, resourcesDir })
    expect(second).toBeNull() // already snapshotted -> no-op
    expect(statSync(manifestPath).mtimeMs).toBe(firstMtime)
  })

  it('returns null and is frozen=false when there is no logs dir', () => {
    rmSync(logsDir, { recursive: true, force: true })
    expect(snapshotLegacyLogs({ logsDir, resourcesDir })).toBeNull()
    expect(isLegacyLogsFrozen({ resourcesDir })).toBe(false)
  })

  // --- Amendment A1: import-completion marker (gates reclaim) ---

  it('markLegacyImportComplete writes import-complete.json and readLegacyImportCompletion round-trips it', () => {
    const stats = {
      totalSessions: 10,
      importedSessions: 8,
      skippedSessions: 2,
      importedEvents: 1234,
      unparseableCount: 3,
    }
    markLegacyImportComplete({ resourcesDir, logsDir, stats })

    const completion = readLegacyImportCompletion({ resourcesDir })
    expect(completion).not.toBeNull()
    const c = completion!
    expect(c.logsDir).toBe(logsDir)
    expect(c.totalSessions).toBe(10)
    expect(c.importedSessions).toBe(8)
    expect(c.skippedSessions).toBe(2)
    expect(c.importedEvents).toBe(1234)
    expect(c.unparseableCount).toBe(3)
    expect(typeof c.completedAt).toBe('number') // do not assert exact value
  })

  it('creates the snapshot dir if absent when marking completion', () => {
    // No prior snapshotLegacyLogs() call -> snapshot dir does not exist yet.
    const stats = {
      totalSessions: 1,
      importedSessions: 1,
      skippedSessions: 0,
      importedEvents: 5,
      unparseableCount: 0,
    }
    markLegacyImportComplete({ resourcesDir, logsDir, stats })
    expect(readLegacyImportCompletion({ resourcesDir })).not.toBeNull()
  })

  it('a second mark OVERWRITES (refreshes) the completion marker, unlike FROZEN', () => {
    markLegacyImportComplete({
      resourcesDir,
      logsDir,
      stats: { totalSessions: 5, importedSessions: 5, skippedSessions: 0, importedEvents: 50, unparseableCount: 0 },
    })
    const first = readLegacyImportCompletion({ resourcesDir })!

    markLegacyImportComplete({
      resourcesDir,
      logsDir,
      stats: { totalSessions: 7, importedSessions: 6, skippedSessions: 1, importedEvents: 99, unparseableCount: 2 },
    })
    const second = readLegacyImportCompletion({ resourcesDir })!

    // Marker was rewritten with the new stats (contrast with the FROZEN snapshot,
    // which a second snapshotLegacyLogs() call leaves untouched).
    expect(second.totalSessions).toBe(7)
    expect(second.importedSessions).toBe(6)
    expect(second.skippedSessions).toBe(1)
    expect(second.importedEvents).toBe(99)
    expect(second.unparseableCount).toBe(2)
    expect(first.totalSessions).toBe(5) // sanity: the first read captured the old value
  })

  it('readLegacyImportCompletion returns null when no marker exists', () => {
    expect(readLegacyImportCompletion({ resourcesDir })).toBeNull()
  })
})
