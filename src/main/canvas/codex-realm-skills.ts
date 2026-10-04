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
// only while it holds that mark, exact; the app rewrites or removes only its
// own folders, whole, and never a same-named folder that is not its own (in
// the user's own Codex folder, the user's own skill of that name: left as it
// is, and reported by name).
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
/** Its exact bytes: a folder holding anything else there is not the app's. */
export const STAGED_SKILL_MARK_BYTES = Buffer.from(
  'AI Code Conductor staged this skill folder. It rewrites the folder before each session while its built-in tools are on, and removes it when they are off.\n',
  'utf8',
)

/** Where a skill folder is built before it is put in place: a hidden folder
 *  of a fresh, unguessable name inside the home's `skills/`. */
export const STAGING_PREFIX = '.ccc-staging-'

export type RealmSkillsOutcome =
  | { staged: true }
  | { staged: false; reason: 'not-managed' | 'link' | 'not-ours' | 'failed' }

/** One skill left as it was, and why: a link at its folder (or at the skills
 *  folder or the home), a folder or file of that name that is not the app's,
 *  or a write that failed. */
export interface SkippedCanvasSkill { name: string; reason: 'link' | 'not-ours' | 'failed' }

/** A staging skill by skill: the outcome, and every skill not staged by name
 *  (all of them when nothing could be tried). */
export interface CanvasSkillsStaging { outcome: RealmSkillsOutcome; skipped: SkippedCanvasSkill[] }

/** Whose skills folder it is, for the log only. */
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
  /** lstat, or null when there is nothing there. */
  lstat(p: string): RealmEntry | null
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
  /** A folder and everything in it, never through a link inside it. */
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

/** A real, unlinked file whose bytes are exactly `expected`. */
function fileIsExactly(io: RealmSkillsIo, file: string, expected: Buffer): boolean {
  const st = io.lstat(file)
  if (!st || !st.file || st.link || st.size !== expected.length) return false
  try { return io.readFile(file).equals(expected) } catch { return false }
}

/** The folder is the app's: a real folder holding the exact mark. */
function isOurs(io: RealmSkillsIo, dir: string): boolean {
  const st = io.lstat(dir)
  return !!st && st.dir && !st.link && fileIsExactly(io, path.join(dir, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
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

/** A staging folder goes once its skill is placed or given up: whole while it
 *  is still the folder made; a link put in its place, by itself; anything
 *  else at that name is not the app's, and stays. */
function removeStaging(io: RealmSkillsIo, staging: string, id: string | null, where: string): void {
  try {
    const st = io.lstat(staging)
    if (!st) return
    if (st.link) io.removeEntry(staging)
    else if (id && st.dir && st.id === id) io.removeTree(staging)
  } catch (err) {
    logWarn(`[codex-skills] a staging folder in ${where} could not be removed: ${(err as Error)?.message ?? err}`)
  }
}

/** A temporary file the app's atomic write leaves while writing one of the
 *  two files (atomic-write.ts: `<file>.<uuid>.tmp`). */
const HALF_WRITTEN_RE = /^(\.ai-code-conductor-skill|SKILL\.md)\.[0-9a-f-]{36}\.tmp$/

/** A staging folder a crash left is the app's: a real folder holding nothing,
 *  or only folders named after the app's skills, each one the app's (its exact
 *  mark), or holding nothing but the app's half-written files. */
function stagingIsOurs(io: RealmSkillsIo, staging: string): boolean {
  const st = io.lstat(staging)
  if (!st || !st.dir || st.link) return false
  const skills = new Set(canvasSkillFiles().map((s) => s.name))
  let names: string[]
  try { names = io.readdir(staging) } catch { return false }
  return names.every((name) => {
    if (!skills.has(name)) return false
    const built = path.join(staging, name)
    const b = io.lstat(built)
    if (!b || !b.dir || b.link) return false
    if (isOurs(io, built)) return true
    try { return io.readdir(built).every((n) => HALF_WRITTEN_RE.test(n)) } catch { return false }
  })
}

/** ADR-009 round 2: the staging folders a crash left in `skills/` go at each
 *  stage and each removal: one that is the app's, whole; a link at that name,
 *  as the link itself (never followed); anything else is left alone. */
function sweepStaging(io: RealmSkillsIo, skillsDir: string, where: string): void {
  let names: string[]
  try { names = io.readdir(skillsDir) } catch { return }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    const p = path.join(skillsDir, name)
    try {
      const st = io.lstat(p)
      if (!st) continue
      if (st.link) io.removeEntry(p)
      else if (stagingIsOurs(io, p)) io.removeTree(p)
      else logInfo(`[codex-skills] a staging folder in ${where} is not the app's; left alone`)
    } catch (err) {
      logWarn(`[codex-skills] a staging folder in ${where} could not be removed: ${(err as Error)?.message ?? err}`)
    }
  }
}

/** Every skill, skipped for one reason: nothing could be tried. */
function allSkipped(outcome: Exclude<RealmSkillsOutcome, { staged: true }>): CanvasSkillsStaging {
  // A home or skills folder that is not a real folder is not a skill of that
  // name, so it is never reported as one that is not the app's.
  const reason: SkippedCanvasSkill['reason'] = outcome.reason === 'link' ? 'link' : 'failed'
  return { outcome, skipped: canvasSkillFiles().map((s) => ({ name: s.name, reason })) }
}

export interface StageCanvasSkillsOptions {
  /** Whose folder, for the log. */
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
 * link standing at the skill's name (it fails instead). The placed folder is
 * checked again, by identity and bytes, before the skill counts as staged.
 */
export function stageCanvasSkillsIn(home: string, skillsDir: string | null, opts: StageCanvasSkillsOptions, io: RealmSkillsIo = realRealmSkillsIo): CanvasSkillsStaging {
  const where = PLACE_WORDS[opts.place] ?? PLACE_WORDS.managed
  const checked = realmChecked(io, home, skillsDir)
  if (!('skillsDir' in checked)) return allSkipped(checked as Exclude<RealmSkillsOutcome, { staged: true }>)
  const dirOf = checked.skillsDir
  if (checked.skillsMissing && opts.onlyExisting) return { outcome: { staged: true }, skipped: [] }
  let outcome: RealmSkillsOutcome = { staged: true }
  const skipped: SkippedCanvasSkill[] = []
  const skip = (name: string, reason: SkippedCanvasSkill['reason']): void => {
    skipped.push({ name, reason })
    if (outcome.staged) outcome = { staged: false, reason }
  }
  try {
    io.mkdirChecked(dirOf)
    const skillsId = folderId(io, dirOf)
    if (!skillsId) return allSkipped({ staged: false, reason: 'link' })
    sweepStaging(io, dirOf, where)
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
        if (st && !isOurs(io, dir)) {
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
        // The app's earlier folder goes, checked again just before.
        const now = io.lstat(dir)
        if (now) {
          if (now.link || !isOurs(io, dir)) {
            logWarn(`[codex-skills] the ${skill.name} skill folder changed while the skill was built; left alone, the skill not staged`)
            skip(skill.name, now.link ? 'link' : 'not-ours')
            continue
          }
          io.removeTree(dir)
        }
        io.rename(built, dir)
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

/**
 * Remove the app's staged skills from `<home>/skills` (`skillsDir`, exactly
 * that): only folders holding the app's exact mark, never through a link,
 * never a folder that is not the app's. Never throws. `clear` when none of
 * the app's skill folders is left there afterwards (or the folder cannot be
 * reached without a link, so the app never will reach it); `kept` when one
 * of the app's could not be removed.
 */
export function removeCanvasSkillsFrom(home: string, skillsDir: string | null, place: CanvasSkillsPlace, io: RealmSkillsIo = realRealmSkillsIo): 'clear' | 'kept' {
  const where = PLACE_WORDS[place] ?? PLACE_WORDS.managed
  let left: 'clear' | 'kept' = 'clear'
  try {
    const checked = realmChecked(io, home, skillsDir)
    if (!('skillsDir' in checked) || checked.skillsMissing) return 'clear'
    sweepStaging(io, checked.skillsDir, where)
    for (const skill of canvasSkillFiles()) {
      const dir = path.join(checked.skillsDir, skill.name)
      try {
        if (isOurs(io, dir)) io.removeTree(dir)
        if (isOurs(io, dir)) left = 'kept'
      } catch (err) {
        left = 'kept'
        logWarn(`[codex-skills] the ${skill.name} skill could not be removed from ${where}: ${(err as Error)?.message ?? err}`)
      }
    }
  } catch (err) {
    left = 'kept'
    logWarn(`[codex-skills] the canvas skills could not be checked for removal in ${where}: ${(err as Error)?.message ?? err}`)
  }
  return left
}

/** Whether any of the app's skill folders stands in `<home>/skills`, reached
 *  without a link (the home and the skills folder real folders). */
export function canvasSkillsPresent(home: string, skillsDir: string | null, io: RealmSkillsIo = realRealmSkillsIo): boolean {
  try {
    const checked = realmChecked(io, home, skillsDir)
    if (!('skillsDir' in checked) || checked.skillsMissing) return false
    return canvasSkillFiles().some((skill) => isOurs(io, path.join(checked.skillsDir, skill.name)))
  } catch {
    return false
  }
}

/** stageCanvasSkillsIn for a managed realm, skill by skill. `managedSkillsDir`
 *  is the one the Codex package gave for `home` (null: not a managed realm's,
 *  and nothing is staged). */
export function stageCodexRealmSkillsDetail(home: string, managedSkillsDir: string | null, io: RealmSkillsIo = realRealmSkillsIo): CanvasSkillsStaging {
  return stageCanvasSkillsIn(home, managedSkillsDir, { place: 'managed' }, io)
}

/** Stage the skills into a managed realm before a launch, while the built-in
 *  tools are on (stageCanvasSkillsIn). */
export function stageCodexRealmSkills(home: string, managedSkillsDir: string | null, io: RealmSkillsIo = realRealmSkillsIo): RealmSkillsOutcome {
  return stageCodexRealmSkillsDetail(home, managedSkillsDir, io).outcome
}

/**
 * Remove the app's staged skills from a managed realm (the built-in tools
 * are off): only folders holding the app's exact mark, never through a link,
 * never a folder that is not the app's. Never throws.
 */
export function removeCodexRealmSkills(home: string, managedSkillsDir: string | null, io: RealmSkillsIo = realRealmSkillsIo): void {
  removeCanvasSkillsFrom(home, managedSkillsDir, 'managed', io)
}
