/**
 * legacy-log-parser.ts — PURE, off-DB, STREAMING walker + parser for the legacy
 * file logs.
 *
 * Reads <dataDir>/logs/<sanitizedLabel>/<sessionId>/session.jsonl(+.1-.10) and
 * the meta.json sidecar. STRICTLY read-only. No better-sqlite3, no electron
 * import -> importable by BOTH the main process and the logging utilityProcess
 * worker, and testable under plain vitest. No default export.
 *
 * SHAPE (the fix for the 16 GB main-thread freeze):
 *  - `planLegacyGroups(dir)`  — cheap readdir-only pre-pass. Groups every session
 *    dir by BASE session id (so `<id>-partner` dirs and cross-label duplicates
 *    land in one group) in deterministic walk order.
 *  - `streamGroup(group)`     — async generator that parses ONE group at a time,
 *    line-streamed via readline (never readFileSync — single legacy files reach
 *    ~500 MB), yielding bounded event batches. Memory stays ~one batch; the
 *    event loop runs between lines, so a host process stays responsive.
 *  - `parseLegacyLogs(dir)`   — compatibility wrapper that drains the stream into
 *    the old ParseResult shape (tests + small trees only — NEVER call it on a
 *    real-size tree from the main process).
 *
 * Determinism: directory entries are sorted lexicographically before walking, so
 * two runs over the same tree produce identical output and identical reports.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as readline from 'node:readline'

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
   *  detectedFolders === sessions + foldedPartnerDirs + noEventDirs. */
  noEventDirs: number
}

// ── Group plan (readdir-only pre-pass) ───────────────────────────────────────

export interface LegacyGroupMember {
  /** Absolute path of the session dir. */
  dirPath: string
  /** Sanitized label dir name (configLabel fallback when meta.json is absent). */
  label: string
}

/** All on-disk dirs that merge into ONE logical session (base + partner dirs +
 *  cross-label duplicates), members in deterministic walk order. */
export interface LegacyGroup {
  baseId: string
  members: LegacyGroupMember[]
}

/** Messages yielded by streamGroup, in order:
 *  zero-or-one 'meta' (absent when no member has a single valid event), then any
 *  number of bounded 'events' batches, then exactly one terminal 'group-done'. */
export type GroupStreamMsg =
  | {
      kind: 'meta'
      meta: { sessionId: string; configLabel: string; accountEmail?: string; profileId?: string; provider: string }
      /** ts of the first valid event — a begin-time startedAt for the DB row
       *  (the authoritative min lands in group-done.minTs). */
      firstTs: number
    }
  | { kind: 'events'; events: ParsedEvent[] }
  | {
      kind: 'group-done'
      hadEvents: boolean
      /** min/max event ts across the merged group (0 when hadEvents=false). */
      minTs: number
      maxTs: number
      eventCount: number
      unparseable: UnparseableFile[]
      foldedPartnerDirs: number
      noEventDirs: number
    }

const DEFAULT_BATCH_BYTES = 4 * 1024 * 1024

/**
 * Readdir-only pre-pass: group every session dir by base session id, walk-ordered
 * within the group, groups sorted by baseId (matching the old parser's final
 * lexicographic session ordering). Reads NO file contents — fast even on a
 * thousand-session tree, safe to call from any process.
 */
export function planLegacyGroups(logsDir: string): LegacyGroup[] {
  const byBase = new Map<string, LegacyGroupMember[]>()

  let labelDirs: string[]
  try {
    labelDirs = fs.readdirSync(logsDir)
  } catch {
    return []
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
      let members = byBase.get(baseId)
      if (!members) {
        members = []
        byBase.set(baseId, members)
      }
      members.push({ dirPath: sessionDir, label })
    }
  }

  return [...byBase.entries()]
    .map(([baseId, members]) => ({ baseId, members }))
    .sort((a, b) => a.baseId.localeCompare(b.baseId))
}

// ── Per-file streaming parse ─────────────────────────────────────────────────

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

/**
 * Stream-parse one JSONL file, yielding valid events line by line. NEVER buffers
 * the whole file (single legacy files reach ~500 MB). Mutates `out` with the
 * malformed-line count / unreadable flag so the caller can build the same
 * UnparseableFile entries the old whole-file parser produced.
 */
async function* parseFileStream(
  filePath: string,
  out: { skipped: number; unreadable: boolean },
): AsyncGenerator<ParsedEvent> {
  let stream: fs.ReadStream
  let rl: readline.Interface
  try {
    stream = fs.createReadStream(filePath, { encoding: 'utf8' })
    rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  } catch {
    out.unreadable = true
    return
  }
  try {
    for await (const raw of rl) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      try {
        const obj = JSON.parse(trimmed)
        if (obj && typeof obj.ts === 'number' && typeof obj.type === 'string') {
          const ev: ParsedEvent = { ts: obj.ts, type: obj.type }
          if (typeof obj.data === 'string') ev.data = obj.data
          yield ev
        } else {
          out.skipped++
        }
      } catch {
        out.skipped++
      }
    }
  } catch {
    // Stream error mid-read (vanished file, EACCES, ...) — same classification the
    // old readFileSync failure produced. Events already yielded stay yielded (more
    // data preserved, never less).
    out.unreadable = true
  } finally {
    rl.close()
    stream.destroy()
  }
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

// ── Group streaming ──────────────────────────────────────────────────────────

/**
 * Parse ONE group, yielding: 'meta' on the first valid event (taken from THAT
 * member's meta.json — same "first dir with events wins" rule as the old
 * parser), bounded 'events' batches (<= batchBytes of event data each), then a
 * terminal 'group-done' carrying the group's reconciliation tallies.
 *
 * Folding semantics preserved exactly: a member with events that did NOT
 * establish the session counts as foldedPartnerDirs; a member with zero valid
 * events counts as noEventDirs (with a dir-level unparseable entry only when no
 * file-level entry already explains it).
 */
export async function* streamGroup(
  group: LegacyGroup,
  batchBytes: number = DEFAULT_BATCH_BYTES,
): AsyncGenerator<GroupStreamMsg> {
  const unparseable: UnparseableFile[] = []
  let foldedPartnerDirs = 0
  let noEventDirs = 0
  let established = false
  let hadEvents = false
  let minTs = Number.POSITIVE_INFINITY
  let maxTs = Number.NEGATIVE_INFINITY
  let eventCount = 0
  let batch: ParsedEvent[] = []
  let batchSize = 0

  for (const member of group.members) {
    const files = orderedLogFiles(member.dirPath)
    let memberHadEvents = false
    let fileReported = false
    let establishedByThisMember = false

    for (const filePath of files) {
      const out = { skipped: 0, unreadable: false }
      for await (const ev of parseFileStream(filePath, out)) {
        if (!established) {
          established = true
          establishedByThisMember = true
          const meta = readMeta(member.dirPath)
          const m: Extract<GroupStreamMsg, { kind: 'meta' }>['meta'] = {
            sessionId: group.baseId,
            configLabel: meta.configLabel ?? member.label,
            provider: 'claude',
          }
          if (meta.accountEmail !== undefined) m.accountEmail = meta.accountEmail
          if (meta.profileId !== undefined) m.profileId = meta.profileId
          yield { kind: 'meta', meta: m, firstTs: ev.ts }
        }
        memberHadEvents = true
        hadEvents = true
        if (ev.ts < minTs) minTs = ev.ts
        if (ev.ts > maxTs) maxTs = ev.ts
        eventCount += 1
        batch.push(ev)
        batchSize += ev.data ? Buffer.byteLength(ev.data, 'utf8') : 0
        if (batchSize >= batchBytes) {
          yield { kind: 'events', events: batch }
          batch = []
          batchSize = 0
        }
      }
      if (out.unreadable) {
        unparseable.push({ path: filePath, reason: 'unreadable file', skippedLines: 0 })
        fileReported = true
      } else if (out.skipped > 0) {
        unparseable.push({ path: filePath, reason: 'skipped malformed line(s)', skippedLines: out.skipped })
        fileReported = true
      }
    }

    if (!memberHadEvents) {
      // No usable events in this dir. Report the dir ONLY when no file-level entry
      // already explained it, so a single bad file is not double-listed.
      noEventDirs += 1
      if (!fileReported) {
        unparseable.push({ path: member.dirPath, reason: 'no parseable events', skippedLines: 0 })
      }
    } else if (!establishedByThisMember) {
      // Partner (or duplicate) folded into the base: its events were appended
      // after the base's; it yields no separate imported row.
      foldedPartnerDirs += 1
    }
  }

  if (batch.length > 0) yield { kind: 'events', events: batch }
  yield {
    kind: 'group-done',
    hadEvents,
    minTs: hadEvents ? minTs : 0,
    maxTs: hadEvents ? maxTs : 0,
    eventCount,
    unparseable,
    foldedPartnerDirs,
    noEventDirs,
  }
}

// ── Compatibility wrapper ────────────────────────────────────────────────────

/**
 * Drain the streaming API into the old ParseResult shape. Holds every event in
 * memory — tests and small trees ONLY. Production migration goes through
 * planLegacyGroups + streamGroup inside the logging worker.
 */
export async function parseLegacyLogs(logsDir: string): Promise<ParseResult> {
  const groups = planLegacyGroups(logsDir)
  const sessions: ParsedSession[] = []
  const unparseable: UnparseableFile[] = []
  let foldedPartnerDirs = 0
  let noEventDirs = 0

  for (const group of groups) {
    let meta: Extract<GroupStreamMsg, { kind: 'meta' }>['meta'] | null = null
    const events: ParsedEvent[] = []
    for await (const msg of streamGroup(group)) {
      if (msg.kind === 'meta') {
        meta = msg.meta
      } else if (msg.kind === 'events') {
        for (const e of msg.events) events.push(e)
      } else {
        for (const u of msg.unparseable) unparseable.push(u)
        foldedPartnerDirs += msg.foldedPartnerDirs
        noEventDirs += msg.noEventDirs
        if (msg.hadEvents && meta) {
          const out: ParsedSession = {
            sessionId: meta.sessionId,
            configLabel: meta.configLabel,
            provider: meta.provider,
            startedAt: msg.minTs,
            events,
          }
          if (meta.accountEmail !== undefined) out.accountEmail = meta.accountEmail
          if (meta.profileId !== undefined) out.profileId = meta.profileId
          sessions.push(out)
        }
      }
    }
  }

  return { sessions, unparseable, foldedPartnerDirs, noEventDirs }
}
