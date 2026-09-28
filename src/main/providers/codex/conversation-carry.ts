/**
 * A Codex conversation carried into another account's folder (P3.6, row 22).
 *
 * A running session switched to another Codex account keeps its conversation
 * the way Claude's switch does: the conversation's rollout is copied into the
 * new account's sessions folder, and the respawn resumes it there by id
 * (P3.5's resume). P3.1 evidence, answer 1: a rollout copied into another
 * realm's sessions folder, in its own date folder or an older one, is found by
 * its id and resumed by 0.153.4 and 0.155.1.
 *
 * The caller (realm-folders.ts copyConversation) has located both realms from
 * the registry, checked them and holds both realm locks; the accounts service
 * holds a lease on both accounts. This module does the file work only:
 *   - the source is found by P3.5's lookup, in the source realm's sessions
 *     folder only, following no link at any level, its name and its
 *     session_meta agreeing on the id; it is opened and checked to be that
 *     same file (by identity, and still at its own canonical path) before and
 *     after it is read;
 *   - at most `maxBytes` are carried, and only whole lines: a last line still
 *     being written when the copy read it is left out;
 *   - the copy lands at the same place in the destination's sessions folder
 *     (the same date folders, the same name), each folder on the way made
 *     owner-only when absent and required to be a real folder at its own
 *     canonical path;
 *   - it is written to a new temporary file (exclusive create, owner-only),
 *     flushed, checked, then given its final name with a hard link, which
 *     never replaces anything: the file appears whole or not at all;
 *   - a file already at the final name is never changed: the same bytes mean
 *     the conversation is already there; anything else is refused;
 *   - the temporary file is removed on every path, and only while it is still
 *     the file made here.
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { CODEX_CONVERSATION_ID_RE, findCodexRollout, isRealFolder, parseSessionMetaLine, readRolloutFirstLine, sameDirectory } from './rollout-lookup'

/** The most of a rollout the carry copies. A long conversation with large
 *  tool output runs to tens of megabytes; anything past this is refused
 *  rather than copied. */
export const CODEX_CARRY_MAX_BYTES = 256 * 1024 * 1024

/** Bytes read and written per step. */
const CHUNK = 1024 * 1024

const OWNER_ONLY_DIR = 0o700
const OWNER_ONLY_FILE = 0o600

export type CodexCarryCode = 'not-found' | 'exists-different' | 'too-large' | 'unsafe-path' | 'changed' | 'io-failed'
export type CodexCarryResult =
  | { ok: true; carried: 'copied' | 'present'; bytes: number }
  | { ok: false; code: CodexCarryCode }

export interface CodexCarryInput {
  /** The source realm's sessions folder, as the caller located it. */
  fromSessionsDir: string
  /** The destination realm's home, as the caller located it: its
   *  `sessions` folder is made when absent. */
  toHome: string
  /** The conversation id (a canonical UUID). */
  id: string
  /** The directory the session kept, which picks among copies (P3.5). */
  preferCwd?: string
  maxBytes?: number
}

export type CodexConversationCarry = (input: CodexCarryInput) => Promise<CodexCarryResult>

const errCode = (e: unknown): unknown => (e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined)
const fail = (code: CodexCarryCode): CodexCarryResult => ({ ok: false, code })

/** The path is its own canonical path: no link or junction on the way. */
function canonical(p: string): boolean {
  try { return sameDirectory(fs.realpathSync.native(p), p) } catch { return false }
}

/** A real folder (not a link or junction to one) at its own canonical path. */
function realCanonicalFolder(dir: string): boolean {
  return isRealFolder(dir) && canonical(dir)
}

/** `dir`, made owner-only when absent (never through a link), and a real
 *  folder at its own canonical path either way. Its parent is checked by the
 *  caller first. */
function ensureFolder(dir: string): boolean {
  try {
    fs.lstatSync(dir)
  } catch (e) {
    if (errCode(e) !== 'ENOENT') return false
    try { fs.mkdirSync(dir, { mode: OWNER_ONLY_DIR }) } catch (e2) { if (errCode(e2) !== 'EEXIST') return false }
  }
  return realCanonicalFolder(dir)
}

/** The rollout's place below its sessions folder, when it is exactly
 *  `YYYY/MM/DD/rollout-...-<id>.jsonl`; null otherwise. */
function rolloutPlace(sessionsDir: string, file: string, id: string): string[] | null {
  const rel = path.relative(sessionsDir, file)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(/[\\/]+/)
  if (parts.length !== 4) return null
  const [y, m, d, name] = parts
  if (!/^\d{4}$/.test(y) || !/^\d{2}$/.test(m) || !/^\d{2}$/.test(d)) return null
  const lower = name.toLowerCase()
  if (name.length > 200 || !/^[A-Za-z0-9._-]+$/.test(name) || !lower.startsWith('rollout-') || !lower.endsWith(`-${id.toLowerCase()}.jsonl`)) return null
  return parts
}

type Identity = { dev: bigint; ino: bigint }
const sameFile = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino && a.ino !== 0n

/** Whether the two files hold the same `length` bytes. */
async function sameBytes(a: fs.promises.FileHandle, b: fs.promises.FileHandle, length: number): Promise<boolean> {
  const ba = Buffer.alloc(Math.min(CHUNK, Math.max(1, length)))
  const bb = Buffer.alloc(ba.length)
  let at = 0
  while (at < length) {
    const want = Math.min(ba.length, length - at)
    const ra = await a.read(ba, 0, want, at)
    const rb = await b.read(bb, 0, want, at)
    if (ra.bytesRead !== want || rb.bytesRead !== want || !ba.subarray(0, want).equals(bb.subarray(0, want))) return false
    at += want
  }
  return true
}

/**
 * Copy conversation `id`'s rollout from one realm's sessions folder into
 * another realm's, at the same place. See the file header for the rules.
 */
export async function carryCodexRollout(input: CodexCarryInput): Promise<CodexCarryResult> {
  const { fromSessionsDir, toHome, id } = input ?? ({} as CodexCarryInput)
  const max = typeof input?.maxBytes === 'number' && Number.isInteger(input.maxBytes) && input.maxBytes > 0 ? Math.min(input.maxBytes, CODEX_CARRY_MAX_BYTES) : CODEX_CARRY_MAX_BYTES
  if (typeof id !== 'string' || !CODEX_CONVERSATION_ID_RE.test(id)) return fail('not-found')
  if (typeof fromSessionsDir !== 'string' || typeof toHome !== 'string' || !path.isAbsolute(fromSessionsDir) || !path.isAbsolute(toHome)) return fail('unsafe-path')
  if (!realCanonicalFolder(fromSessionsDir)) return fail('not-found')
  if (!realCanonicalFolder(toHome)) return fail('unsafe-path')
  const toSessions = path.join(toHome, 'sessions')
  if (sameDirectory(fromSessionsDir, toSessions)) return fail('unsafe-path')

  // The source: P3.5's lookup, in this realm's own folder only.
  const found = findCodexRollout(fromSessionsDir, id, undefined, input.preferCwd)
  if (!found) return fail('not-found')
  const place = rolloutPlace(fromSessionsDir, found.path, id)
  if (!place) return fail('unsafe-path')
  let before: fs.BigIntStats
  try { before = fs.lstatSync(found.path, { bigint: true }) } catch { return fail('not-found') }
  if (!before.isFile() || before.isSymbolicLink()) return fail('unsafe-path')
  if (before.size > BigInt(max)) return fail('too-large')
  if (!canonical(found.path)) return fail('unsafe-path')

  // The destination's folders, each checked (or made) in turn.
  const dayDir = path.join(toSessions, place[0], place[1], place[2])
  for (const dir of [toSessions, path.join(toSessions, place[0]), path.join(toSessions, place[0], place[1]), dayDir]) {
    if (!ensureFolder(dir)) return fail('unsafe-path')
  }
  const finalPath = path.join(dayDir, place[3])
  const tempPath = path.join(dayDir, `.ccc-carry-${randomBytes(12).toString('hex')}.tmp`)

  let src: fs.promises.FileHandle | null = null
  let tmp: fs.promises.FileHandle | null = null
  let tempMade: Identity | null = null
  /** The temporary file goes, but only while it is still the one made here. */
  const dropTemp = async () => {
    if (!tempMade) return
    try {
      const now = fs.lstatSync(tempPath, { bigint: true })
      if (sameFile(now, tempMade)) await fs.promises.unlink(tempPath)
    } catch { /* already gone */ }
    tempMade = null
  }
  try {
    // Open the source and check it is the file that was looked up.
    try { src = await fs.promises.open(found.path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)) } catch { return fail('changed') }
    const opened = await src.stat({ bigint: true })
    if (!opened.isFile() || !sameFile(opened, before)) return fail('changed')
    const size = Number(opened.size)
    if (size > max) return fail('too-large')

    // The copy: a new file, never anything already there.
    try { tmp = await fs.promises.open(tempPath, 'wx', OWNER_ONLY_FILE) } catch { return fail('io-failed') }
    const madeStat = await tmp.stat({ bigint: true })
    tempMade = { dev: madeStat.dev, ino: madeStat.ino }
    const buf = Buffer.alloc(CHUNK)
    let at = 0
    let lastLineEnd = 0
    while (at < size) {
      const { bytesRead } = await src.read(buf, 0, Math.min(CHUNK, size - at), at)
      if (bytesRead <= 0) break
      const nl = buf.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (nl >= 0) lastLineEnd = at + nl + 1
      let written = 0
      while (written < bytesRead) {
        const w = await tmp.write(buf, written, bytesRead - written, at + written)
        if (w.bytesWritten <= 0) return fail('io-failed')
        written += w.bytesWritten
      }
      at += bytesRead
    }
    // Only whole lines: a last line still being written is left out.
    if (lastLineEnd === 0) return fail('not-found')
    await tmp.truncate(lastLineEnd)
    await tmp.sync()
    await tmp.close()
    tmp = null

    // Still the same source, still at its own canonical path.
    let after: fs.BigIntStats
    try { after = fs.lstatSync(found.path, { bigint: true }) } catch { return fail('changed') }
    if (!sameFile(after, before) || !canonical(found.path)) return fail('changed')
    // The copy is a rollout of this conversation.
    const head = readRolloutFirstLine(tempPath)
    const meta = head && head.kind === 'line' ? parseSessionMetaLine(head.line) : null
    if (!meta || meta.id.toLowerCase() !== id.toLowerCase()) return fail('changed')

    // Its final name: a hard link never replaces anything. Something there
    // already is compared, never changed.
    const settle = async (): Promise<CodexCarryResult> => {
      let there: fs.BigIntStats
      try { there = fs.lstatSync(finalPath, { bigint: true }) } catch { return fail('changed') }
      if (!there.isFile() || there.isSymbolicLink()) return fail('unsafe-path')
      if (Number(there.size) !== lastLineEnd) return fail('exists-different')
      let a: fs.promises.FileHandle | null = null
      let b: fs.promises.FileHandle | null = null
      try {
        a = await fs.promises.open(finalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        b = await fs.promises.open(tempPath, 'r')
        const aStat = await a.stat({ bigint: true })
        if (!sameFile(aStat, there)) return fail('changed')
        return (await sameBytes(a, b, lastLineEnd)) ? { ok: true, carried: 'present', bytes: lastLineEnd } : fail('exists-different')
      } catch {
        return fail('io-failed')
      } finally {
        await a?.close().catch(() => undefined)
        await b?.close().catch(() => undefined)
      }
    }
    try {
      fs.lstatSync(finalPath)
      return await settle()
    } catch (e) {
      if (errCode(e) !== 'ENOENT') return fail('io-failed')
    }
    try {
      await fs.promises.link(tempPath, finalPath)
    } catch (e) {
      return errCode(e) === 'EEXIST' ? await settle() : fail('io-failed')
    }
    // It landed where it was meant to (no folder on the way was swapped for
    // a link since the checks) and it is the file written here; otherwise
    // the name goes again.
    let landed: fs.BigIntStats | null = null
    try { landed = fs.lstatSync(finalPath, { bigint: true }) } catch { landed = null }
    if (!landed || !tempMade || !sameFile(landed, tempMade) || !realCanonicalFolder(dayDir) || !canonical(finalPath)) {
      try { if (landed && tempMade && sameFile(landed, tempMade)) await fs.promises.unlink(finalPath) } catch { /* left for the next attempt */ }
      return fail('changed')
    }
    return { ok: true, carried: 'copied', bytes: lastLineEnd }
  } catch {
    return fail('io-failed')
  } finally {
    await src?.close().catch(() => undefined)
    await tmp?.close().catch(() => undefined)
    await dropTemp()
  }
}
