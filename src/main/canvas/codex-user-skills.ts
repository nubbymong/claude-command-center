// The Agent Canvas, canvas-plan and Conductor vision skills in THIS
// COMPUTER'S OWN Codex sign-in's skills folder (WP2 PR 4, row 51; section 10
// question 5, answered C by the owner on 2026-10-04: the app copies its three
// skills into the user's own Codex skills folder, `~/.codex/skills`, or
// `skills/` in the folder CODEX_HOME names, and removes them when Codex or
// the built-in tools are turned off). Codex lists them for every session that
// uses that folder, however it is started; outside the app they name tools
// that are not there, since the canvas is an MCP server the app registers
// only while it runs.
//
// Which folder: the home the launch prepared for this computer's own sign-in
// (the Codex package's external default, the CODEX_HOME the app inherited or
// `~/.codex`, taken at its real path), handed in by the launch
// (codex-guidance.ts codexLaunchGuidance); this module resolves none itself.
// Each such folder is written into the app's record (CODEX_USER_SKILLS_RECORD,
// in the app's own data folder) BEFORE anything is copied there, so a switch
// turned off later, in this run or another, finds every folder the app may
// have written to. No record, no copy. A record that cannot be read refuses
// both copying and removing until it can. One that does not parse is kept
// aside under a name of its own (never replacing one kept aside before) and
// refused for that pass; the next pass starts a new record and takes back
// every folder a kept-aside record still names in full, letting the
// kept-aside file go once they are all recorded again (a folder whose name
// the damage cut is no longer tracked until a launch records it again).
// A folder leaves the record only once none of the app's copies is left in
// it, or it is really gone (nothing there, its parent present): one that
// cannot be read now (an offline share, a denied folder) stays recorded.
//
// What is written and removed: only the app's own skill folders, each
// carrying the app's ownership mark (codex-realm-skills.ts, the same staging,
// with the same link and race refusals). A skill of the user's own with the
// same name (no mark) is never touched: that skill is skipped, and the launch
// says so on the canvas page.
//
// When (startCodexUserSkills, wired by the composition root):
//  - before a launch on this computer's sign-in: copied while the built-in
//    tools are on, removed while their switch is off (codexLaunchGuidance);
//  - when Codex or the built-in tools are turned off (a settings save, or a
//    change the accounts service announces), and once after the app starts:
//    removed from every recorded folder;
//  - while both are on, once after the app starts and when one is turned
//    back on: the app's copies already there are made exact again (an app
//    update changes their text); no folder gets new ones (a launch does).
import * as fs from 'fs'
import * as path from 'path'
import { atomicWriteSecure } from '../account-profiles'
import { getDataDirectory } from '../ipc/setup-handlers'
import { canvasSkillFiles } from './canvas-plugin'
import { logInfo, logWarn } from '../debug-logger'
import { stageCanvasSkillsIn, removeCanvasSkillsFrom, canvasSkillsLeft, realRealmSkillsIo, type CanvasSkillsStaging, type RealmSkillsIo } from './codex-realm-skills'

/** The record's file name, in the app's data folder. */
export const CODEX_USER_SKILLS_RECORD = 'codex-user-skills.json'
/** At most this many folders are recorded; a new one past it is not copied
 *  into (refused, never an older one let go: that would lose track of it). */
export const CODEX_USER_SKILLS_HOMES_MAX = 16
/** A record larger than this is not read. */
const RECORD_READ_MAX = 64 * 1024
/** A recorded path longer than this is not one the app wrote. */
const HOME_PATH_MAX = 1024
/** How long after start the first pass waits (past first paint). */
export const CODEX_USER_SKILLS_START_DELAY_MS = 5000

export interface CodexUserSkillsDeps {
  /** The record's file; null when there is none (default: in the app's data
   *  folder, null when that is not known). */
  recordFile?: () => string | null
  /** The staging's file system (default: the disk). */
  io?: RealmSkillsIo
  /** Whose path rules the recorded folders follow (default: this one's). */
  platform?: NodeJS.Platform
  /** The record's text (default: read from disk); throws when it cannot be
   *  read now. */
  readFile?: (file: string) => string
}

/** Beside a record that does not parse: the same name with this added. */
export const CODEX_USER_SKILLS_DAMAGED_SUFFIX = '.damaged'

function recordFileOf(deps: CodexUserSkillsDeps): string | null {
  try {
    if (deps.recordFile) return deps.recordFile()
    const data = getDataDirectory()
    return typeof data === 'string' && data && path.isAbsolute(data) ? path.join(data, CODEX_USER_SKILLS_RECORD) : null
  } catch {
    return null
  }
}

/** A path the app could have recorded: absolute and anchored (on Windows a
 *  drive or a share, never relative to the current drive), bounded. */
function fullyQualified(p: unknown, platform: NodeJS.Platform): p is string {
  if (typeof p !== 'string' || !p || p.length > HOME_PATH_MAX || p.includes('\0')) return false
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+/.test(p)
  return path.posix.isAbsolute(p)
}

/** The same folder: letter case folded on Windows only, whose file system
 *  does not tell names apart by case; a macOS or Linux volume can, so two
 *  folders that differ only in case stay two (review L1-3). */
function sameHome(a: string, b: string, platform: NodeJS.Platform): boolean {
  const x = path.resolve(a).replace(/[\\/]+$/, '')
  const y = path.resolve(b).replace(/[\\/]+$/, '')
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

type RecordRead = { ok: true; file: string; homes: string[] } | { ok: false }

/** How many records kept aside are kept at most (`.damaged`, `.damaged.1` ...):
 *  one past them is left in place, and so refused again, rather than
 *  replacing one kept before (ADR-009 delta L1-6). */
const KEPT_ASIDE_MAX = 10

/** The names a record kept aside may have, in order. */
function keptAsideNames(file: string): string[] {
  return Array.from({ length: KEPT_ASIDE_MAX }, (_, i) => `${file}${CODEX_USER_SKILLS_DAMAGED_SUFFIX}${i === 0 ? '' : `.${i}`}`)
}

/** Nothing at all at `p` (a file, folder or link there all count). */
function nameIsFree(p: string): boolean {
  try { fs.lstatSync(p); return false } catch (err) { return (err as NodeJS.ErrnoException)?.code === 'ENOENT' }
}

/** A record that does not parse is kept aside, beside it, under the first
 *  name not already taken, so nothing it held is lost without a trace and
 *  no record kept aside before is replaced; the next pass starts a new one.
 *  Left in place (and so refused again) when it cannot be moved. */
function setAside(file: string): void {
  const to = keptAsideNames(file).find(nameIsFree)
  if (!to) {
    logWarn('[codex-skills] the record of this computer\'s Codex folders does not read as the app wrote it, and every name for keeping it aside is taken; it is left as it is')
    return
  }
  try {
    fs.renameSync(file, to)
    logWarn('[codex-skills] the record of this computer\'s Codex folders does not read as the app wrote it; it is kept aside and a new one is started at the next pass')
  } catch (err) {
    logWarn(`[codex-skills] the record of this computer's Codex folders does not read as the app wrote it, and could not be kept aside: ${(err as Error)?.message ?? err}`)
  }
}

/** The folders a record's text names: its `homes` list when it parses as the
 *  app's record, else every whole JSON string in it (a record cut off part-way
 *  still names its earlier folders in full); only fully qualified ones. */
function homesNamedIn(text: string, platform: NodeJS.Platform): string[] {
  let names: unknown[] = []
  try {
    const parsed = JSON.parse(text) as { homes?: unknown }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.homes)) names = parsed.homes
  } catch {
    for (const m of text.matchAll(/"((?:[^"\\\r\n]|\\.)*)"/g)) {
      try { names.push(JSON.parse(`"${m[1]}"`)) } catch { /* not a whole string */ }
    }
  }
  return names.filter((h): h is string => fullyQualified(h, platform))
}

/** ADR-009 delta L1-6: the folders the records kept aside still name are taken
 *  back into the record (`homes`, the record as read), so a switch turned off
 *  finds them again; a kept-aside file goes once every folder it names is in
 *  the record (written first). One the app reads no folder from stays as it
 *  is, for a person to read. Returns the record's folders, the taken-back ones
 *  included. */
function takeBackKeptAside(file: string, homes: string[], deps: CodexUserSkillsDeps, platform: NodeJS.Platform): string[] {
  const merged = [...homes]
  const done: string[] = []
  for (const kept of keptAsideNames(file)) {
    let st: fs.Stats
    try { st = fs.lstatSync(kept) } catch { continue }
    if (!st.isFile() || st.isSymbolicLink() || st.size > RECORD_READ_MAX) continue
    let text: string
    try { text = deps.readFile ? deps.readFile(kept) : fs.readFileSync(kept, 'utf8') } catch { continue }
    const named = homesNamedIn(text, platform)
    if (named.length === 0) continue
    let all = true
    for (const h of named) {
      if (merged.some((k) => sameHome(k, h, platform))) continue
      if (merged.length >= CODEX_USER_SKILLS_HOMES_MAX) { all = false; continue }
      merged.push(path.resolve(h))
    }
    if (all) done.push(kept)
  }
  if (merged.length > homes.length && !writeRecord(file, merged)) return merged
  for (const kept of done) {
    try {
      fs.unlinkSync(kept)
      logInfo('[codex-skills] the folders a record kept aside named are recorded again; the kept-aside record is let go')
    } catch { /* kept; asked again next time */ }
  }
  return merged
}

/** The record: absent is empty. One that is not a plain file, too large, or
 *  cannot be read now is refused (nothing is copied, nothing removed; asked
 *  again at the next pass). One that does not parse as the app's record is
 *  kept aside and refused for this pass (review B-Q2); the folders any record
 *  kept aside still names are taken back (takeBackKeptAside). */
function readRecord(deps: CodexUserSkillsDeps): RecordRead {
  const file = recordFileOf(deps)
  const platform = deps.platform ?? process.platform
  if (!file) return { ok: false }
  let st: fs.Stats
  try { st = fs.lstatSync(file) } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ENOENT' ? { ok: true, file, homes: takeBackKeptAside(file, [], deps, platform) } : { ok: false }
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > RECORD_READ_MAX) return { ok: false }
  let text: string
  try { text = deps.readFile ? deps.readFile(file) : fs.readFileSync(file, 'utf8') } catch (err) {
    logWarn(`[codex-skills] the record of this computer's Codex folders could not be read now: ${(err as Error)?.message ?? err}`)
    return { ok: false }
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch { parsed = null }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { homes?: unknown }).homes)) {
    setAside(file)
    return { ok: false }
  }
  const raw = (parsed as { homes: unknown[] }).homes
  const homes: string[] = []
  for (const h of raw) {
    if (homes.length >= CODEX_USER_SKILLS_HOMES_MAX) break
    if (fullyQualified(h, platform) && !homes.some((k) => sameHome(k, h, platform))) homes.push(path.resolve(h))
  }
  return { ok: true, file, homes: takeBackKeptAside(file, homes, deps, platform) }
}

function writeRecord(file: string, homes: readonly string[]): boolean {
  try {
    atomicWriteSecure(file, `${JSON.stringify({ homes }, null, 2)}\n`, 0o600)
    return true
  } catch (err) {
    logWarn(`[codex-skills] the record of this computer's Codex folders could not be written: ${(err as Error)?.message ?? err}`)
    return false
  }
}

/** Nothing copied: every skill reported, as a write that could not be made. */
function notCopied(): CanvasSkillsStaging {
  return { outcome: { staged: false, reason: 'failed' }, skipped: canvasSkillFiles().map((s) => ({ name: s.name, reason: 'failed' as const })) }
}

/**
 * Copy the skills into this computer's own Codex folder, `home` (the launch's
 * home for that sign-in): recorded first, then staged into `<home>/skills`.
 * A user's own skill of the same name is left as it is and reported in
 * `skipped` (`not-ours`). Never throws.
 */
export function stageCodexUserSkills(home: string, deps: CodexUserSkillsDeps = {}): CanvasSkillsStaging {
  const platform = deps.platform ?? process.platform
  try {
    if (!fullyQualified(home, platform)) return notCopied()
    const rec = readRecord(deps)
    if (!rec.ok) {
      logWarn('[codex-skills] there is no record of this computer\'s Codex folders to write to; the canvas skills are not copied')
      return notCopied()
    }
    if (!rec.homes.some((h) => sameHome(h, home, platform))) {
      if (rec.homes.length >= CODEX_USER_SKILLS_HOMES_MAX) {
        logWarn('[codex-skills] the record of this computer\'s Codex folders is full; the canvas skills are not copied into another')
        return notCopied()
      }
      if (!writeRecord(rec.file, [...rec.homes, path.resolve(home)])) return notCopied()
    }
    return stageCanvasSkillsIn(home, path.join(home, 'skills'), { place: 'own' }, deps.io ?? realRealmSkillsIo)
  } catch (err) {
    logWarn(`[codex-skills] the canvas skills could not be copied into this computer's Codex folder: ${(err as Error)?.message ?? err}`)
    return notCopied()
  }
}

/** Drop folders from the record (those `drop` says), written only when it changes. */
function forget(deps: CodexUserSkillsDeps, drop: (home: string) => boolean): void {
  const rec = readRecord(deps)
  if (!rec.ok) return
  const keep = rec.homes.filter((h) => !drop(h))
  if (keep.length !== rec.homes.length) writeRecord(rec.file, keep)
}

/** Remove the app's copies from `home` (only its marked folders, never
 *  through a link); the record lets the folder go once none is left
 *  (removeCanvasSkillsFrom says `clear` only then). Never throws. */
export function removeCodexUserSkills(home: string, deps: CodexUserSkillsDeps = {}): void {
  const platform = deps.platform ?? process.platform
  try {
    if (!fullyQualified(home, platform)) return
    const left = removeCanvasSkillsFrom(home, path.join(home, 'skills'), 'own', deps.io ?? realRealmSkillsIo)
    if (left === 'clear') forget(deps, (h) => sameHome(h, home, platform))
  } catch (err) {
    logWarn(`[codex-skills] the canvas skills could not be removed from this computer's Codex folder: ${(err as Error)?.message ?? err}`)
  }
}

/**
 * Every recorded folder, by the switches: `wanted` (Codex and the built-in
 * tools on), the app's copies already there are made exact again and none is
 * added; otherwise they are removed. A folder holding none of the app's
 * copies afterwards leaves the record; one that cannot be read now stays in
 * it (canvasSkillsLeft). Never throws.
 */
export function reconcileCodexUserSkills(wanted: boolean, deps: CodexUserSkillsDeps = {}): void {
  const platform = deps.platform ?? process.platform
  const io = deps.io ?? realRealmSkillsIo
  try {
    const rec = readRecord(deps)
    if (!rec.ok || rec.homes.length === 0) return
    const gone: string[] = []
    for (const home of rec.homes) {
      const skillsDir = path.join(home, 'skills')
      if (wanted) {
        stageCanvasSkillsIn(home, skillsDir, { place: 'own', onlyExisting: true }, io)
        if (canvasSkillsLeft(home, skillsDir, 'own', io) === 'none') gone.push(home)
      } else if (removeCanvasSkillsFrom(home, skillsDir, 'own', io) === 'clear') {
        gone.push(home)
      }
    }
    if (gone.length > 0) forget(deps, (h) => gone.some((g) => sameHome(g, h, platform)))
  } catch (err) {
    logWarn(`[codex-skills] this computer's Codex folders could not be brought in line with the switches: ${(err as Error)?.message ?? err}`)
  }
}

/** The recorded folders (for the tests and the log). */
export function codexUserSkillsHomes(deps: CodexUserSkillsDeps = {}): string[] {
  const rec = readRecord(deps)
  return rec.ok ? rec.homes : []
}

// -- When ---------------------------------------------------------------------

export interface CodexUserSkillsWiring {
  /** The app's saved settings, read now; null when they cannot be read
   *  (then nothing is copied or removed: no answer is no answer). */
  settings: () => Record<string, unknown> | null
  /** Codex is on now (its saved answer, and the switch in force). */
  codexOn: () => boolean
  /** A change announced by the accounts service (the Providers switch). */
  subscribe?: (listener: () => void) => () => void
  /** Overrides, for the tests. */
  startDelayMs?: number
  deps?: CodexUserSkillsDeps
}

/** Whether the copies are wanted now: the built-in tools on (not switched
 *  off) and Codex on; null when the settings cannot be read. */
export function codexUserSkillsWanted(w: Pick<CodexUserSkillsWiring, 'settings' | 'codexOn'>): boolean | null {
  let s: Record<string, unknown> | null
  try { s = w.settings() } catch { return null }
  if (!s || typeof s !== 'object') return null
  if (s.conductorToolsEnabled === false) return false
  try { return w.codexOn() === true } catch { return null }
}

let wiring: CodexUserSkillsWiring | null = null
let started = false
let startTimer: ReturnType<typeof setTimeout> | null = null
let unsubscribe: (() => void) | null = null
let lastWanted: boolean | null = null

function apply(force: boolean): void {
  const w = wiring
  if (!w || !started) return
  const wanted = codexUserSkillsWanted(w)
  if (wanted === null) return
  // On and unchanged: nothing to do between launches.
  if (!force && wanted && lastWanted === true) return
  if (wanted !== lastWanted) logInfo(`[codex-skills] this computer's Codex folders: the canvas skills are ${wanted ? 'kept current' : 'removed'}`)
  lastWanted = wanted
  reconcileCodexUserSkills(wanted, w.deps ?? {})
}

/** Wire the switches (the composition root, at start): one pass after the
 *  start delay, then one at every settings save and accounts change. */
export function startCodexUserSkills(w: CodexUserSkillsWiring): void {
  stopCodexUserSkills()
  wiring = w
  const t = setTimeout(() => {
    startTimer = null
    if (wiring !== w) return
    started = true
    try { unsubscribe = w.subscribe?.(() => codexUserSkillsSettingsChanged()) ?? null } catch { unsubscribe = null }
    apply(true)
  }, w.startDelayMs ?? CODEX_USER_SKILLS_START_DELAY_MS)
  ;(t as { unref?: () => void }).unref?.()
  startTimer = t
}

/** Unwire it (and a test's reset). */
export function stopCodexUserSkills(): void {
  if (startTimer) clearTimeout(startTimer)
  startTimer = null
  try { unsubscribe?.() } catch { /* already gone */ }
  unsubscribe = null
  wiring = null
  started = false
  lastWanted = null
}

/** The saved settings changed, or the accounts service announced a change:
 *  the switches applied to every recorded folder (after the start delay). */
export function codexUserSkillsSettingsChanged(): void {
  apply(false)
}
