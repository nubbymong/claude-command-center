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
 * (the carry runs in main's respawn, between the kill and the spawn). Both
 * roots it is handed are canonical: the caller derives them from the app's
 * roots taken at their real path (resolveCodexRealmRoots), with the same
 * realpath flavour as here (realpathSync.native, which also expands an 8.3
 * short name), so a root reached through a link, a junction or a short name
 * is refused here, never resolved (a folder swapped for a link is never
 * followed). This module does the file work only:
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
 *     canonical path (one made here that turns out not to be, a folder above
 *     it swapped for a link meanwhile, is taken back while empty);
 *   - it is written to a new temporary file in the destination's sessions
 *     folder (exclusive create, owner-only), checked to be there before
 *     anything is written to it, flushed, checked, then given its final name:
 *     a second name made inside the day folder and checked there, then a
 *     hard link to the final name within that folder, which never replaces
 *     anything; the file appears whole or not at all, and one that landed
 *     anywhere but the realm's own folder is taken back;
 *   - a file already at the final name: the same bytes mean the
 *     conversation is already there (`present`); an earlier copy of it that
 *     is exactly the start of this one (the session was on that account
 *     before: A -> B -> A), and still that size, is brought up to date
 *     (`extended`) by renaming the whole copy over that one name, from a
 *     second name made inside the same day folder and checked there, so the
 *     rename replaces only that name in the realm's own folder; nothing is
 *     ever written through the earlier copy, and another name of it (the
 *     account's kept earlier folder, after a staged sign in again) keeps what
 *     it had. Anything else went its own way there and is left as it is;
 *   - nothing is removed except the files and folders made here, each only
 *     while the file or folder at its real path is still the one made;
 *   - the temporary file and the second name are removed on every path, and
 *     one a carry that stopped part way left behind is removed by the next
 *     carry into that realm's sessions folder, or into that day folder, once
 *     it is stale (by its own name and age: see sweepStaleTemps);
 *   - `shouldStop` (the respawn it is for is no longer current, or ran out of
 *     time) stops it before the next step: nothing is left behind.
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

/** A rename a virus scanner or an indexer holds up (Windows: EPERM, EBUSY,
 *  EACCES while it has the file open) is tried again, briefly. */
const RENAME_TRIES = 5
const RENAME_RETRY_MS = 40

const OWNER_ONLY_DIR = 0o700
const OWNER_ONLY_FILE = 0o600

/** A carry's temporary file: this module's own naming, and nothing else. */
const TEMP_PREFIX = '.ccc-carry-'
const TEMP_NAME_RE = /^\.ccc-carry-[0-9a-f]{24}\.tmp$/

export type CodexCarryCode = 'not-found' | 'exists-different' | 'too-large' | 'unsafe-path' | 'changed' | 'io-failed' | 'cancelled'
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
  /** Asked before each step: true stops the carry there (`cancelled`), with
   *  nothing left behind. A throw counts as true. */
  shouldStop?: () => boolean
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

type Identity = { dev: bigint; ino: bigint }
/** A file id the volume reported. One that reports 0 gives nothing to
 *  compare: identity is unknown there, and never taken as a match. */
const idKnown = (a: Identity) => a.ino !== 0n
const sameFile = (a: Identity, b: Identity) => idKnown(a) && idKnown(b) && a.dev === b.dev && a.ino === b.ino

function identityOf(p: string): Identity | null {
  try { const st = fs.lstatSync(p, { bigint: true }); return { dev: st.dev, ino: st.ino } } catch { return null }
}

/** The file at `p` is `st`, a plain file, at its own canonical path. */
function stillAt(p: string, st: Identity): boolean {
  try {
    const now = fs.lstatSync(p, { bigint: true })
    return now.isFile() && !now.isSymbolicLink() && sameFile(now, st) && canonical(p)
  } catch {
    return false
  }
}

/** The size of the plain file at `p`, or -1. */
function sizeAt(p: string): number {
  try { const st = fs.lstatSync(p); return st.isFile() && !st.isSymbolicLink() ? st.size : -1 } catch { return -1 }
}

/**
 * Remove `p`, a file made here, but only while the file at the path it really
 * is now is that file: the path is resolved first and the identity looked at
 * there, so a link re-pointed meanwhile never turns the removal onto another
 * file (then it is left, and the carry says it did not happen). Where the
 * volume reports no file ids, `byName` allows a plain file at the resolved
 * path (a random name this module made exclusively).
 */
async function removeIfStill(p: string, st: Identity, byName = false): Promise<void> {
  await removeAtReal(realOf(p), st, byName)
}

/** The path `p` really is now (no link on the way), or null. */
function realOf(p: string): string | null {
  try { return fs.realpathSync.native(p) } catch { return null }
}

/** Remove the file at `real` (a path resolved when the file landed there),
 *  only while it is still `st` (see removeIfStill). A landing's real path is
 *  taken right after it lands, so a link re-pointed later never turns the
 *  removal elsewhere and leaves the file behind (ADR-009 round 2, N5). */
async function removeAtReal(real: string | null, st: Identity, byName = false): Promise<void> {
  if (!real) return
  try {
    const now = fs.lstatSync(real, { bigint: true })
    if (!now.isFile() || now.isSymbolicLink()) return
    if (idKnown(st) ? !sameFile(now, st) : !byName) return
    await fs.promises.unlink(real)
  } catch { /* gone meanwhile */ }
}

/** `dir`, made owner-only when absent (never through a link), and a real
 *  folder at its own canonical path either way. Its parent is checked by the
 *  caller first. One made here that is not where it was meant to be (a
 *  folder above it swapped for a link meanwhile) is taken back: only that
 *  folder, at its real path, and only while it is empty. */
function ensureFolder(dir: string): boolean {
  let made: Identity | null = null
  try {
    fs.lstatSync(dir)
  } catch (e) {
    if (errCode(e) !== 'ENOENT') return false
    try { fs.mkdirSync(dir, { mode: OWNER_ONLY_DIR }); made = identityOf(dir) } catch (e2) { if (errCode(e2) !== 'EEXIST') return false }
  }
  if (realCanonicalFolder(dir)) return true
  if (made && idKnown(made)) {
    try {
      const real = fs.realpathSync.native(dir)
      const now = fs.lstatSync(real, { bigint: true })
      if (now.isDirectory() && sameFile(now, made)) fs.rmdirSync(real)
    } catch { /* not empty, or gone: left */ }
  }
  return false
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

/**
 * Carry temporary files a carry that stopped part way (the app ended mid-copy)
 * left in a folder it writes them to (a realm's sessions folder, or the day
 * folder a second name is made in): this module's own naming only, a plain
 * file, not changed for CODEX_CARRY_STALE_TEMP_MS. Judged by name and age;
 * removed at the path it really is, and only while the file there is the
 * one looked at (by its file id, or where the volume reports none, as a
 * plain file). The caller holds the realm's lock, so no carry of this app is
 * writing one now.
 */
function sweepStaleTemps(dir: string, now: number): void {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return }
  for (const name of names.slice(0, SWEEP_MAX_ENTRIES)) {
    if (!TEMP_NAME_RE.test(name)) continue
    const p = path.join(dir, name)
    try {
      const st = fs.lstatSync(p, { bigint: true })
      if (!st.isFile() || st.isSymbolicLink() || now - Number(st.mtimeMs) < CODEX_CARRY_STALE_TEMP_MS) continue
      const real = fs.realpathSync.native(p)
      const there = fs.lstatSync(real, { bigint: true })
      if (!there.isFile() || there.isSymbolicLink()) continue
      if (idKnown(st) ? !sameFile(there, st) : false) continue
      fs.unlinkSync(real)
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

/** fs.rename, tried again briefly while something holds the file open. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.promises.rename(from, to)
      return
    } catch (e) {
      const code = errCode(e)
      if (attempt >= RENAME_TRIES || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw e
      await new Promise<void>((resolve) => { setTimeout(resolve, RENAME_RETRY_MS) })
    }
  }
}

/**
 * Copy conversation `id`'s rollout from one realm's sessions folder into
 * another realm's, at the same place. See the file header for the rules.
 */
export async function carryCodexRollout(input: CodexCarryInput): Promise<CodexCarryResult> {
  const { fromSessionsDir, toHome, id } = input ?? ({} as CodexCarryInput)
  const max = typeof input?.maxBytes === 'number' && Number.isInteger(input.maxBytes) && input.maxBytes > 0 ? Math.min(input.maxBytes, CODEX_CARRY_MAX_BYTES) : CODEX_CARRY_MAX_BYTES
  const stopped = (): boolean => {
    if (typeof input?.shouldStop !== 'function') return false
    try { return input.shouldStop() !== false } catch { return true }
  }
  if (typeof id !== 'string' || !CODEX_CONVERSATION_ID_RE.test(id)) return fail('not-found')
  if (typeof fromSessionsDir !== 'string' || typeof toHome !== 'string' || !path.isAbsolute(fromSessionsDir) || !path.isAbsolute(toHome)) return fail('unsafe-path')
  if (!realCanonicalFolder(fromSessionsDir)) return fail('not-found')
  if (!realCanonicalFolder(toHome)) return fail('unsafe-path')
  const toSessions = path.join(toHome, 'sessions')
  if (sameDirectory(fromSessionsDir, toSessions)) return fail('unsafe-path')
  if (stopped()) return fail('cancelled')

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
  // stopped carry left in its sessions folder, and in the day folder the
  // copy's second name is made in, goes first.
  if (!ensureFolder(toSessions)) return fail('unsafe-path')
  sweepStaleTemps(toSessions, Date.now())
  const dayDir = path.join(toSessions, place[0], place[1], place[2])
  for (const dir of [path.join(toSessions, place[0]), path.join(toSessions, place[0], place[1]), dayDir]) {
    if (!ensureFolder(dir)) return fail('unsafe-path')
  }
  sweepStaleTemps(dayDir, Date.now())
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
    if (made) await removeIfStill(tempPath, made, true)
  }
  try {
    if (stopped()) return fail('cancelled')
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
    // Made where it was meant to be (the sessions folder was not swapped for
    // a link before it was made): nothing of the conversation is written
    // anywhere else, even for the copy's while.
    if (!stillAt(tempPath, tempMade)) return fail('changed')
    const buf = Buffer.alloc(CHUNK)
    let at = 0
    let lastLineEnd = 0
    while (at < size) {
      if (stopped()) return fail('cancelled')
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
    if (stopped()) return fail('cancelled')
    const made = tempMade

    /** The copy took the final name: where it landed (its real path, taken
     *  right after it landed) is the final name itself (no folder on the way
     *  was swapped for a link since the checks) and it is the file written
     *  here. Otherwise it is taken back from where it landed, but only while
     *  the file there is that file; else it is left. */
    const tookName = async (landedAt: string | null): Promise<boolean> => {
      let landed: fs.BigIntStats | null = null
      try { landed = landedAt ? fs.lstatSync(landedAt, { bigint: true }) : null } catch { landed = null }
      if (landedAt && landed && landed.isFile() && sameFile(landed, made) && sameDirectory(landedAt, finalPath)) return true
      await removeAtReal(landedAt, made)
      return false
    }

    /** A second name of the copy inside the day folder, and where it really
     *  landed (taken at once): checked before it is used, and removed from
     *  there on every path. */
    const secondName = async (): Promise<{ inner: string; innerAt: string | null } | null> => {
      const inner = path.join(dayDir, `${TEMP_PREFIX}${randomBytes(12).toString('hex')}.tmp`)
      try { await fs.promises.link(tempPath, inner) } catch { return null }
      return { inner, innerAt: realOf(inner) }
    }

    /** The whole copy renamed over the final name (an earlier copy brought up
     *  to date): a second name of it is made inside the day folder, checked
     *  to be there and to be the file written here, and renamed over the
     *  final name within that folder, so it can replace no name elsewhere.
     *  The earlier copy must still be the one compared, that size, at the
     *  final name. Nothing is written through it. */
    const replaceName = async (earlier: Identity, have: number): Promise<CodexCarryResult> => {
      const second = await secondName()
      if (!second) return fail('io-failed')
      const { inner, innerAt } = second
      let renamed = false
      try {
        if (!innerAt || !sameDirectory(innerAt, inner) || !stillAt(inner, made)) return fail('changed')
        // Nothing was added to the earlier copy since it was compared: the
        // CLI may write to a sign-in's folder at any time (this computer's
        // own sign-in is not the app's to hold), and what it added is never
        // replaced.
        if (!stillAt(finalPath, earlier) || sizeAt(finalPath) !== have) return fail('changed')
        if (stopped()) return fail('cancelled')
        try {
          await renameWithRetry(inner, finalPath)
        } catch (e) {
          return errCode(e) === 'ENOENT' ? fail('changed') : fail('io-failed')
        }
        renamed = true
        return (await tookName(realOf(finalPath))) ? { ok: true, carried: 'extended', bytes: lastLineEnd } : fail('changed')
      } finally {
        if (!renamed) await removeAtReal(innerAt, made)
      }
    }

    // Something already at the final name: the same bytes are present; an
    // earlier copy that is exactly the start of this one is brought up to
    // date; anything else went its own way there and is left as it is.
    const settle = async (): Promise<CodexCarryResult> => {
      let there: fs.BigIntStats
      try { there = fs.lstatSync(finalPath, { bigint: true }) } catch { return fail('changed') }
      if (!there.isFile() || there.isSymbolicLink()) return fail('unsafe-path')
      const have = Number(there.size)
      if (have > lastLineEnd) return fail('exists-different')
      let a: fs.promises.FileHandle | null = null
      let b: fs.promises.FileHandle | null = null
      let earlier: Identity
      try {
        a = await fs.promises.open(finalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
        b = await fs.promises.open(tempPath, 'r')
        // The file this handle holds is the one measured, still that size,
        // and the one at the final name, in the realm's own folder.
        const aStat = await a.stat({ bigint: true })
        if (!aStat.isFile() || !sameFile(aStat, there) || Number(aStat.size) !== have) return fail('changed')
        if (!stillAt(finalPath, aStat)) return fail('changed')
        if (!(await sameBytes(a, b, have))) return fail('exists-different')
        if (have === lastLineEnd) return { ok: true, carried: 'present', bytes: lastLineEnd }
        earlier = { dev: aStat.dev, ino: aStat.ino }
      } catch {
        return fail('io-failed')
      } finally {
        await a?.close().catch(() => undefined)
        await b?.close().catch(() => undefined)
      }
      return replaceName(earlier, have)
    }
    try {
      fs.lstatSync(finalPath)
      return await settle()
    } catch (e) {
      if (errCode(e) !== 'ENOENT') return fail('io-failed')
    }
    // A new copy takes its name from inside the day folder too (ADR-009
    // round 2, N5): a second name of it is made there and checked to be
    // there and to be the file written here, then linked to the final name
    // within that folder. A hard link replaces nothing, and a folder swapped
    // for a link after the check lands nothing of it elsewhere. The second
    // name goes on every path.
    const second = await secondName()
    if (!second) return fail('io-failed')
    const { inner, innerAt } = second
    try {
      if (!innerAt || !sameDirectory(innerAt, inner) || !stillAt(inner, made)) return fail('changed')
      if (stopped()) return fail('cancelled')
      try {
        await fs.promises.link(inner, finalPath)
      } catch (e) {
        const code = errCode(e)
        return code === 'EEXIST' ? await settle() : code === 'ENOENT' ? fail('changed') : fail('io-failed')
      }
      return (await tookName(realOf(finalPath))) ? { ok: true, carried: 'copied', bytes: lastLineEnd } : fail('changed')
    } finally {
      await removeAtReal(innerAt, made)
    }
  } catch {
    return fail('io-failed')
  } finally {
    await src?.close().catch(() => undefined)
    await tmp?.close().catch(() => undefined)
    await dropTemp()
  }
}
