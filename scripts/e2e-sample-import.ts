/**
 * e2e-sample-import.ts — END-TO-END scale test of the worker-internal streaming
 * migration (runDirMigration: plan -> stream -> partial-import -> SQLite) against
 * the BIGGEST real legacy sessions, into a THROWAWAY database. The real tree is
 * touched read-only (via directory junctions); the temp DB is deleted afterwards.
 * Part of the real-data ship gate (memory: feedback_real_data_gate).
 *
 * MUST run under Electron-as-Node (better-sqlite3 is electron-rebuilt):
 *   ELECTRON_RUN_AS_NODE=1 <electron> node_modules/tsx/dist/cli.mjs scripts/e2e-sample-import.ts <realLogsDir> [topN]
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { openLogDb } from '../src/main/logging/log-db'
import { runDirMigration } from '../src/main/logging/log-worker'
import type { FromWorker } from '../src/main/logging/log-worker-transport'

const realLogsDir = process.argv[2]
const topN = Number(process.argv[3] ?? 2)
if (!realLogsDir) {
  console.error('usage: ... scripts/e2e-sample-import.ts <realLogsDir> [topN]')
  process.exit(1)
}

function dirSizeBytes(dir: string): number {
  let total = 0
  try {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isFile()) {
        try { total += fs.statSync(path.join(dir, ent.name)).size } catch { /* skip */ }
      }
    }
  } catch { /* unreadable */ }
  return total
}

const mb = (n: number) => (n / (1024 * 1024)).toFixed(0)

async function main(): Promise<void> {
  // 1) Find the top-N biggest session dirs in the real tree (read-only scan).
  const candidates: Array<{ label: string; name: string; dirPath: string; bytes: number }> = []
  for (const label of fs.readdirSync(realLogsDir)) {
    const labelPath = path.join(realLogsDir, label)
    if (!fs.statSync(labelPath).isDirectory()) continue
    for (const name of fs.readdirSync(labelPath)) {
      const dirPath = path.join(labelPath, name)
      try {
        if (!fs.statSync(dirPath).isDirectory()) continue
      } catch { continue }
      candidates.push({ label, name, dirPath, bytes: dirSizeBytes(dirPath) })
    }
  }
  candidates.sort((a, b) => b.bytes - a.bytes)
  const picks = candidates.slice(0, topN)
  console.log('[pick] biggest sessions:')
  for (const p of picks) console.log(`  ${mb(p.bytes)} MB  ${p.label}/${p.name}`)

  // 2) Junction them into a temp tree (read-only view of the real dirs).
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-import-'))
  const tmpTree = path.join(tmpRoot, 'logs')
  for (const p of picks) {
    const labelDir = path.join(tmpTree, p.label)
    fs.mkdirSync(labelDir, { recursive: true })
    fs.symlinkSync(p.dirPath, path.join(labelDir, p.name), 'junction')
  }

  // 3) Throwaway DB next to the repo (F: has space), never the real one.
  const dbPath = path.join(tmpRoot, 'throwaway-logs.db')
  const db = openLogDb(dbPath)

  let peakHeap = 0
  const heapTimer = setInterval(() => {
    const h = process.memoryUsage().heapUsed
    if (h > peakHeap) peakHeap = h
  }, 200)

  const posted: FromWorker[] = []
  const t0 = Date.now()
  await runDirMigration(db, { id: 1, logsDir: tmpTree }, (m) => {
    posted.push(m)
    if (m.type === 'migrate-dir-progress') {
      console.log(`[progress] ${m.done}/${m.total} | heap ${mb(process.memoryUsage().heapUsed)} MB`)
    }
    if (m.type === 'log') console.log(`[worker-log] ${m.entry.level}: ${m.entry.message}`)
  })
  const wallS = ((Date.now() - t0) / 1000).toFixed(1)
  clearInterval(heapTimer)

  const done = posted.find((p) => p.type === 'migrate-dir-done') as Extract<FromWorker, { type: 'migrate-dir-done' }> | undefined
  if (!done) {
    console.error('NO DONE REPORT — posted:', posted.map((p) => p.type))
    process.exitCode = 2
  } else {
    const r = done.report
    console.log('')
    console.log('=== E2E SAMPLE IMPORT COMPLETE (throwaway DB) ===')
    console.log(`wall: ${wallS}s | imported: ${r.importedSessions} sessions / ${r.importedEvents.toLocaleString()} events | failed: ${r.failedSessions}`)
    console.log(`peak heap: ${mb(peakHeap)} MB`)
    const sessions = db.listSessions({ limit: 50 })
    for (const s of sessions) {
      console.log(`  [db] ${s.sessionId}: ${s.eventCount.toLocaleString()} events, ${mb(s.byteSize)} MB, status=${s.status}`)
    }
    const dbBytes = fs.statSync(dbPath).size
    console.log(`db size: ${mb(dbBytes)} MB`)
    if (r.failedSessions > 0 || r.importedSessions !== picks.length) process.exitCode = 2
  }

  db.close()
  // 4) Clean up: temp junctions + throwaway DB. rmSync on a junction removes the
  // LINK, never the target (verified Node behaviour for dir junctions).
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  console.log('[cleanup] temp tree + throwaway DB removed')
}

void main()
