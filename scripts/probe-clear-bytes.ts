/**
 * probe-clear-bytes.ts — READ-ONLY diagnostic: inspect the tail of a live
 * session's captured events for screen/scrollback-erasing ANSI sequences
 * (ESC[2J, ESC[3J, ESC c) to confirm why the per-session replay renders blank
 * after /clear. WAL read-only connection — safe while the worker writes.
 *
 *   ELECTRON_RUN_AS_NODE=1 <electron> probe.cjs <dbPath> [sessionIdPrefix]
 */
import Database from 'better-sqlite3'

const dbPath = process.argv[2]
const prefix = process.argv[3] ?? ''
if (!dbPath) {
  console.error('usage: probe <dbPath> [sessionIdPrefix]')
  process.exit(1)
}

const db = new Database(dbPath, { readonly: true, fileMustExist: true })

const sessions = db
  .prepare(`SELECT sessionId, status, eventCount, byteSize FROM sessions WHERE sessionId LIKE ? ORDER BY startedAt DESC LIMIT 8`)
  .all(`${prefix}%`) as Array<{ sessionId: string; status: string; eventCount: number; byteSize: number }>

console.log('sessions matching:', sessions)

for (const s of sessions) {
  const rows = db
    .prepare(`SELECT seq, raw FROM events WHERE sessionId = ? ORDER BY seq`)
    .all(s.sessionId) as Array<{ seq: number; raw: Buffer }>
  const counts = { '2J': 0, '3J': 0, RIS: 0, altOn: 0, altOff: 0 }
  let last = ''
  for (const r of rows) {
    const str = r.raw.toString('latin1')
    if (str.includes('\x1b[2J')) { counts['2J']++; last = `2J@${r.seq}` }
    if (str.includes('\x1b[3J')) { counts['3J']++; last = `3J@${r.seq}` }
    if (str.includes('\x1bc')) { counts.RIS++; last = `RIS@${r.seq}` }
    if (str.includes('\x1b[?1049h')) counts.altOn++
    if (str.includes('\x1b[?1049l')) counts.altOff++
  }
  console.log(`[${s.sessionId}] events=${s.eventCount} status=${s.status} erase:`, JSON.stringify(counts), 'lastEraseAt:', last || '-')
}

db.close()
