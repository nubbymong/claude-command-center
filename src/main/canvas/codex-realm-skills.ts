// The Agent Canvas, canvas-plan and Conductor vision skills in a Codex
// account's skills folder (WP2 PR 4, P4.1, row 51; the PR 4 VM probe PB1:
// Codex lists the skills under its home's `skills/`): a MANAGED account's,
// whose home is the app's own folder, and (section 10 question 5, answered C
// by the owner on 2026-10-04) this computer's own sign-in's, the user's own
// Codex folder (codex-user-skills.ts records that folder and decides when).
// One staging serves both (stageCanvasSkillsIn).
//
// Parity with Claude's plugin (canvas-plugin.ts, passed by --plugin-dir only
// while the built-in tools are on): staged before a launch while the tools
// are on, removed when they are off, and the bytes are the plugin's own
// Buffers, verified on every launch and never trusted from disk -- the first
// session of an account (its trust and sandbox screens) does not hold its
// preset and runs approved commands outside the sandbox (PB8), so nothing
// staged here may rely on the model being unable to write the folder.
//
// What is staged where: `<home>/skills/<name>/SKILL.md` for each skill, and
// beside it the app's ownership mark (`.ai-code-conductor-skill`, a hidden
// file, which Codex's skill walk does not list). A skill folder is the app's
// while it carries that mark in any state: the exact bytes, an older text or
// a changed one (only the app names a file so, and a folder it put there
// stays its own to rebuild or remove, whatever was done to the mark). The app
// rebuilds or removes only its own folders, whole, and never a same-named
// folder without the mark (in the user's own Codex folder, the user's own
// skill of that name: left as it is, and reported by name).
//
// A folder of the app's leaves its place in one rename, into a fresh staging
// folder, before anything in it is deleted, and is deleted with its mark
// last: a removal or a rebuild that fails part-way (a file held open by
// another program) leaves a staging folder still recognisably the app's,
// which a later pass sweeps, and never a copy without its mark at the skill's
// name.
//
// Refused, with nothing written: a skills folder other than exactly
// `<home>/skills`; a link or junction at the home, at its `skills/` or at a
// skill folder; anything at a skill's name that is not the app's folder.
//
// Which homes are managed is the Codex package's path rule (realm-paths.ts
// codexManagedRealmSkillsDir), reached through the registered provider
// (SessionProvider.stagedSkillsDir): stageCodexRealmSkills and
// removeCodexRealmSkills take the skills folder it gave, or null for a home
// that has none, and stage or remove nothing for null.
import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteSecure, mkdirSecure } from '../account-profiles'
import { canvasSkillFiles } from './canvas-plugin'
import { logInfo, logWarn } from '../debug-logger'

/** The ownership mark's file name, inside each skill folder the app stages. */
export const STAGED_SKILL_MARK = '.ai-code-conductor-skill'
/** Its exact bytes, as the app writes them: a folder of the app's holding
 *  anything else there is rebuilt. Both switches that remove it are named,
 *  for a user who opens the file in their own Codex folder (review B-S7). */
export const STAGED_SKILL_MARK_BYTES = Buffer.from(
  'AI Code Conductor staged this skill folder. It rewrites the folder before each session while its built-in tools are on, and removes it when they are turned off or, in your own Codex folder, when Codex is turned off in the app.\n',
  'utf8',
)

/** Where a skill folder is built before it is put in place, and where one
 *  goes before it is deleted: a hidden folder of a fresh, unguessable name
 *  inside the home's `skills/`. */
export const STAGING_PREFIX = '.ccc-staging-'

export type RealmSkillsOutcome =
  | { staged: true }
  | { staged: false; reason: 'not-managed' | 'link' | 'not-ours' | 'failed' }

/** One skill left as it was, and why: a link at its own folder (`link`), a
 *  link at the skills folder or the home so that none could be tried
 *  (`folder-link`), a folder or file of that name that is not the app's, or
 *  a write that failed. */
export interface SkippedCanvasSkill { name: string; reason: 'link' | 'folder-link' | 'not-ours' | 'failed' }

/** A staging skill by skill: the outcome, and every skill not staged by name
 *  (all of them when nothing could be tried). */
export interface CanvasSkillsStaging { outcome: RealmSkillsOutcome; skipped: SkippedCanvasSkill[] }

/** Whose skills folder it is: for the log, and for what a staging sweep may
 *  remove (the user's own folder keeps anything the app cannot tell is its
 *  own). */
export type CanvasSkillsPlace = 'managed' | 'own'

const PLACE_WORDS: Record<CanvasSkillsPlace, string> = {
  managed: 'a managed Codex account',
  own: 'this computer\'s own Codex folder',
}

/** One entry as lstat sees it: never followed; `id` names the entry itself
 *  (its device and file number), so a folder put in its place is not it. */
export interface RealmEntry { dir: boolean; file: boolean; link: boolean; size: number; id: string }

/** What staging reads and writes through: the real file system, or one the
 *  tests stand in (ADR-009 round 1: a path swapped between a check and a
 *  write). */
export interface RealmSkillsIo {
  /** lstat, or null when there is nothing there (or it cannot be read). */
  lstat(p: string): RealmEntry | null
  /** Nothing is there, for certain: the file system said so (default: lstat
   *  found nothing). A path that cannot be read now is not absent. */
  absent?(p: string): boolean
  readdir(p: string): string[]
  readFile(p: string): Buffer
  /** The folder, made when missing, refused (thrown) when a link stands at
   *  it or at a folder above it up to the app's trusted anchor. */
  mkdirChecked(p: string): void
  /** One folder, which must not exist yet. */
  mkdir(p: string): void
  /** A new folder of a fresh name starting with `prefix`; its path. */
  mkdtemp(prefix: string): string
  /** The app's atomic, owner-only write of a whole file. */
  writeFile(p: string, bytes: Buffer): void
  rename(from: string, to: string): void
  /** A file, or a folder and everything in it, never through a link inside
   *  it; a link itself (never what it points at). */
  removeTree(p: string): void
  /** An empty folder, or a link itself (never what it points at). */
  removeEntry(p: string): void
}

export const realRealmSkillsIo: RealmSkillsIo = {
  lstat: (p) => {
    try {
      const st = fs.lstatSync(p, { bigint: true })
      return { dir: st.isDirectory(), file: st.isFile(), link: st.isSymbolicLink(), size: Number(st.size), id: `${st.dev}:${st.ino}` }
    } catch {
      return null
    }
  },
  absent: (p) => {
    try {
      fs.lstatSync(p)
      return false
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      return code === 'ENOENT' || code === 'ENOTDIR'
    }
  },
  readdir: (p) => fs.readdirSync(p),
  readFile: (p) => fs.readFileSync(p),
  mkdirChecked: (p) => mkdirSecure(p),
  mkdir: (p) => { fs.mkdirSync(p) },
  mkdtemp: (prefix) => fs.mkdtempSync(prefix),
  writeFile: (p, bytes) => atomicWriteSecure(p, bytes, 0o600),
  rename: (from, to) => fs.renameSync(from, to),
  removeTree: (p) => fs.rmSync(p, { recursive: true, force: true }),
  removeEntry: (p) => {
    try { fs.rmdirSync(p) } catch { fs.unlinkSync(p) }
  },
}

/** Nothing is at `p`, for certain. */
function isAbsent(io: RealmSkillsIo, p: string): boolean {
  return io.absent ? io.absent(p) : io.lstat(p) === null
}

/** A real, unlinked file whose bytes are exactly `expected`. */
function fileIsExactly(io: RealmSkillsIo, file: string, expected: Buffer): boolean {
  const st = io.lstat(file)
  if (!st || !st.file || st.link || st.size !== expected.length) return false
  try { return io.readFile(file).equals(expected) } catch { return false }
}

/** The folder is the app's: a real folder (never reached through a link)
 *  that carries the app's mark in any state (exact, changed, or anything at
 *  that name; review B-Q1, L1-1). One that cannot be read counts as carrying
 *  it, so the app never reports it as the user's or lets it go. */
function carriesMark(io: RealmSkillsIo, dir: string): boolean {
  const st = io.lstat(dir)
  return !!st && st.dir && !st.link && !isAbsent(io, path.join(dir, STAGED_SKILL_MARK))
}

/** The app's folder holds exactly its two files, byte for byte. */
function isPristine(io: RealmSkillsIo, dir: string, skill: Buffer): boolean {
  let names: string[]
  try { names = io.readdir(dir) } catch { return false }
  if (names.length !== 2 || !names.includes('SKILL.md') || !names.includes(STAGED_SKILL_MARK)) return false
  return fileIsExactly(io, path.join(dir, 'SKILL.md'), skill) && fileIsExactly(io, path.join(dir, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
}

/** The identity of a real folder at `p` (null: none, or not a real folder). */
function folderId(io: RealmSkillsIo, p: string): string | null {
  const st = io.lstat(p)
  return st && st.dir && !st.link ? st.id : null
}

/** The home and its skills folder, checked: real folders, no link.
 *  `skillsDir` is the one the caller gave for `home` (null: none), and only
 *  ever `<home>/skills`. `skillsMissing`: there is no skills folder yet. */
function realmChecked(io: RealmSkillsIo, home: string, skillsDir: string | null): { skillsDir: string; skillsMissing: boolean } | RealmSkillsOutcome {
  if (!skillsDir || typeof home !== 'string' || !path.isAbsolute(home) || path.resolve(skillsDir) !== path.join(path.resolve(home), 'skills')) {
    return { staged: false, reason: 'not-managed' }
  }
  const homeSt = io.lstat(path.resolve(home))
  if (!homeSt) return { staged: false, reason: 'failed' }
  if (homeSt.link || !homeSt.dir) return { staged: false, reason: 'link' }
  const skillsSt = io.lstat(skillsDir)
  if (skillsSt && (skillsSt.link || !skillsSt.dir)) return { staged: false, reason: skillsSt.link ? 'link' : 'not-ours' }
  return { skillsDir, skillsMissing: !skillsSt }
}

/** A staging folder's skill folders deleted, each with its mark last, then
 *  the staging folder itself; never through a link (a link is removed as
 *  itself). Throws at the first entry that cannot be deleted: whatever is
 *  left is still marked, or empty, so the staging folder stays recognisably
 *  the app's and a later sweep finishes it (review B-Q1). */
function deleteStaging(io: RealmSkillsIo, staging: string): void {
  for (const name of io.readdir(staging)) {
    const built = path.join(staging, name)
    const st = io.lstat(built)
    if (st && st.dir && !st.link) {
      for (const inner of io.readdir(built)) if (inner !== STAGED_SKILL_MARK) io.removeTree(path.join(built, inner))
      const mark = path.join(built, STAGED_SKILL_MARK)
      if (!isAbsent(io, mark)) io.removeTree(mark)
      io.removeEntry(built)
    } else {
      io.removeTree(built)
    }
  }
  io.removeEntry(staging)
}

/** A staging folder goes once its skill is placed, given up or deleted:
 *  while it is still the folder made, with its contents (deleteStaging); a
 *  link put in its place, by itself; anything else at that name is not the
 *  app's, and stays. Never throws. */
function removeStaging(io: RealmSkillsIo, staging: string, id: string | null, where: string): void {
  try {
    const st = io.lstat(staging)
    if (!st) return
    if (st.link) io.removeEntry(staging)
    else if (id && st.dir && st.id === id) deleteStaging(io, staging)
  } catch (err) {
    logWarn(`[codex-skills] a staging folder in ${where} could not be removed yet: ${(err as Error)?.message ?? err}`)
  }
}

/** Take the app's folder at `dir` (`name`, identity `id`) out of its place in
 *  one rename, into a fresh staging folder, before anything in it is deleted
 *  (review B-Q1). Returns that staging folder. Throws with nothing moved when
 *  the rename is refused (a file in it held open, say), and puts back a
 *  folder that turned out not to be the one checked. */
function takeOut(io: RealmSkillsIo, skillsDir: string, dir: string, name: string, id: string, where: string): { staging: string; stagingId: string } {
  const staging = io.mkdtemp(path.join(skillsDir, STAGING_PREFIX))
  const stagingId = folderId(io, staging)
  if (!stagingId) {
    removeStaging(io, staging, null, where)
    throw new Error('its staging folder is not a plain folder')
  }
  const moved = path.join(staging, name)
  try {
    io.rename(dir, moved)
  } catch (err) {
    removeStaging(io, staging, stagingId, where)
    throw err
  }
  if (folderId(io, moved) !== id) {
    // Not the folder checked: back where it was, untouched. One that cannot
    // be put back stays in the staging folder, which is then left as it is.
    io.rename(moved, dir)
    removeStaging(io, staging, stagingId, where)
    throw new Error('the folder changed before it was taken out')
  }
  return { staging, stagingId }
}

/** A temporary file the app's atomic write leaves while writing one of the
 *  two files (atomic-write.ts: `<file>.<uuid>.tmp`). */
const HALF_WRITTEN_RE = /^(\.ai-code-conductor-skill|SKILL\.md)\.[0-9a-f-]{36}\.tmp$/

/** A skill folder inside a staging folder is the app's: one carrying the
 *  app's mark in any state, or holding nothing but files the app writes
 *  there (SKILL.md, its own half-written files): what a crash, or one of its
 *  own removals stopped part-way, can leave. */
function builtIsOurs(io: RealmSkillsIo, built: string): boolean {
  const b = io.lstat(built)
  if (!b || !b.dir || b.link) return false
  if (carriesMark(io, built)) return true
  let names: string[]
  try { names = io.readdir(built) } catch { return false }
  return names.every((n) => {
    if (n !== 'SKILL.md' && !HALF_WRITTEN_RE.test(n)) return false
    const e = io.lstat(path.join(built, n))
    return !!e && e.file && !e.link
  })
}

/** A staging folder left behind is the app's: a real folder holding only
 *  folders named after the app's skills, each the app's (builtIsOurs). In
 *  the user's own Codex folder it must hold at least one (an empty folder at
 *  a staging name is nothing the app can tell is its own; review B-S8); in a
 *  managed account's folder, the app's own, an empty one is a crash's too. */
function stagingIsOurs(io: RealmSkillsIo, staging: string, place: CanvasSkillsPlace): boolean {
  const st = io.lstat(staging)
  if (!st || !st.dir || st.link) return false
  const skills = new Set(canvasSkillFiles().map((s) => s.name))
  let names: string[]
  try { names = io.readdir(staging) } catch { return false }
  if (names.length === 0) return place === 'managed'
  return names.every((name) => skills.has(name) && builtIsOurs(io, path.join(staging, name)))
}

/** ADR-009 round 2: the staging folders left in `skills/` go at each stage
 *  and each removal: one that is the app's, deleted with each mark last
 *  (deleteStaging). In a managed account's folder a link at that name goes
 *  as the link itself (never followed); in the user's own Codex folder it is
 *  left, as is anything else the app cannot tell is its own (review B-S8). */
function sweepStaging(io: RealmSkillsIo, skillsDir: string, where: string, place: CanvasSkillsPlace): void {
  let names: string[]
  try { names = io.readdir(skillsDir) } catch { return }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    const p = path.join(skillsDir, name)
    try {
      const st = io.lstat(p)
      if (!st) continue
      if (st.link && place === 'managed') io.removeEntry(p)
      else if (!st.link && stagingIsOurs(io, p, place)) deleteStaging(io, p)
      else logInfo(`[codex-skills] a staging folder in ${where} is not the app's; left alone`)
    } catch (err) {
      logWarn(`[codex-skills] a staging folder in ${where} could not be removed yet: ${(err as Error)?.message ?? err}`)
    }
  }
}

/** Every skill, skipped for one reason: nothing could be tried. */
function allSkipped(outcome: Exclude<RealmSkillsOutcome, { staged: true }>): CanvasSkillsStaging {
  // A home or skills folder that is not a real folder is not a skill of that
  // name, so it is never reported as one that is not the app's.
  const reason: SkippedCanvasSkill['reason'] = outcome.reason === 'link' ? 'folder-link' : 'failed'
  return { outcome, skipped: canvasSkillFiles().map((s) => ({ name: s.name, reason })) }
}

export interface StageCanvasSkillsOptions {
  /** Whose folder: for the log and the staging sweep. */
  place: CanvasSkillsPlace
  /** Keep the app's folders already there exact, and put none where there is
   *  none (no skills folder made, no skill folder added): the refresh this
   *  computer's own sign-in gets between launches (codex-user-skills.ts). */
  onlyExisting?: boolean
}

/**
 * Stage the skills into `<home>/skills` (`skillsDir`, exactly that): all of
 * them, as Claude's --plugin-dir carries all of them while the master switch
 * is on (review RA-1). Every skill folder ends up the app's and exactly its
 * bytes, or is left alone and reported by name: `staged` only when all of
 * them are. One skill that cannot be written (a file held open, say) is
 * reported and does not stop the others.
 *
 * ADR-009 round 1: a skill folder is never written where it is to stand. It is
 * built in a fresh folder of an unguessable name beside the skills
 * (STAGING_PREFIX), checked to be still that folder (no link put in its place,
 * `skills/` itself still the folder it was) holding exactly the app's two
 * files, and only then renamed into place: a rename never writes through a
 * link standing at the skill's name (it fails instead). The app's earlier
 * folder leaves the place first, by one rename (takeOut). The placed folder
 * is checked again, by identity and bytes, before the skill counts as staged.
 */
export function stageCanvasSkillsIn(home: string, skillsDir: string | null, opts: StageCanvasSkillsOptions, io: RealmSkillsIo = realRealmSkillsIo): CanvasSkillsStaging {
  const place: CanvasSkillsPlace = opts.place === 'own' ? 'own' : 'managed'
  const where = PLACE_WORDS[place]
  const checked = realmChecked(io, home, skillsDir)
  if (!('skillsDir' in checked)) return allSkipped(checked as Exclude<RealmSkillsOutcome, { staged: true }>)
  const dirOf = checked.skillsDir
  if (checked.skillsMissing && opts.onlyExisting) return { outcome: { staged: true }, skipped: [] }
  let outcome: RealmSkillsOutcome = { staged: true }
  const skipped: SkippedCanvasSkill[] = []
  const skip = (name: string, reason: SkippedCanvasSkill['reason']): void => {
    skipped.push({ name, reason })
    if (outcome.staged) outcome = { staged: false, reason: reason === 'folder-link' ? 'link' : reason }
  }
  try {
    // Review L1-2: the skills folder is made as one folder inside the home
    // just checked (never a chain of them, so never at a link put in its
    // place: that is refused as already there), or checked again just before
    // the app's checked mkdir walks above it for a link.
    if (checked.skillsMissing) {
      io.mkdir(dirOf)
    } else {
      const now = io.lstat(dirOf)
      if (!now) throw new Error('its skills folder went away')
      if (now.link || !now.dir) return allSkipped({ staged: false, reason: 'link' })
    }
    io.mkdirChecked(dirOf)
    const skillsId = folderId(io, dirOf)
    if (!skillsId) return allSkipped({ staged: false, reason: 'link' })
    sweepStaging(io, dirOf, where, place)
    for (const skill of canvasSkillFiles()) {
      const dir = path.join(dirOf, skill.name)
      let staging: string | null = null
      let stagingId: string | null = null
      try {
        const st = io.lstat(dir)
        if (!st && opts.onlyExisting) continue
        if (st && st.link) {
          logWarn(`[codex-skills] a link stands at the ${skill.name} skill folder of ${where}; left alone, the skill not staged`)
          skip(skill.name, 'link')
          continue
        }
        if (st && !carriesMark(io, dir)) {
          logInfo(`[codex-skills] a ${skill.name} skill folder the app did not stage is in ${where}; left alone`)
          skip(skill.name, 'not-ours')
          continue
        }
        if (st && isPristine(io, dir, skill.bytes)) continue
        // The app's own folder, not exactly its bytes (or none yet): built
        // again from nothing, as the plugin folder is, away from its place.
        staging = io.mkdtemp(path.join(dirOf, STAGING_PREFIX))
        stagingId = folderId(io, staging)
        const built = path.join(staging, skill.name)
        if (!stagingId) throw new Error('its staging folder is not a plain folder')
        io.mkdir(built)
        const builtId = folderId(io, built)
        if (!builtId) throw new Error('its staging folder is not a plain folder')
        io.writeFile(path.join(built, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
        io.writeFile(path.join(built, 'SKILL.md'), skill.bytes)
        if (folderId(io, dirOf) !== skillsId || folderId(io, staging) !== stagingId || folderId(io, built) !== builtId || !isPristine(io, built, skill.bytes)) {
          logWarn(`[codex-skills] the ${skill.name} skill's staging folder changed while it was built; the skill not staged`)
          skip(skill.name, 'failed')
          continue
        }
        // The app's earlier folder leaves its place first, checked again
        // just before (takeOut), and goes once the new one is in place.
        const now = io.lstat(dir)
        let old: { staging: string; stagingId: string } | null = null
        if (now) {
          if (now.link || !carriesMark(io, dir)) {
            logWarn(`[codex-skills] the ${skill.name} skill folder changed while the skill was built; left alone, the skill not staged`)
            skip(skill.name, now.link ? 'link' : 'not-ours')
            continue
          }
          old = takeOut(io, dirOf, dir, skill.name, now.id, where)
        }
        try {
          io.rename(built, dir)
        } finally {
          if (old) removeStaging(io, old.staging, old.stagingId, where)
        }
        if (folderId(io, dirOf) !== skillsId || folderId(io, dir) !== builtId || !isPristine(io, dir, skill.bytes)) {
          logWarn(`[codex-skills] the ${skill.name} skill folder is not the one built once placed; the skill not staged`)
          skip(skill.name, 'failed')
        }
      } catch (err) {
        logWarn(`[codex-skills] the ${skill.name} skill could not be staged in ${where}: ${(err as Error)?.message ?? err}`)
        skip(skill.name, 'failed')
      } finally {
        if (staging) removeStaging(io, staging, stagingId, where)
      }
    }
  } catch (err) {
    logWarn(`[codex-skills] the canvas skills could not be staged in ${where}: ${(err as Error)?.message ?? err}`)
    return allSkipped({ staged: false, reason: 'failed' })
  }
  return { outcome, skipped }
}

/** What is left of the app's copies in `<home>/skills`: `none` only when it is
 *  certain none is (the home is really gone -- nothing there, its parent
 *  present -- or it holds no folder carrying the app's mark and no staging
 *  folder of the app's; a home or skills folder that is a link, which the app
 *  never reaches through, holds none it will reach); `unknown` when part of
 *  it cannot be read now (an offline share, a denied folder): review B-Q3. */
export type CanvasSkillsLeft = 'none' | 'some' | 'unknown'

export function canvasSkillsLeft(home: string, skillsDir: string | null, place: CanvasSkillsPlace, io: RealmSkillsIo = realRealmSkillsIo): CanvasSkillsLeft {
  try {
    if (!skillsDir || typeof home !== 'string' || !path.isAbsolute(home) || path.resolve(skillsDir) !== path.join(path.resolve(home), 'skills')) return 'none'
    const root = path.resolve(home)
    const homeSt = io.lstat(root)
    if (!homeSt) {
      const parent = path.dirname(root)
      return parent !== root && isAbsent(io, root) && io.lstat(parent) !== null ? 'none' : 'unknown'
    }
    if (homeSt.link || !homeSt.dir) return 'none'
    const skillsSt = io.lstat(skillsDir)
    if (!skillsSt) return isAbsent(io, skillsDir) ? 'none' : 'unknown'
    if (skillsSt.link || !skillsSt.dir) return 'none'
    for (const skill of canvasSkillFiles()) {
      const dir = path.join(skillsDir, skill.name)
      if (!io.lstat(dir)) {
        if (!isAbsent(io, dir)) return 'unknown'
        continue
      }
      if (carriesMark(io, dir)) return 'some'
    }
    let names: string[]
    try { names = io.readdir(skillsDir) } catch { return 'unknown' }
    for (const name of names) {
      if (name.startsWith(STAGING_PREFIX) && stagingIsOurs(io, path.join(skillsDir, name), place)) return 'some'
    }
    return 'none'
  } catch {
    return 'unknown'
  }
}

/**
 * Remove the app's staged skills from `<home>/skills` (`skillsDir`, exactly
 * that): only folders carrying the app's mark, never through a link, never a
 * folder that is not the app's; each leaves its place in one rename and is
 * deleted with its mark last. Never throws. `clear` only when none of the
 * app's copies is left there afterwards (canvasSkillsLeft says `none`);
 * `kept` when one is, or when that cannot be told now.
 */
export function removeCanvasSkillsFrom(home: string, skillsDir: string | null, place: CanvasSkillsPlace, io: RealmSkillsIo = realRealmSkillsIo): 'clear' | 'kept' {
  const own: CanvasSkillsPlace = place === 'own' ? 'own' : 'managed'
  const where = PLACE_WORDS[own]
  try {
    const checked = realmChecked(io, home, skillsDir)
    if ('skillsDir' in checked && !checked.skillsMissing) {
      sweepStaging(io, checked.skillsDir, where, own)
      for (const skill of canvasSkillFiles()) {
        const dir = path.join(checked.skillsDir, skill.name)
        try {
          if (!carriesMark(io, dir)) continue
          const id = folderId(io, dir)
          if (!id) continue
          const out = takeOut(io, checked.skillsDir, dir, skill.name, id, where)
          removeStaging(io, out.staging, out.stagingId, where)
        } catch (err) {
          logWarn(`[codex-skills] the ${skill.name} skill could not be removed from ${where}: ${(err as Error)?.message ?? err}`)
        }
      }
    }
  } catch (err) {
    logWarn(`[codex-skills] the canvas skills could not be checked for removal in ${where}: ${(err as Error)?.message ?? err}`)
  }
  return canvasSkillsLeft(home, skillsDir, own, io) === 'none' ? 'clear' : 'kept'
}

/** stageCanvasSkillsIn for a managed realm, skill by skill. `managedSkillsDir`
 *  is the one the Codex package gave for `home` (null: not a managed realm's,
 *  and nothing is staged). */
export function stageCodexRealmSkillsDetail(home: string, managedSkillsDir: string | null, io: RealmSkillsIo = realRealmSkillsIo): CanvasSkillsStaging {
  return stageCanvasSkillsIn(home, managedSkillsDir, { place: 'managed' }, io)
}

/** The outcome alone of staging a managed realm (stageCodexRealmSkillsDetail).
 *  No launch calls it (the launch needs the skills by name): it is the entry
 *  point the realm staging's tests drive, the CI and VM link and race files
 *  among them, kept so those read the outcome the way they always have. */
export function stageCodexRealmSkills(home: string, managedSkillsDir: string | null, io: RealmSkillsIo = realRealmSkillsIo): RealmSkillsOutcome {
  return stageCodexRealmSkillsDetail(home, managedSkillsDir, io).outcome
}

/**
 * Remove the app's staged skills from a managed realm (the built-in tools
 * are off): only folders carrying the app's mark, never through a link,
 * never a folder that is not the app's. Never throws.
 */
export function removeCodexRealmSkills(home: string, managedSkillsDir: string | null, io: RealmSkillsIo = realRealmSkillsIo): void {
  removeCanvasSkillsFrom(home, managedSkillsDir, 'managed', io)
}
