// What a Codex launch needs for the Agent Canvas (WP2 PR 4, P4.1, row 51),
// decided in one place so the Codex branch of pty-manager.ts stays small:
//  - the worktree CCC designates for the session (CCC_SESSION_WORKTREE), as a
//    Claude session's (codex-canvas-roots.ts);
//  - the skills, in the account's own skills folder (codex-guidance.ts): a
//    managed account's realm, or this computer's own Codex folder (section 10
//    question 5, answered C), and the record the canvas page reads;
//  - with the built-in tools off: none, and the app's staged skills removed
//    from that account's folder, as Claude gets --plugin-dir only while they
//    are on (from this computer's own Codex folder only when their switch is
//    off, not when the server is merely not listening).
import * as fs from 'fs'
import type { CanvasSessionGuidance } from '../../shared/types'
import type { RealmOwnership } from '../../shared/providers'
import { getResourcesDirectory } from '../ipc/setup-handlers'
import { readConfig } from '../config-manager'
import { codexDesignatedWorktree } from './codex-canvas-roots'
import { codexLaunchGuidance, codexGuidanceNotStaged } from './codex-guidance'
import { logWarn } from '../debug-logger'

export interface CodexCanvasLaunchInput {
  sessionId: string
  /** The session's CONFIGURED project directory, resolved (never a resumed
   *  conversation's folder). */
  configuredCwd: string
  /** The account's Codex folder (CODEX_HOME). */
  home: string
  /** The skills folder the Codex package gives a home under a resources
   *  folder (SessionProvider.stagedSkillsDir): a managed account's own, else
   *  null (this computer's own sign-in). */
  managedSkillsDirFor: (home: string, resourcesDir: string) => string | null
  /** The built-in tools reach this launch (on, and the server listening). */
  toolsOn: boolean
  /** The account's realm, as the launch prepared it: an app-managed one or
   *  this computer's own sign-in (review A-2). Absent: told by path alone,
   *  and never this computer's own folder to write into. */
  ownership?: RealmOwnership
}

/**
 * Whether the launch's account is an app-managed one, and its skills folder
 * (review A-2). The realm's ownership decides when the launch carries it; the
 * path rule (the Codex package's stagedSkillsDir) is the second guard, held
 * against the resources folder's REAL path, because the account's home is a
 * real path and the resources folder may be reached through a junction or a
 * mapped path. A managed account whose folder the rule does not find gets no
 * skills (said as not staged). Without an ownership it is the rule alone.
 */
export function codexManagedSkillsFolder(
  input: { ownership?: RealmOwnership; home: string; resourcesDir: string; managedSkillsDirFor: (home: string, resourcesDir: string) => string | null },
  realpath: (p: string) => string = (p) => fs.realpathSync.native(p),
): { managed: boolean; skillsDir: string | null } {
  let real = ''
  if (input.resourcesDir) { try { real = realpath(input.resourcesDir) } catch { real = input.resourcesDir } }
  const skillsDir = real ? input.managedSkillsDirFor(input.home, real) : null
  const managed = input.ownership === 'conductor-managed' ? true : input.ownership === 'external-default' ? false : skillsDir !== null
  return { managed, skillsDir: managed ? skillsDir : null }
}

export interface CodexCanvasLaunch {
  designatedWorktree: string | null
  /** What the launch carries, for the canvas page; null with the tools off. */
  guidance: CanvasSessionGuidance | null
}

/** Never throws: a launch is never stopped by its canvas skills (the
 *  worktree is kept; the skills are then recorded as not staged). */
export function prepareCodexCanvasLaunch(input: CodexCanvasLaunchInput): CodexCanvasLaunch {
  const designatedWorktree = codexDesignatedWorktree(input.configuredCwd, input.sessionId)
  try {
    return { designatedWorktree, guidance: guidanceFor(input) }
  } catch (err) {
    logWarn(`[codex-canvas] the canvas skills for ${input.sessionId} could not be prepared: ${(err as Error)?.message ?? err}`)
    return { designatedWorktree, guidance: input.toolsOn ? codexGuidanceNotStaged() : null }
  }
}

/** The Built-in Tools switch is off in the saved settings. */
function toolsSwitchedOff(): boolean {
  try { return readConfig<{ conductorToolsEnabled?: boolean }>('settings')?.conductorToolsEnabled === false } catch { return false }
}

function guidanceFor(input: CodexCanvasLaunchInput): CanvasSessionGuidance | null {
  let resourcesDir = ''
  try { resourcesDir = getResourcesDirectory() || '' } catch { resourcesDir = '' }
  const { managed, skillsDir } = codexManagedSkillsFolder({ ownership: input.ownership, home: input.home, resourcesDir, managedSkillsDirFor: input.managedSkillsDirFor })
  // The path rule's own answer, whatever the ownership: a home it takes for a
  // managed realm's is never written into as this computer's own folder.
  const ruleSkillsDir = codexManagedSkillsFolder({ home: input.home, resourcesDir, managedSkillsDirFor: input.managedSkillsDirFor }).skillsDir
  return codexLaunchGuidance({
    home: input.home,
    toolsOn: input.toolsOn,
    // Review B-S6: the user's own folder follows the Built-in Tools switch
    // itself, as the saved settings hold it (settings that cannot be read
    // say nothing is switched off).
    toolsSwitchedOff: toolsSwitchedOff(),
    managed,
    managedSkillsDir: skillsDir,
    ruleSkillsDir,
    ...(input.ownership ? { ownership: input.ownership } : {}),
  })
}
