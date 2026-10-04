// How the Agent Canvas, canvas-plan and Conductor vision guidance reaches a
// Codex session (WP2 PR 4, P4.1, row 51; section 10 question 5, answered C by
// the owner on 2026-10-04; the PR 4 VM probe PB1).
//
// Claude gets the three skills from the app's plugin (--plugin-dir) while the
// built-in tools are on. A Codex session gets the same three skills in its
// account's own skills folder, which Codex lists for every session started
// with that folder, whatever the route (the executable, the npm command, the
// resume picker):
//  - a MANAGED account: staged in its realm's `skills/`, the app's own folder
//    (codex-realm-skills.ts);
//  - THIS COMPUTER'S OWN SIGN-IN: copied into the user's own Codex skills
//    folder (codex-user-skills.ts), only the app's own marked folders, never
//    a skill of the user's own with the same name;
//  - with the built-in tools off: none, and the app's copies removed from
//    that account's folder.
// Nothing rides the launch line any more (option A's developer instructions
// are gone). The canvas page says so in one line only when a skill could not
// be put in place, and which (the session's guidance record below, read
// through `canvas:sessionGuidance`).
import type { CanvasSessionGuidance } from '../../shared/types'
import type { RealmOwnership } from '../../shared/providers'
import { canvasSkillFiles } from './canvas-plugin'
import { stageCodexRealmSkillsDetail, removeCodexRealmSkills, type CanvasSkillsStaging, type RealmSkillsIo } from './codex-realm-skills'
import { stageCodexUserSkills, removeCodexUserSkills, type CodexUserSkillsDeps } from './codex-user-skills'
import { logWarn } from '../debug-logger'

export interface CodexLaunchGuidanceInput {
  /** The account's Codex folder (CODEX_HOME) as the launch prepared it. */
  home: string
  /** The built-in tools reach this launch (on, and the server listening). */
  toolsOn: boolean
  /** An app-managed account (codex-canvas-launch.ts codexManagedSkillsFolder),
   *  and its skills folder by the Codex package's path rule (null: the rule
   *  does not find it, and nothing is staged). */
  managed: boolean
  managedSkillsDir: string | null
  /** The package's path rule for this home, whatever the ownership says: a
   *  home it takes for a managed realm's is never the user's own folder. */
  ruleSkillsDir: string | null
  /** The account's realm as the launch prepared it. Only `external-default`
   *  (this computer's own sign-in) gets the user's own folder written. */
  ownership?: RealmOwnership
}

export interface CodexLaunchGuidanceDeps extends CodexUserSkillsDeps {
  /** A managed realm's staging file system (default: the disk). */
  realmIo?: RealmSkillsIo
}

const skillNames = (): string[] => canvasSkillFiles().map((s) => s.name)

/** No skill in place: every one named. */
export function codexGuidanceNotStaged(): CanvasSessionGuidance {
  return { guidance: 'tools-only', reason: 'skills-not-staged', skills: skillNames() }
}

/** What a staging gave the session: every skill in place (`full`), or the
 *  ones that are not, and why: only skills of that name that are not the
 *  app's (`own-skill`: in the user's own folder, the user's own skill, which
 *  the app never replaces), or anything else (`skills-not-staged`). */
export function codexGuidanceFromStaging(staging: CanvasSkillsStaging): CanvasSessionGuidance {
  if (staging.outcome.staged) return { guidance: 'full' }
  const skills = staging.skipped.map((s) => s.name)
  if (skills.length === 0) return codexGuidanceNotStaged()
  const own = staging.skipped.every((s) => s.reason === 'not-ours')
  return { guidance: 'tools-only', reason: own ? 'own-skill' : 'skills-not-staged', skills }
}

/**
 * The skills for one launch, and what the session gets for the canvas page;
 * null with the built-in tools off (nothing recorded). Never throws.
 */
export function codexLaunchGuidance(input: CodexLaunchGuidanceInput, deps: CodexLaunchGuidanceDeps = {}): CanvasSessionGuidance | null {
  try {
    if (input.managed) {
      if (!input.toolsOn) {
        removeCodexRealmSkills(input.home, input.managedSkillsDir, deps.realmIo)
        return null
      }
      // All three while the tools are on, whichever tool groups are on, as
      // Claude's --plugin-dir (review RA-1): conductor-vision is what tells a
      // session with Vision off where the switch is.
      return codexGuidanceFromStaging(stageCodexRealmSkillsDetail(input.home, input.managedSkillsDir, deps.realmIo))
    }
    // This computer's own sign-in, by its realm (review A-2), and only at a
    // home the managed path rule does not take: never an account it cannot
    // tell, whose folder is nobody's to write.
    const own = input.ownership === 'external-default' && input.ruleSkillsDir === null
    if (!input.toolsOn) {
      if (own) removeCodexUserSkills(input.home, deps)
      return null
    }
    if (!own) return codexGuidanceNotStaged()
    return codexGuidanceFromStaging(stageCodexUserSkills(input.home, deps))
  } catch (err) {
    logWarn(`[codex-canvas] the canvas skills for a launch could not be prepared: ${(err as Error)?.message ?? err}`)
    return input.toolsOn ? codexGuidanceNotStaged() : null
  }
}

// -- The session record ----------------------------------------------------

/** At most this many sessions' records are kept, the oldest let go first. */
export const CODEX_GUIDANCE_RECORDS_MAX = 512

const records = new Map<string, CanvasSessionGuidance>()

/**
 * What a launch carried, by the route it took. The skills are in the
 * account's own folder, which every conversation lists whatever the route,
 * so the route no longer changes it. Kept while the PTY manager still asks;
 * the integration patch that stops asking removes it.
 */
export function codexGuidanceAsLaunched(
  launch: { guidance: CanvasSessionGuidance | null },
  _route: { viaPicker: boolean },
): CanvasSessionGuidance | null {
  return launch.guidance
}

/** What a Codex session's launch carried, for the canvas page's line. */
export function noteCodexSessionGuidance(sessionId: string, guidance: CanvasSessionGuidance): void {
  records.delete(sessionId)
  records.set(sessionId, guidance)
  while (records.size > CODEX_GUIDANCE_RECORDS_MAX) {
    const oldest = records.keys().next().value
    if (oldest === undefined) break
    records.delete(oldest)
  }
}

/** The session's record: null for a session with none (not a Codex session,
 *  the built-in tools off, or not launched this run). */
export function codexSessionGuidance(sessionId: string): CanvasSessionGuidance | null {
  return records.get(sessionId) ?? null
}

export function forgetCodexSessionGuidance(sessionId: string): void {
  records.delete(sessionId)
}

/** Test seam. */
export function _resetCodexGuidanceForTest(): void {
  records.clear()
}
