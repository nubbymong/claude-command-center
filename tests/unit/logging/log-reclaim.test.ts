/**
 * Pure unit test (system Node) for reclaimLegacyLogs. Builds a temp logs tree +
 * resources dir; proves reclaim REFUSES unless a FROZEN snapshot AND a matching
 * import-completion marker exist (A1), deletes only session DIRECTORIES (leaving a
 * sibling logs.db FILE intact, A7), and reports reclaimed bytes + failedFolders.
 * Never touches real data.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { snapshotLegacyLogs, markLegacyImportComplete, reclaimLegacyLogs } from '../../../src/main/logging/log-snapshot'

let root: string
let logsDir: string
let resourcesDir: string
const STATS = { totalSessions: 2, importedSessions: 2, skippedSessions: 0, importedEvents: 2, unparseableCount: 0 }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reclaim-'))
  logsDir = join(root, 'logs')
  resourcesDir = join(root, 'resources')
  mkdirSync(join(logsDir, 'APP', 's1'), { recursive: true })
  writeFileSync(join(logsDir, 'APP', 's1', 'session.jsonl'), 'x'.repeat(100))
  mkdirSync(join(logsDir, 'APP', 's2'), { recursive: true })
  writeFileSync(join(logsDir, 'APP', 's2', 'session.jsonl'), 'y'.repeat(50))
  mkdirSync(resourcesDir, { recursive: true })
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('reclaimLegacyLogs', () => {
  it('refuses when no FROZEN snapshot marker exists', () => {
    expect(() => reclaimLegacyLogs({ logsDir, resourcesDir })).toThrow(/snapshot|frozen/i)
    expect(existsSync(join(logsDir, 'APP', 's1', 'session.jsonl'))).toBe(true)
  })

  it('refuses when frozen but the import never completed (no completion marker) [A1]', () => {
    snapshotLegacyLogs({ logsDir, resourcesDir }) // FROZEN only
    expect(() => reclaimLegacyLogs({ logsDir, resourcesDir })).toThrow(/complet|import/i)
    expect(existsSync(join(logsDir, 'APP', 's1'))).toBe(true)
  })

  it('refuses when the completion marker was recorded for a different logs dir [A1]', () => {
    snapshotLegacyLogs({ logsDir, resourcesDir })
    markLegacyImportComplete({ resourcesDir, logsDir: join(root, 'OTHER-logs'), stats: STATS })
    expect(() => reclaimLegacyLogs({ logsDir, resourcesDir })).toThrow(/different logs dir/i)
    expect(existsSync(join(logsDir, 'APP', 's1'))).toBe(true)
  })

  it('deletes session folders and reports reclaimed bytes once frozen + import-complete', () => {
    snapshotLegacyLogs({ logsDir, resourcesDir })
    markLegacyImportComplete({ resourcesDir, logsDir, stats: STATS })
    const res = reclaimLegacyLogs({ logsDir, resourcesDir })
    expect(res.deletedFolders).toBe(2)
    expect(res.reclaimedBytes).toBe(150)
    expect(res.failedFolders).toEqual([])
    expect(existsSync(join(logsDir, 'APP', 's1'))).toBe(false)
    expect(existsSync(join(logsDir, 'APP', 's2'))).toBe(false)
  })

  it('leaves a sibling logs.db FILE untouched, deleting only session directories [A7]', () => {
    writeFileSync(join(logsDir, 'logs.db'), 'sqlite-bytes')
    snapshotLegacyLogs({ logsDir, resourcesDir })
    markLegacyImportComplete({ resourcesDir, logsDir, stats: STATS })
    const res = reclaimLegacyLogs({ logsDir, resourcesDir })
    expect(res.deletedFolders).toBe(2)
    expect(existsSync(join(logsDir, 'logs.db'))).toBe(true)
    expect(existsSync(join(logsDir, 'APP', 's1'))).toBe(false)
  })

  it('is safe on an empty/missing logs dir', () => {
    snapshotLegacyLogs({ logsDir, resourcesDir })
    markLegacyImportComplete({ resourcesDir, logsDir, stats: STATS })
    rmSync(logsDir, { recursive: true, force: true })
    const res = reclaimLegacyLogs({ logsDir, resourcesDir })
    expect(res).toEqual({ deletedFolders: 0, reclaimedBytes: 0, failedFolders: [] })
  })
})
