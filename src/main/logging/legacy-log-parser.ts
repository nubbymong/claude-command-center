/**
 * legacy-log-parser.ts — PURE, off-DB walker + parser for the legacy file logs.
 *
 * Reads <dataDir>/logs/<sanitizedLabel>/<sessionId>/session.jsonl(+.1-.10) and
 * the meta.json sidecar, producing plain ParsedSession data the importer hands
 * to the single logging worker. STRICTLY read-only. No better-sqlite3, no
 * electron import -> testable under plain vitest. No default export.
 *
 * Determinism: directory entries are sorted lexicographically before walking, so
 * two runs over the same tree produce identical output and identical reports.
 */
import * as fs from 'fs'
import * as path from 'path'

export interface ParsedEvent {
  ts: number
  type: 'start' | 'data' | 'restart' | 'switch' | 'end'
  data?: string
}

export interface ParsedSession {
  sessionId: string
  configLabel: string
  accountEmail?: string
  profileId?: string
  provider: string
  startedAt: number
  events: ParsedEvent[]
}

export interface UnparseableFile {
  /** Absolute path of the offending file. */
  path: string
  /** Why it was flagged. */
  reason: string
  /** For partially-parsed files: how many lines were skipped. 0 for whole-file failures. */
  skippedLines: number
}

export interface ParseResult {
  sessions: ParsedSession[]
  unparseable: UnparseableFile[]
  /** Count of folders that folded into an already-seen base session (partner
   *  terminals / duplicates). These contribute no separate imported row, so the
   *  report uses this to reconcile the detected folder count. A 0-event partner
   *  dir does NOT fold (it is listed in `unparseable` instead). */
  foldedPartnerDirs: number
  /** Count of session dirs that had zero valid events (all files malformed or
   *  unreadable). Incremented unconditionally so the report can reconcile:
   *  detectedFolders === sessions + foldedPartnerDirs + noEventDirs.
   *  (A dir-level 'no parseable events' unparseable entry may be suppressed to
   *  avoid double-listing when file-level entries already explain the failure,
   *  which is why this must be counted explicitly rather than inferred from
   *  the unparseable array in the UI.) */
  noEventDirs: number
}

/** Order one session dir's log files chronologically: oldest rotation first
 *  (.10 ... .2 .1) then the live session.jsonl last. Non-matching names ignored. */
function orderedLogFiles(sessionDir: string): string[] {
  let names: string[]
  try {
    names = fs.readdirSync(sessionDir)
  } catch {
    return []
  }
  const rotated: { n: number; name: string }[] = []
  let live: string | null = null
  for (const name of names) {
    if (name === 'session.jsonl') {
      live = name
      continue
    }
    const m = /^session\.jsonl\.(\d+)$/.exec(name)
    if (m) rotated.push({ n: Number(m[1]), name })
  }
  // Higher rotation number = older -> sort DESC so oldest is processed first.
  rotated.sort((a, b) => b.n - a.n)
  const ordered = rotated.map((r) => r.name)
  if (live) ordered.push(live)
  return ordered.map((name) => path.join(sessionDir, name))
}

/** Parse one JSONL file. Pushes valid events onto `events`; returns the count of
 *  malformed lines skipped (so the caller can flag a partially-parsed file). */
function parseFile(filePath: string, events: ParsedEvent[]): number {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return -1 // unreadable -> signal whole-file failure
  }
  let skipped = 0
  for (const raw of content.split('\n')) {
    const trimmed = raw.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj.ts === 'number' && typeof obj.type === 'string') {
        const ev: ParsedEvent = { ts: obj.ts, type: obj.type }
        if (typeof obj.data === 'string') ev.data = obj.data
        events.push(ev)
      } else {
        skipped++
      }
    } catch {
      skipped++
    }
  }
  return skipped
}

function readMeta(sessionDir: string): { configLabel?: string; accountEmail?: string; profileId?: string } {
  try {
    const raw = fs.readFileSync(path.join(sessionDir, 'meta.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Walk the legacy logs tree and return parsed sessions + a list of any files that
 * could not be fully parsed (never dropped silently). `<id>-partner` dirs are
 * folded into their base session id, their events appended after the base events.
 */
export function parseLegacyLogs(logsDir: string): ParseResult {
  const unparseable: UnparseableFile[] = []
  let foldedPartnerDirs = 0
  let noEventDirs = 0
  // Accumulate by BASE session id so partner dirs merge in.
  const byBase = new Map<string, { configLabel: string; accountEmail?: string; profileId?: string; events: ParsedEvent[] }>()

  let labelDirs: string[]
  try {
    labelDirs = fs.readdirSync(logsDir)
  } catch {
    return { sessions: [], unparseable: [], foldedPartnerDirs: 0, noEventDirs: 0 }
  }
  labelDirs.sort((a, b) => a.localeCompare(b))

  for (const label of labelDirs) {
    const labelPath = path.join(logsDir, label)
    let stat: fs.Stats
    try {
      stat = fs.statSync(labelPath)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue

    let sessionDirs: string[]
    try {
      sessionDirs = fs.readdirSync(labelPath)
    } catch {
      continue
    }
    sessionDirs.sort((a, b) => a.localeCompare(b))

    for (const sessionDirName of sessionDirs) {
      const sessionDir = path.join(labelPath, sessionDirName)
      try {
        if (!fs.statSync(sessionDir).isDirectory()) continue
      } catch {
        continue
      }

      const isPartner = sessionDirName.endsWith('-partner')
      const baseId = isPartner ? sessionDirName.slice(0, -'-partner'.length) : sessionDirName

      const files = orderedLogFiles(sessionDir)
      const events: ParsedEvent[] = []
      let anyValid = false
      let fileReported = false // a file-level unparseable entry already explains a failure
      for (const filePath of files) {
        const skipped = parseFile(filePath, events)
        if (skipped < 0) {
          unparseable.push({ path: filePath, reason: 'unreadable file', skippedLines: 0 })
          fileReported = true
        } else if (skipped > 0) {
          unparseable.push({ path: filePath, reason: 'skipped malformed line(s)', skippedLines: skipped })
          fileReported = true
        }
        if (events.length > 0) anyValid = true
      }

      if (!anyValid) {
        // No usable events at all -> do not synthesize a row. Report the session dir
        // ONLY when no file-level entry already explained it (e.g. all lines were
        // empty/whitespace, not malformed), so a single bad file is not double-listed.
        noEventDirs += 1
        if (!fileReported) {
          unparseable.push({ path: sessionDir, reason: 'no parseable events', skippedLines: 0 })
        }
        continue
      }

      const meta = readMeta(sessionDir)
      // configLabel precedence: meta.json (true label) > sanitized dir name.
      const configLabel = meta.configLabel ?? label

      const existing = byBase.get(baseId)
      if (existing) {
        // Partner (or a duplicate) folded into the base: append events; keep the
        // first-seen meta (base dir sorts before its `-partner` sibling). Counted
        // for reconciliation since this folder yields no separate imported row.
        foldedPartnerDirs += 1
        for (const ev of events) existing.events.push(ev)
      } else {
        byBase.set(baseId, {
          configLabel,
          accountEmail: meta.accountEmail,
          profileId: meta.profileId,
          events,
        })
      }
    }
  }

  const sessions: ParsedSession[] = []
  for (const [sessionId, acc] of byBase) {
    // startedAt = earliest event ts (events are appended in chronological file
    // order, so events[0].ts is the earliest for the base; min() is defensive
    // in case a folded partner event predates it).
    let startedAt = acc.events[0].ts
    for (const ev of acc.events) if (ev.ts < startedAt) startedAt = ev.ts
    const out: ParsedSession = {
      sessionId,
      configLabel: acc.configLabel,
      provider: 'claude',
      startedAt,
      events: acc.events,
    }
    if (acc.accountEmail !== undefined) out.accountEmail = acc.accountEmail
    if (acc.profileId !== undefined) out.profileId = acc.profileId
    sessions.push(out)
  }
  // Stable final ordering by sessionId for deterministic reports.
  sessions.sort((a, b) => a.sessionId.localeCompare(b.sessionId))

  return { sessions, unparseable, foldedPartnerDirs, noEventDirs }
}
