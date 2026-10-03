// The Agent Canvas, canvas-plan and Conductor vision skills in a MANAGED
// Codex account's own skills folder (WP2 PR 4, P4.1, row 51; the PR 4 VM
// probe PB1: Codex lists the skills under its home's `skills/`, and a managed
// account's home is the app's own folder).
//
// Parity with Claude's plugin (canvas-plugin.ts, passed by --plugin-dir only
// while the built-in tools are on): staged before a launch while the tools
// are on, removed when they are off, and the bytes are the plugin's own
// Buffers, verified on every launch and never trusted from disk -- the first
// session of an account (its trust and sandbox screens) does not hold its
// preset and runs approved commands outside the sandbox (PB8), so nothing
// staged here may rely on the model being unable to write the realm.
//
// What is staged where: `<realm>/skills/<name>/SKILL.md` for each skill, and
// beside it the app's ownership mark (`.ai-code-conductor-skill`, a hidden
// file, which Codex's skill walk does not list). A skill folder is the app's
// only while it holds that mark, exact; the app rewrites or removes only its
// own folders, whole, and never a same-named folder that is not its own.
//
// Refused, with nothing written: a home that is not a managed realm's (this
// computer's own sign-in, the external default, is the user's own Codex
// folder: question 5); a link or junction at the home, at its `skills/` or at
// a skill folder; anything at a skill's name that is not the app's folder.
//
// Which homes are managed is the Codex package's path rule (realm-paths.ts
// codexManagedRealmSkillsDir), reached through the registered provider
// (SessionProvider.stagedSkillsDir): the caller hands each function the
// skills folder it gave, or null for a home that has none.
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
 *  of a fresh, unguessable name inside the realm's `skills/`. */
export const STAGING_PREFIX = '.ccc-staging-'

export type RealmSkillsOutcome =
  | { staged: true }
  | { staged: false; reason: 'not-managed' | 'link' | 'not-ours' | 'failed' }

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

/** The realm's home and its skills folder, checked: real folders, no link.
 *  `skillsDir` is the one the Codex package gave for `home` (null: not a
 *  managed realm's), and only ever `<home>/skills`. */
function realmChecked(io: RealmSkillsIo, home: string, skillsDir: string | null): { skillsDir: string } | RealmSkillsOutcome {
  if (!skillsDir || typeof home !== 'string' || !path.isAbsolute(home) || path.resolve(skillsDir) !== path.join(path.resolve(home), 'skills')) {
    return { staged: false, reason: 'not-managed' }
  }
  const homeSt = io.lstat(path.resolve(home))
  if (!homeSt) return { staged: false, reason: 'failed' }
  if (homeSt.link || !homeSt.dir) return { staged: false, reason: 'link' }
  const skillsSt = io.lstat(skillsDir)
  if (skillsSt && (skillsSt.link || !skillsSt.dir)) return { staged: false, reason: skillsSt.link ? 'link' : 'not-ours' }
  return { skillsDir }
}

/** A staging folder goes once its skill is placed or given up: whole while it
 *  is still the folder made; a link put in its place, by itself; anything
 *  else at that name is not the app's, and stays. */
function removeStaging(io: RealmSkillsIo, staging: string, id: string | null): void {
  try {
    const st = io.lstat(staging)
    if (!st) return
    if (st.link) io.removeEntry(staging)
    else if (id && st.dir && st.id === id) io.removeTree(staging)
  } catch (err) {
    logWarn(`[codex-skills] a staging folder in a managed Codex account could not be removed: ${(err as Error)?.message ?? err}`)
  }
}

/**
 * Stage the skills into a managed realm before a launch, while the built-in
 * tools are on: all of them, as Claude's --plugin-dir carries all of them
 * while the master switch is on (review RA-1). Every skill folder ends up the
 * app's and exactly its bytes, or is left alone and reported: `staged` only
 * when all of them are. One skill that cannot be written (a file held open,
 * say) is reported and does not stop the others.
 *
 * ADR-009 round 1: a skill folder is never written where it is to stand. It is
 * built in a fresh folder of an unguessable name beside the skills
 * (STAGING_PREFIX), checked to be still that folder (no link put in its place,
 * `skills/` itself still the folder it was) holding exactly the app's two
 * files, and only then renamed into place: a rename never writes through a
 * link standing at the skill's name (it fails instead). The placed folder is
 * checked again, by identity and bytes, before the skill counts as staged.
 */
export function stageCodexRealmSkills(home: string, managedSkillsDir: string | null, io: RealmSkillsIo = realRealmSkillsIo): RealmSkillsOutcome {
  const checked = realmChecked(io, home, managedSkillsDir)
  if (!('skillsDir' in checked)) return checked
  const { skillsDir } = checked
  let outcome: RealmSkillsOutcome = { staged: true }
  const worse = (o: RealmSkillsOutcome): void => { if (outcome.staged) outcome = o }
  try {
    io.mkdirChecked(skillsDir)
    const skillsId = folderId(io, skillsDir)
    if (!skillsId) return { staged: false, reason: 'link' }
    for (const skill of canvasSkillFiles()) {
      const dir = path.join(skillsDir, skill.name)
      let staging: string | null = null
      let stagingId: string | null = null
      try {
        const st = io.lstat(dir)
        if (st && st.link) {
          logWarn(`[codex-skills] a link stands at the ${skill.name} skill folder of a managed Codex account; left alone, the skill not staged`)
          worse({ staged: false, reason: 'link' })
          continue
        }
        if (st && !isOurs(io, dir)) {
          logInfo(`[codex-skills] a ${skill.name} skill folder the app did not stage is in a managed Codex account; left alone`)
          worse({ staged: false, reason: 'not-ours' })
          continue
        }
        if (st && isPristine(io, dir, skill.bytes)) continue
        // The app's own folder, not exactly its bytes (or none yet): built
        // again from nothing, as the plugin folder is, away from its place.
        staging = io.mkdtemp(path.join(skillsDir, STAGING_PREFIX))
        stagingId = folderId(io, staging)
        const built = path.join(staging, skill.name)
        if (!stagingId) throw new Error('its staging folder is not a plain folder')
        io.mkdir(built)
        const builtId = folderId(io, built)
        if (!builtId) throw new Error('its staging folder is not a plain folder')
        io.writeFile(path.join(built, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
        io.writeFile(path.join(built, 'SKILL.md'), skill.bytes)
        if (folderId(io, skillsDir) !== skillsId || folderId(io, staging) !== stagingId || folderId(io, built) !== builtId || !isPristine(io, built, skill.bytes)) {
          logWarn(`[codex-skills] the ${skill.name} skill's staging folder changed while it was built; the skill not staged`)
          worse({ staged: false, reason: 'failed' })
          continue
        }
        // The app's earlier folder goes, checked again just before.
        const now = io.lstat(dir)
        if (now) {
          if (now.link || !isOurs(io, dir)) {
            logWarn(`[codex-skills] the ${skill.name} skill folder changed while the skill was built; left alone, the skill not staged`)
            worse({ staged: false, reason: now.link ? 'link' : 'not-ours' })
            continue
          }
          io.removeTree(dir)
        }
        io.rename(built, dir)
        if (folderId(io, skillsDir) !== skillsId || folderId(io, dir) !== builtId || !isPristine(io, dir, skill.bytes)) {
          logWarn(`[codex-skills] the ${skill.name} skill folder is not the one built once placed; the skill not staged`)
          worse({ staged: false, reason: 'failed' })
        }
      } catch (err) {
        logWarn(`[codex-skills] the ${skill.name} skill could not be staged in a managed Codex account: ${(err as Error)?.message ?? err}`)
        worse({ staged: false, reason: 'failed' })
      } finally {
        if (staging) removeStaging(io, staging, stagingId)
      }
    }
  } catch (err) {
    logWarn(`[codex-skills] the canvas skills could not be staged in a managed Codex account: ${(err as Error)?.message ?? err}`)
    return { staged: false, reason: 'failed' }
  }
  return outcome
}

/**
 * Remove the app's staged skills from a managed realm (the built-in tools
 * are off): only folders holding the app's exact mark, never through a link,
 * never a folder that is not the app's. Never throws.
 */
export function removeCodexRealmSkills(home: string, managedSkillsDir: string | null, io: RealmSkillsIo = realRealmSkillsIo): void {
  try {
    const checked = realmChecked(io, home, managedSkillsDir)
    if (!('skillsDir' in checked)) return
    for (const skill of canvasSkillFiles()) {
      const dir = path.join(checked.skillsDir, skill.name)
      try {
        if (isOurs(io, dir)) io.removeTree(dir)
      } catch (err) {
        logWarn(`[codex-skills] the ${skill.name} skill could not be removed from a managed Codex account: ${(err as Error)?.message ?? err}`)
      }
    }
  } catch (err) {
    logWarn(`[codex-skills] the canvas skills could not be checked for removal in a managed Codex account: ${(err as Error)?.message ?? err}`)
  }
}
