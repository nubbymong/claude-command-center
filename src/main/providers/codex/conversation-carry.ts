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
 * holds a lease on both accounts, and the session's own process has ended
 * (the carry runs in main's respawn, between the kill and the spawn). This
 * module does the file work only:
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
 *   - it is written to a new temporary file in the destination's sessions
 *     folder (exclusive create, owner-only), flushed, checked, then given its
 *     final name with a hard link, which never replaces anything: the file
 *     appears whole or not at all, and one that landed anywhere but the
 *     realm's own folder (a folder on the way swapped for a link after the
 *     checks) is taken back;
 *   - a file already at the final name is never replaced: the same bytes mean
 *     the conversation is already there (`present`); an earlier copy of it
 *     that is exactly the start of this one (the session was on that account
 *     before: A -> B -> A) has the lines said since added to it, in place,
 *     through a handle checked to be that file in the realm's own folder
 *     (`extended`); anything else went its own way there and is refused;
 *   - the temporary file is removed on every path, and one a carry that
 *     stopped part way left behind is removed by the next carry into that
 *     realm once it is stale (by its own name and age: see sweepStaleTemps).
 * A volume that reports no file ids cannot show that a file is the one
 * checked, so every identity compare fails closed there and nothing is
 * carried to one.
 */
import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { CODEX_CONVERSATION_ID_RE, findCodexRollout, isRealFolder, parseSessionMetaLine, readRolloutFirstLine, sameDirectory } from './rollout-lookup'

/** The most of a rollout the carry copies. A long conversation with large
 *  tool output runs to tens of megabytes; anything past this is refused
 *  rather than copied. */
export const CODEX_CARRY_MAX_BYTES = 256 * 1024 * 1024

/** How old a carry's temporary file must be before a later carry takes it for
 *  one a stopped carry left. A copy of the largest rollout takes seconds and
 *  keeps its file's time moving; another copy of the app carrying into the
 *  same folder (this computer's own Codex sign-in, which both may use) is
 *  never cut short. */
export const CODEX_CARRY_STALE_TEMP_MS = 15 * 60 * 1000

/** Bytes read and written per step. */
const CHUNK = 1024 * 1024

/** Entries of a sessions folder the sweep looks at (it holds year folders). */
const SWEEP_MAX_ENTRIES = 10_000

const OWNER_ONLY_DIR = 0o700
const OWNER_ONLY_FILE = 0o600

/** A carry's temporary file: this module's own naming, and nothing else. */
const TEMP_PREFIX = '.ccc-carry-'
const TEMP_NAME_RE = /^\.ccc-carry-[0-9a-f]{24}\.tmp$/

export type CodexCarryCode = 'not-found' | 'exists-different' | 'too-large' | 'unsafe-path' | 'changed' | 'io-failed'
export type CodexCarryResult =
  | { ok: true; carried: 'copied' | 'present' | 'extended'; bytes: number }
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
/** A file id the volume reported. One that reports 0 gives nothing to
 *  compare: identity is unknown there, and never taken as a match. */
const idKnown = (a: Identity) => a.ino !== 0n
const sameFile = (a: Identity, b: Identity) => idKnown(a) && idKnown(b) && a.dev === b.dev && a.ino === b.ino

/** The file at `p` is `st`, a plain file, at its own canonical path. */
function stillAt(p: string, st: Identity): boolean {
  try {
    const now = fs.lstatSync(p, { bigint: true })
    return now.isFile() && !now.isSymbolicLink() && sameFile(now, st) && canonical(p)
  } catch {
    return false
  }
}

/**
 * Carry temporary files a carry that stopped part way (the app ended mid-copy)
 * left in a realm's sessions folder: this module's own naming only, a plain
 * file, not changed for CODEX_CARRY_STALE_TEMP_MS. Judged by name and age,
 * never by file id, so a volume that reports none is swept too. The caller
 * holds the realm's lock, so no carry of this app is writing one now.
 */
function sweepStaleTemps(sessionsDir: string, now: number): void {
  let names: string[]
  try { names = fs.readdirSync(sessionsDir) } catch { return }
  for (const name of names.slice(0, SWEEP_MAX_ENTRIES)) {
    if (!TEMP_NAME_RE.test(name)) continue
    const p = path.join(sessionsDir, name)
    try {
      const st = fs.lstatSync(p)
      if (!st.isFile() || st.isSymbolicLink() || now - st.mtimeMs < CODEX_CARRY_STALE_TEMP_MS) continue
      fs.unlinkSync(p)
    } catch { /* gone meanwhile, or not removable: the next carry looks again */ }
  }
}

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

/** Bytes [from, to) of `src` written to `dst` at the same offsets. */
async function copyRange(src: fs.promises.FileHandle, dst: fs.promises.FileHandle, from: number, to: number): Promise<boolean> {
  const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, to - from)))
  let at = from
  while (at < to) {
    const { bytesRead } = await src.read(buf, 0, Math.min(buf.length, to - at), at)
    if (bytesRead <= 0) return false
    let written = 0
    while (written < bytesRead) {
      const w = await dst.write(buf, written, bytesRead - written, at + written)
      if (w.bytesWritten <= 0) return false
      written += w.bytesWritten
    }
    at += bytesRead
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

  // The destination's folders, each checked (or made) in turn; what a
  // stopped carry left in its sessions folder goes first.
  if (!ensureFolder(toSessions)) return fail('unsafe-path')
  sweepStaleTemps(toSessions, Date.now())
  const dayDir = path.join(toSessions, place[0], place[1], place[2])
  for (const dir of [path.join(toSessions, place[0]), path.join(toSessions, place[0], place[1]), dayDir]) {
    if (!ensureFolder(dir)) return fail('unsafe-path')
  }
  const finalPath = path.join(dayDir, place[3])
  const tempPath = path.join(toSessions, `${TEMP_PREFIX}${randomBytes(12).toString('hex')}.tmp`)

  let src: fs.promises.FileHandle | null = null
  let tmp: fs.promises.FileHandle | null = null
  let tempMade: Identity | null = null
  /** The temporary file goes, but only while it is still the one made here:
   *  by its file id, or, where the volume reports none, by its own random
   *  name (made exclusively, in a folder checked to be the realm's). */
  const dropTemp = async () => {
    const made = tempMade
    tempMade = null
    if (!made) return
    try {
      const now = fs.lstatSync(tempPath, { bigint: true })
      if (idKnown(made) ? sameFile(now, made) : now.isFile() && !now.isSymbolicLink()) await fs.promises.unlink(tempPath)
    } catch { /* already gone */ }
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
    // Without a file id what lands cannot be told from anything else.
    if (!idKnown(tempMade)) return fail('unsafe-path')
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

    // Something already at the final name is never replaced: the same bytes
    // are present; an earlier copy that is exactly the start of this one is
    // brought up to date in place; anything else went its own way there.
    const settle = async (): Promise<CodexCarryResult> => {
      let there: fs.BigIntStats
      try { there = fs.lstatSync(finalPath, { bigint: true }) } catch { return fail('changed') }
      if (!there.isFile() || there.isSymbolicLink()) return fail('unsafe-path')
      const have = Number(there.size)
      if (have > lastLineEnd) return fail('exists-different')
      let a: fs.promises.FileHandle | null = null
      let b: fs.promises.FileHandle | null = null
      try {
        const noFollow = fs.constants.O_NOFOLLOW ?? 0
        a = await fs.promises.open(finalPath, (have === lastLineEnd ? fs.constants.O_RDONLY : fs.constants.O_RDWR) | noFollow)
        b = await fs.promises.open(tempPath, 'r')
        // The file this handle holds is the one measured (`have`), and it is
        // the one at the final name, in the realm's own folder: no folder on
        // the way became a link since the checks. Anything written goes
        // through this handle, so to nothing else.
        const aStat = await a.stat({ bigint: true })
        if (!aStat.isFile() || !sameFile(aStat, there)) return fail('changed')
        if (!stillAt(finalPath, aStat)) return fail('changed')
        if (!(await sameBytes(a, b, have))) return fail('exists-different')
        if (have === lastLineEnd) return { ok: true, carried: 'present', bytes: lastLineEnd }
        // A second name of another file (a history copy links them) is
        // never added to through this one.
        if (aStat.nlink !== 1n) return fail('exists-different')
        if (!(await copyRange(b, a, have, lastLineEnd))) return fail('io-failed')
        await a.sync()
        // Nothing else wrote to it meanwhile.
        const grown = await a.stat({ bigint: true })
        if (Number(grown.size) !== lastLineEnd) return fail('changed')
        return { ok: true, carried: 'extended', bytes: lastLineEnd }
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
    // the name goes again, but only while it is that file.
    let landed: fs.BigIntStats | null = null
    try { landed = fs.lstatSync(finalPath, { bigint: true }) } catch { landed = null }
    const ours = !!landed && !!tempMade && sameFile(landed, tempMade)
    if (!ours || !canonical(finalPath)) {
      try { if (ours) await fs.promises.unlink(finalPath) } catch { /* left for the next attempt */ }
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
