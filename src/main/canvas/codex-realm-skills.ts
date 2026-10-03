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

export type RealmSkillsOutcome =
  | { staged: true }
  | { staged: false; reason: 'not-managed' | 'link' | 'not-ours' | 'failed' }

/** lstat, or null when there is nothing there. */
function lstatOrNull(p: string): fs.Stats | null {
  try { return fs.lstatSync(p) } catch { return null }
}

/** A real, unlinked file whose bytes are exactly `expected`. */
function fileIsExactly(file: string, expected: Buffer): boolean {
  const st = lstatOrNull(file)
  if (!st || !st.isFile() || st.size !== expected.length) return false
  try { return fs.readFileSync(file).equals(expected) } catch { return false }
}

/** The folder is the app's: a real folder holding the exact mark. */
function isOurs(dir: string): boolean {
  const st = lstatOrNull(dir)
  return !!st && st.isDirectory() && !st.isSymbolicLink() && fileIsExactly(path.join(dir, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
}

/** The app's folder holds exactly its two files, byte for byte. */
function isPristine(dir: string, skill: Buffer): boolean {
  let names: string[]
  try { names = fs.readdirSync(dir) } catch { return false }
  if (names.length !== 2 || !names.includes('SKILL.md') || !names.includes(STAGED_SKILL_MARK)) return false
  return fileIsExactly(path.join(dir, 'SKILL.md'), skill) && fileIsExactly(path.join(dir, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES)
}

/** The realm's home and its skills folder, checked: real folders, no link.
 *  `skillsDir` is the one the Codex package gave for `home` (null: not a
 *  managed realm's), and only ever `<home>/skills`. */
function realmChecked(home: string, skillsDir: string | null): { skillsDir: string } | RealmSkillsOutcome {
  if (!skillsDir || typeof home !== 'string' || !path.isAbsolute(home) || path.resolve(skillsDir) !== path.join(path.resolve(home), 'skills')) {
    return { staged: false, reason: 'not-managed' }
  }
  const homeSt = lstatOrNull(path.resolve(home))
  if (!homeSt) return { staged: false, reason: 'failed' }
  if (homeSt.isSymbolicLink() || !homeSt.isDirectory()) return { staged: false, reason: 'link' }
  const skillsSt = lstatOrNull(skillsDir)
  if (skillsSt && (skillsSt.isSymbolicLink() || !skillsSt.isDirectory())) return { staged: false, reason: skillsSt.isSymbolicLink() ? 'link' : 'not-ours' }
  return { skillsDir }
}

/**
 * Stage the skills into a managed realm before a launch, while the built-in
 * tools are on. Every skill folder ends up the app's and exactly its bytes,
 * or is left alone and reported: `staged` only when all of them are.
 */
export function stageCodexRealmSkills(home: string, managedSkillsDir: string | null): RealmSkillsOutcome {
  const checked = realmChecked(home, managedSkillsDir)
  if (!('skillsDir' in checked)) return checked
  const { skillsDir } = checked
  let outcome: RealmSkillsOutcome = { staged: true }
  const worse = (o: RealmSkillsOutcome): void => { if (outcome.staged) outcome = o }
  try {
    if (!lstatOrNull(skillsDir)) fs.mkdirSync(skillsDir)
    for (const skill of canvasSkillFiles()) {
      const dir = path.join(skillsDir, skill.name)
      const st = lstatOrNull(dir)
      if (st && st.isSymbolicLink()) {
        logWarn(`[codex-skills] a link stands at the ${skill.name} skill folder of a managed Codex account; left alone, the skill not staged`)
        worse({ staged: false, reason: 'link' })
        continue
      }
      if (st && !isOurs(dir)) {
        logInfo(`[codex-skills] a ${skill.name} skill folder the app did not stage is in a managed Codex account; left alone`)
        worse({ staged: false, reason: 'not-ours' })
        continue
      }
      if (st && isPristine(dir, skill.bytes)) continue
      // The app's own folder, not exactly its bytes (or none yet): rebuilt
      // from nothing, as the plugin folder is.
      if (st) fs.rmSync(dir, { recursive: true, force: true })
      mkdirSecure(dir)
      atomicWriteSecure(path.join(dir, 'SKILL.md'), skill.bytes, 0o600)
      atomicWriteSecure(path.join(dir, STAGED_SKILL_MARK), STAGED_SKILL_MARK_BYTES, 0o600)
      if (!isPristine(dir, skill.bytes)) worse({ staged: false, reason: 'failed' })
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
export function removeCodexRealmSkills(home: string, managedSkillsDir: string | null): void {
  try {
    const checked = realmChecked(home, managedSkillsDir)
    if (!('skillsDir' in checked)) return
    for (const skill of canvasSkillFiles()) {
      const dir = path.join(checked.skillsDir, skill.name)
      try {
        if (isOurs(dir)) fs.rmSync(dir, { recursive: true, force: true })
      } catch (err) {
        logWarn(`[codex-skills] the ${skill.name} skill could not be removed from a managed Codex account: ${(err as Error)?.message ?? err}`)
      }
    }
  } catch (err) {
    logWarn(`[codex-skills] the canvas skills could not be checked for removal in a managed Codex account: ${(err as Error)?.message ?? err}`)
  }
}
