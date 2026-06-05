/**
 * legacy-log-importer.ts — main-side orchestration that feeds parsed legacy
 * sessions to the SINGLE live logging worker in bounded chunks, awaiting an ack
 * between chunks so live-capture batches interleave (migration never monopolizes
 * the worker). It owns NO DB connection — all writes happen in the worker via the
 * injected postChunk (the supervisor's migrate()). Native-free; no default export.
 */
import type { ParsedSession } from './legacy-log-parser'

export interface ChunkProgress {
  importedSessions: number
  skippedSessions: number
  /** Sessions whose import THREW (data did NOT reach the DB) — distinct from a
   *  benign already-present skip. Any failure makes the run incomplete. */
  failedSessions: number
  importedEvents: number
}

export interface ImportReport {
  totalSessions: number
  importedSessions: number
  skippedSessions: number
  failedSessions: number
  importedEvents: number
}

export interface RunImportOptions {
  maxSessionsPerChunk?: number
  maxBytesPerChunk?: number
  /** Called after each chunk with (sessionsDone, totalSessions). */
  onProgress?: (done: number, total: number) => void
}

const DEFAULT_MAX_SESSIONS = 25
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

/** Sum the byte cost of a session's events (data string length is a good proxy). */
function sessionBytes(s: ParsedSession): number {
  let n = 0
  for (const e of s.events) n += e.data ? Buffer.byteLength(e.data, 'utf8') : 0
  return n
}

/**
 * Drive the import. `postChunk` posts one chunk to the worker and resolves with
 * that chunk's tally (the supervisor awaits the worker's migrate-progress ack).
 * Chunks are bounded by BOTH a session count and a byte budget so a single chunk
 * can never stall the worker for long. Sessions are imported in their given
 * order (the parser already sorted them deterministically).
 */
export async function runImport(
  sessions: ParsedSession[],
  postChunk: (chunk: ParsedSession[]) => Promise<ChunkProgress>,
  opts?: RunImportOptions,
): Promise<ImportReport> {
  const maxSessions = opts?.maxSessionsPerChunk ?? DEFAULT_MAX_SESSIONS
  const maxBytes = opts?.maxBytesPerChunk ?? DEFAULT_MAX_BYTES

  const report: ImportReport = {
    totalSessions: sessions.length,
    importedSessions: 0,
    skippedSessions: 0,
    failedSessions: 0,
    importedEvents: 0,
  }

  let done = 0
  let i = 0
  while (i < sessions.length) {
    const chunk: ParsedSession[] = []
    let chunkBytes = 0
    while (
      i < sessions.length &&
      chunk.length < maxSessions &&
      // Always include at least one session even if it alone exceeds the budget,
      // so a single huge session is still imported (in its own chunk).
      (chunk.length === 0 || chunkBytes + sessionBytes(sessions[i]) <= maxBytes)
    ) {
      const s = sessions[i]
      chunk.push(s)
      chunkBytes += sessionBytes(s)
      i += 1
    }

    const progress = await postChunk(chunk)
    report.importedSessions += progress.importedSessions
    report.skippedSessions += progress.skippedSessions
    report.failedSessions += progress.failedSessions
    report.importedEvents += progress.importedEvents
    done += chunk.length
    opts?.onProgress?.(done, sessions.length)
  }

  return report
}
