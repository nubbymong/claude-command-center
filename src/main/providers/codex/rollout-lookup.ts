/**
 * Where a Codex conversation's rollout is (P3.5, rows 34 and 38).
 *
 * Codex writes each conversation to `<CODEX_HOME>/sessions/YYYY/MM/DD/
 * rollout-<local time>-<id>.jsonl`, and a resume APPENDS to that original
 * file, in its original date folder (P3.1 evidence, answer 2). So a resumed
 * conversation from an earlier day is never in today's folder: it is found by
 * its id, wherever it is. And a new one is looked for in more than one day
 * folder: the file name is local time and which date the folder follows is not
 * proven, so a session that crosses midnight UTC, or starts between midnight
 * UTC and local midnight, has its rollout in a folder other than "today, UTC".
 *
 * Only the realm's own sessions folder is ever read (realms never cross), only
 * real folders are walked (a link or junction inside it is not followed), every
 * walk is bounded, and only a file's first line (its session_meta) is read,
 * bounded too. A file is the conversation's only when its name ends in the id
 * AND its session_meta says the same id.
 */
import * as fs from 'fs'
import * as path from 'path'
import { isHomeOrAncestor } from '../../path-utils'

/** A conversation id as Codex writes it and as a launch may name it: the
 *  canonical UUID form, the same one the spawn schema requires of a resume
 *  id (src/main/ipc/pty-handlers.ts) and the picker's isResumeId. */
export const CODEX_CONVERSATION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** The most of a rollout's first line that is read: a session_meta line
 *  carries the base instructions (about 22 KB on 0.133), well under this. */
export const CODEX_ROLLOUT_HEAD_MAX_BYTES = 1024 * 1024

/** The most folder entries one lookup by id visits (years, months, days and
 *  the files in each day), and the most day folders it opens. */
export const CODEX_LOOKUP_MAX_ENTRIES = 100_000
export const CODEX_LOOKUP_MAX_DAYS = 3_660

/** A rollout's first line, read up to the first newline: `line`; `partial`
 *  while it is still being written (no newline yet: read it again later);
 *  `too-long` when it runs past the bound (it never will be a session_meta
 *  this app reads). Null when the file cannot be read just now. */
export type RolloutFirstLine = { kind: 'line'; line: string } | { kind: 'partial' } | { kind: 'too-long' }
export function readRolloutFirstLine(file: string): RolloutFirstLine | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(file, 'r')
    const chunk = Buffer.alloc(64 * 1024)
    const parts: Buffer[] = []
    let total = 0
    while (total < CODEX_ROLLOUT_HEAD_MAX_BYTES) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, CODEX_ROLLOUT_HEAD_MAX_BYTES - total), total)
      if (n <= 0) return { kind: 'partial' }
      const nl = chunk.subarray(0, n).indexOf(0x0a)
      if (nl >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, nl)))
        return { kind: 'line', line: Buffer.concat(parts).toString('utf-8') }
      }
      parts.push(Buffer.from(chunk.subarray(0, n)))
      total += n
    }
    return { kind: 'too-long' }
  } catch {
    return null
  } finally {
    if (fd !== null) { try { fs.closeSync(fd) } catch { /* already closed */ } }
  }
}

export interface RolloutSessionMeta {
  id: string
  cwd: string
  /** The session_meta record's time, epoch ms (NaN when absent). */
  at: number
  model: string
  cliVersion: string
  timestamp: string
}

/** The session_meta of a rollout's first line, or null when it is not one. */
export function parseSessionMetaLine(line: string): RolloutSessionMeta | null {
  try {
    const evt = JSON.parse(line) as Record<string, unknown>
    if (!evt || evt.type !== 'session_meta' || !evt.payload || typeof evt.payload !== 'object') return null
    const p = evt.payload as Record<string, unknown>
    const timestamp = String(evt.timestamp ?? '')
    return {
      id: String(p.id ?? ''),
      cwd: String(p.cwd ?? ''),
      at: new Date(timestamp).getTime(),
      model: String(p.model ?? ''),
      cliVersion: String(p.cli_version ?? ''),
      timestamp,
    }
  } catch {
    return null
  }
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** The day folders a rollout written at any of `times` may be in: each
 *  time's UTC date and local date. Recomputed by the caller on every poll,
 *  so the set follows midnight. */
export function codexDayFolders(sessionsDir: string, times: readonly number[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of times) {
    const d = new Date(t)
    if (!Number.isFinite(d.getTime())) continue
    for (const [y, m, day] of [
      [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()],
      [d.getFullYear(), d.getMonth() + 1, d.getDate()],
    ]) {
      const folder = path.join(sessionsDir, String(y), pad2(m), pad2(day))
      if (!seen.has(folder)) { seen.add(folder); out.push(folder) }
    }
  }
  return out
}

/** The real sub-folders of `dir` whose names match `re`, newest name first. */
function subFolders(dir: string, re: RegExp, budget: { entries: number }): string[] {
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  budget.entries -= entries.length
  // A Dirent describes the entry itself: a link or junction is not a directory.
  return entries.filter((e) => e.isDirectory() && re.test(e.name)).map((e) => e.name).sort().reverse()
}

export interface FoundRollout {
  path: string
  meta: RolloutSessionMeta
}

/**
 * The rollout of conversation `id` in this realm's sessions folder, wherever
 * it is: newest date folder first, bounded (CODEX_LOOKUP_MAX_ENTRIES,
 * CODEX_LOOKUP_MAX_DAYS). The file must be a plain file named
 * `rollout-...-<id>.jsonl` whose session_meta says the same id. Null when
 * the id is not a conversation id, or no such rollout is found.
 */
export function findCodexRollout(sessionsDir: string, id: string): FoundRollout | null {
  if (typeof id !== 'string' || !CODEX_CONVERSATION_ID_RE.test(id)) return null
  if (typeof sessionsDir !== 'string' || !sessionsDir) return null
  const want = id.toLowerCase()
  const suffix = `-${want}.jsonl`
  const budget = { entries: CODEX_LOOKUP_MAX_ENTRIES }
  let days = 0
  for (const year of subFolders(sessionsDir, /^\d{4}$/, budget)) {
    for (const month of subFolders(path.join(sessionsDir, year), /^\d{2}$/, budget)) {
      for (const day of subFolders(path.join(sessionsDir, year, month), /^\d{2}$/, budget)) {
        if (budget.entries <= 0 || ++days > CODEX_LOOKUP_MAX_DAYS) return null
        const dayDir = path.join(sessionsDir, year, month, day)
        let files: fs.Dirent[]
        try { files = fs.readdirSync(dayDir, { withFileTypes: true }) } catch { continue }
        budget.entries -= files.length
        for (const f of files) {
          const name = f.name.toLowerCase()
          if (!f.isFile() || !name.startsWith('rollout-') || !name.endsWith(suffix)) continue
          const file = path.join(dayDir, f.name)
          const head = readRolloutFirstLine(file)
          if (!head || head.kind !== 'line') continue
          const meta = parseSessionMetaLine(head.line)
          if (meta && meta.id.toLowerCase() === want) return { path: file, meta }
        }
      }
    }
  }
  return null
}

/** Two spellings of one directory, as far as a string can tell: resolved, and
 *  case-folded on Windows. */
export function sameDirectory(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (!a || !b) return false
  const api = platform === 'win32' ? path.win32 : path.posix
  const norm = (p: string): string => {
    const r = api.resolve(p)
    return platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

export interface CodexResumeTarget {
  uuid: string
  cwd: string
}

export interface ResolvedCodexResume {
  /** The conversation to resume, as its rollout names it. */
  resumeId: string
  /** Where the CLI starts: the conversation's own directory, else the configured one. */
  cwd: string
}

/**
 * Whether a launch can resume `target` exactly, and where (Claude's
 * resolveResumeLaunch, for Codex). The id must be a conversation id and its
 * rollout must be in THIS realm's sessions folder (the launch's own; a
 * conversation of another account is never resumed here). The CLI starts in
 * the conversation's own directory -- `target.cwd` -- only when that is the
 * directory the rollout itself records, still exists as a directory, and is
 * not the home folder or above it (unless it is the configured directory
 * itself); otherwise in the configured directory, where `codex resume <id>`
 * still finds it (a resume by id is not tied to a directory, unlike
 * `claude --resume`). Null: no exact resume (the launch starts fresh).
 */
export function resolveCodexResume(
  target: CodexResumeTarget | undefined | null,
  ctx: { sessionsDir: string; configuredCwd: string; dirExists?: (p: string) => boolean; homeOrAbove?: (p: string) => boolean },
): ResolvedCodexResume | null {
  try {
    if (!target || typeof target.uuid !== 'string' || !CODEX_CONVERSATION_ID_RE.test(target.uuid)) return null
    const found = findCodexRollout(ctx.sessionsDir, target.uuid)
    if (!found) return null
    const dirExists = ctx.dirExists ?? ((p: string) => { try { return fs.statSync(p).isDirectory() } catch { return false } })
    const homeOrAbove = ctx.homeOrAbove ?? isHomeOrAncestor
    const own = typeof target.cwd === 'string' ? target.cwd : ''
    const usable = !!own && path.isAbsolute(own) && sameDirectory(own, found.meta.cwd) && dirExists(own)
      && (sameDirectory(own, ctx.configuredCwd) || !homeOrAbove(own))
    return { resumeId: found.meta.id, cwd: usable ? path.resolve(own) : ctx.configuredCwd }
  } catch {
    return null
  }
}
