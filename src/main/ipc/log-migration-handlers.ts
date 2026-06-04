/**
 * log-migration-handlers.ts — IPC for the legacy-log migration (Phase 2b).
 * Worker-backed: NEVER imports log-db/log-worker; reaches the single live worker
 * ONLY through getLogSupervisor().migrate(...). Detection + snapshot + reclaim are
 * plain fs over <dataDir>/logs (read-only until reclaim). No default export.
 */
import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../../shared/ipc-channels'
import { getDataDirectory } from '../data-paths'
import { getLogSupervisor } from '../logging/logging-service'
import { parseLegacyLogs } from '../logging/legacy-log-parser'
import { runImport } from '../logging/legacy-log-importer'
import { snapshotLegacyLogs, isLegacyLogsFrozen, markLegacyImportComplete } from '../logging/log-snapshot'
import { logInfo, logWarn } from '../debug-logger'

// A4: module-level reentrancy guard — a double-click must not spawn two runImport loops.
let migrationRunning = false

function legacyLogsDir(): string {
  return path.join(getDataDirectory(), 'logs')
}

/** Cheap count of <label>/<id> session folders under the logs dir. Read-only,
 *  tolerant of a missing/partial tree (returns 0 rather than throwing). */
function countSessionFolders(logsDir: string): number {
  let labels: fs.Dirent[]
  try {
    labels = fs.readdirSync(logsDir, { withFileTypes: true })
  } catch {
    return 0
  }
  let count = 0
  for (const label of labels) {
    if (!label.isDirectory()) continue
    const labelPath = path.join(logsDir, label.name)
    let sessions: fs.Dirent[]
    try {
      sessions = fs.readdirSync(labelPath, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sess of sessions) {
      if (sess.isDirectory()) count += 1
    }
  }
  return count
}

/** Current size of the SQLite log DB file (0 when absent). Used to report the
 *  DB growth a run produced. */
function dbSizeBytes(): number {
  try {
    return fs.statSync(path.join(getDataDirectory(), 'logs.db')).size
  } catch {
    return 0
  }
}

/** Sum the byte size of every regular file directly or recursively under `dir`. */
function dirSizeBytes(dir: string): number {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const ent of entries) {
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      total += dirSizeBytes(abs)
    } else if (ent.isFile()) {
      try {
        total += fs.statSync(abs).size
      } catch {
        // Unreadable file — skip from the tally (it will be force-removed anyway).
      }
    }
  }
  return total
}

export function registerLogMigrationHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.LOGS_MIGRATE_DETECT, async () => {
    const dir = legacyLogsDir()
    const present = fs.existsSync(dir)
    const sessionFolders = present ? countSessionFolders(dir) : 0
    return { present: present && sessionFolders > 0, sessionFolders, frozen: isLegacyLogsFrozen() }
  })

  ipcMain.handle(IPC.LOGS_MIGRATE_RUN, async () => {
    // A4 guard: refuse a concurrent run rather than spawning a second import loop.
    if (migrationRunning) throw new Error('migration already in progress')
    migrationRunning = true
    try {
      const sup = getLogSupervisor()
      if (!sup) throw new Error('logging worker not available (logging disabled?)')
      const dir = legacyLogsDir()
      const dbBefore = dbSizeBytes()
      snapshotLegacyLogs()                                    // 1) one-time read-only snapshot/marker
      const { sessions, unparseable } = parseLegacyLogs(dir)  // 2) pure parse off-DB
      let chunkId = 1
      const report = await runImport(                         // 3) chunked import through the SINGLE worker
        sessions,
        (chunk) => sup.migrate(
          chunk.map((s) => ({
            sessionId: s.sessionId,
            configLabel: s.configLabel,
            accountEmail: s.accountEmail,
            profileId: s.profileId,
            provider: s.provider,
            startedAt: s.startedAt,
            events: s.events.map((e) => ({ ts: e.ts, type: e.type, raw: new Uint8Array(Buffer.from(e.data ?? '', 'utf8')), text: e.data ?? '' })),
          })),
          chunkId++,
        ),
        { onProgress: (done, total) => { try { getWindow()?.webContents.send(IPC.LOGS_MIGRATE_PROGRESS, { done, total }) } catch { /* window gone */ } } },
      )
      const dbAfter = dbSizeBytes()
      // A1 [SAFETY-CRITICAL]: runImport RESOLVED with no throw -> record import
      // completion so reclaim can later be gated on it (Task 8). A re-run where
      // everything skips still means the data is in the DB, so we mark on ANY
      // non-throwing completion. Never written on failure (the throw skips this).
      markLegacyImportComplete({ logsDir: dir, stats: {
        totalSessions: report.totalSessions,
        importedSessions: report.importedSessions,
        skippedSessions: report.skippedSessions,
        importedEvents: report.importedEvents,
        unparseableCount: unparseable.length,
      } })
      logInfo(`[migrate] imported ${report.importedSessions} sessions (${report.importedEvents} events), skipped ${report.skippedSessions}, ${unparseable.length} unparseable`)
      return {
        ...report,
        unparseable: unparseable.map((u) => ({ path: u.path, reason: u.reason, skippedLines: u.skippedLines })),
        dbBytesBefore: dbBefore,
        dbBytesAfter: dbAfter,
      }
    } finally {
      migrationRunning = false   // A4: always reset, even on throw
    }
  })

  // PROVISIONAL reclaim handler — Task 8 will extract reclaimLegacyLogs + harden it
  // (A1 completion+logsDir gate, A5 failedFolders, DB-presence assert). For T5 the
  // basic frozen-guarded inline version is fine. failedFolders is threaded now so
  // the IPC return type is stable.
  ipcMain.handle(IPC.LOGS_MIGRATE_RECLAIM, async () => {
    const dir = legacyLogsDir()
    if (!fs.existsSync(dir)) return { deletedFolders: 0, reclaimedBytes: 0, failedFolders: [] as string[] }
    if (!isLegacyLogsFrozen()) throw new Error('refusing to reclaim: no snapshot marker present')
    let deletedFolders = 0
    let reclaimedBytes = 0
    const failedFolders: string[] = []
    let labels: fs.Dirent[]
    try {
      labels = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return { deletedFolders, reclaimedBytes, failedFolders }
    }
    for (const label of labels) {
      if (!label.isDirectory()) continue
      const labelPath = path.join(dir, label.name)
      let sessions: fs.Dirent[]
      try {
        sessions = fs.readdirSync(labelPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const sess of sessions) {
        if (!sess.isDirectory()) continue
        const sessPath = path.join(labelPath, sess.name)
        const bytes = dirSizeBytes(sessPath)
        try {
          fs.rmSync(sessPath, { recursive: true, force: true })
          deletedFolders += 1
          reclaimedBytes += bytes
        } catch (err) {
          // A5: surface, never swallow — record the folder we could not delete.
          failedFolders.push(sessPath)
          logWarn(`[migrate] reclaim failed for ${sessPath}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      // Remove the now-empty label dir (best-effort: only when truly empty).
      try {
        if (fs.readdirSync(labelPath).length === 0) fs.rmdirSync(labelPath)
      } catch {
        // Non-empty (a folder failed to delete) or already gone — leave it.
      }
    }
    logInfo(`[migrate] reclaimed ${deletedFolders} folders (${reclaimedBytes} bytes)`)
    return { deletedFolders, reclaimedBytes, failedFolders }
  })
}
