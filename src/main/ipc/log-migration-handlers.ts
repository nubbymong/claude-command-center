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
import { stripAnsi } from '../logging/ansi-strip'
import { runImport } from '../logging/legacy-log-importer'
import { snapshotLegacyLogs, isLegacyLogsFrozen, markLegacyImportComplete, reclaimLegacyLogs } from '../logging/log-snapshot'
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
      // Snapshot the detected folder count once (the tree is read-only until reclaim,
      // so it is stable for the run) for the report's reconciliation line.
      const detectedFolders = countSessionFolders(dir)
      snapshotLegacyLogs()                                    // 1) one-time read-only snapshot/marker
      const { sessions, unparseable, foldedPartnerDirs, noEventDirs } = parseLegacyLogs(dir)  // 2) pure parse off-DB
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
            events: s.events.map((e) => ({ ts: e.ts, type: e.type, raw: new Uint8Array(Buffer.from(e.data ?? '', 'utf8')), text: stripAnsi(e.data ?? '') })),
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
        foldedPartnerDirs,
        noEventDirs,
        detectedFolders,
        dbBytesBefore: dbBefore,
        dbBytesAfter: dbAfter,
      }
    } finally {
      migrationRunning = false   // A4: always reset, even on throw
    }
  })

  ipcMain.handle(IPC.LOGS_MIGRATE_RECLAIM, async () => {
    // A1 [SAFETY-CRITICAL] belt-and-suspenders: never delete unless the DB actually
    // holds imported sessions. (The frozen + completion-marker(+logsDir) gate lives
    // in reclaimLegacyLogs.) This defends the case where an import wrote nothing.
    const sup = getLogSupervisor()
    if (!sup) throw new Error('refusing to reclaim: logging worker not available')
    const rows = await sup.query('listSessions', { offset: 0, limit: 1 })
    if (!rows.length) throw new Error('refusing to reclaim: no imported sessions in the database')
    const res = reclaimLegacyLogs({
      onFailure: (p, reason) => logWarn(`[migrate] reclaim failed for ${p}: ${reason}`),
    })
    logInfo(`[migrate] reclaimed ${res.deletedFolders} folders (${res.reclaimedBytes} bytes), ${res.failedFolders.length} failed`)
    return res
  })
}
