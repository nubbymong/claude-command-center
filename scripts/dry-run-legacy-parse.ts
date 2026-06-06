/**
 * dry-run-legacy-parse.ts — READ-ONLY scale test of the streaming legacy-log
 * parser against a REAL logs tree (the real-data ship gate; see memory
 * feedback_real_data_gate). Drives the exact code the logging worker runs
 * (planLegacyGroups + streamGroup) and reports wall time, peak heap, max
 * event-loop stall, and the reconciliation identity. Writes NOTHING.
 *
 *   npx tsx scripts/dry-run-legacy-parse.ts "C:\Users\you\AppData\Local\Claude Conductor\logs"
 */
import { planLegacyGroups, streamGroup } from '../src/main/logging/legacy-log-parser'

const logsDir = process.argv[2]
if (!logsDir) {
  console.error('usage: npx tsx scripts/dry-run-legacy-parse.ts <logsDir>')
  process.exit(1)
}

// Event-loop stall monitor: a 50ms heartbeat; drift beyond the interval is time
// the loop was blocked (the defect this rewrite fixes was a multi-minute block).
let maxStall = 0
let lastBeat = Date.now()
const stallTimer = setInterval(() => {
  const now = Date.now()
  const drift = now - lastBeat - 50
  if (drift > maxStall) maxStall = drift
  lastBeat = now
}, 50)

let peakHeap = 0
const heapTimer = setInterval(() => {
  const h = process.memoryUsage().heapUsed
  if (h > peakHeap) peakHeap = h
}, 200)

const mb = (n: number) => (n / (1024 * 1024)).toFixed(0)

async function main(): Promise<void> {
  const t0 = Date.now()
  const groups = planLegacyGroups(logsDir)
  const detectedFolders = groups.reduce((n, g) => n + g.members.length, 0)
  console.log(`[plan] ${groups.length} groups / ${detectedFolders} session dirs in ${Date.now() - t0}ms`)

  let sessions = 0
  let events = 0
  let bytes = 0
  let unparseable = 0
  let folded = 0
  let noEvent = 0
  let biggestSessionBytes = 0
  let done = 0

  for (const g of groups) {
    let groupBytes = 0
    for await (const m of streamGroup(g)) {
      if (m.kind === 'events') {
        events += m.events.length
        for (const e of m.events) {
          const b = e.data ? Buffer.byteLength(e.data, 'utf8') : 0
          bytes += b
          groupBytes += b
        }
      } else if (m.kind === 'group-done') {
        if (m.hadEvents) sessions += 1
        unparseable += m.unparseable.length
        folded += m.foldedPartnerDirs
        noEvent += m.noEventDirs
      }
    }
    if (groupBytes > biggestSessionBytes) biggestSessionBytes = groupBytes
    done += 1
    if (done % 100 === 0 || done === groups.length) {
      console.log(
        `[scan] ${done}/${groups.length} | ${mb(bytes)} MB | heap ${mb(process.memoryUsage().heapUsed)} MB (peak ${mb(peakHeap)}) | maxStall ${maxStall}ms`,
      )
    }
  }

  const wallS = ((Date.now() - t0) / 1000).toFixed(1)
  console.log('')
  console.log('=== DRY RUN COMPLETE (read-only) ===')
  console.log(`wall: ${wallS}s | data: ${mb(bytes)} MB | events: ${events.toLocaleString()}`)
  console.log(`sessions: ${sessions} | folded: ${folded} | noEvent: ${noEvent} | unparseable entries: ${unparseable}`)
  console.log(`biggest single session: ${mb(biggestSessionBytes)} MB`)
  console.log(`peak heap: ${mb(peakHeap)} MB | max event-loop stall: ${maxStall}ms`)
  const identity = sessions + folded + noEvent
  console.log(`reconciliation: sessions+folded+noEvent = ${identity} vs detected dirs ${detectedFolders} -> ${identity === detectedFolders ? 'EXACT' : 'MISMATCH'}`)
  if (identity !== detectedFolders) process.exitCode = 2

  clearInterval(stallTimer)
  clearInterval(heapTimer)
}

void main()
