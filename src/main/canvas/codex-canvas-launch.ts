// What a Codex launch needs for the Agent Canvas (WP2 PR 4, P4.1, row 51),
// decided in one place so the Codex branch of pty-manager.ts stays small:
//  - the worktree CCC designates for the session (CCC_SESSION_WORKTREE), as a
//    Claude session's (codex-canvas-roots.ts);
//  - the skills' guidance: staged into a managed account's realm, or passed
//    as developer instructions on this computer's own sign-in (question 5's
//    default A), or neither, and the record the canvas page reads
//    (codex-guidance.ts);
//  - with the built-in tools off: no guidance, and a managed realm's staged
//    skills removed, as Claude gets --plugin-dir only while they are on.
import * as path from 'path'
import type { CanvasSessionGuidance } from '../../shared/types'
import { getResourcesDirectory } from '../ipc/setup-handlers'
import { ensureCanvasPlugin } from './canvas-plugin'
import { codexDesignatedWorktree } from './codex-canvas-roots'
import { stageCodexRealmSkills, removeCodexRealmSkills } from './codex-realm-skills'
import { decideCodexGuidance } from './codex-guidance'
import { logWarn } from '../debug-logger'

export interface CodexCanvasLaunchInput {
  sessionId: string
  /** The session's CONFIGURED project directory, resolved (never a resumed
   *  conversation's folder). */
  configuredCwd: string
  /** The account's Codex folder (CODEX_HOME). */
  home: string
  /** The launch route (the Codex package's SessionProvider.launchRoute). */
  route: 'direct' | 'cmd'
  /** The skills folder the Codex package gives a home under a resources
   *  folder (SessionProvider.stagedSkillsDir): a managed account's own, else
   *  null (this computer's own sign-in). */
  managedSkillsDirFor: (home: string, resourcesDir: string) => string | null
  /** The Codex version discovery proved, when known. */
  cliVersion: string | null
  /** The built-in tools reach this launch (on, and the server listening). */
  toolsOn: boolean
  /** The folders Codex may start in, or null when the resume picker chooses. */
  startFolders: readonly string[] | null
  env: Readonly<Record<string, string | undefined>>
  platform?: NodeJS.Platform
}

export interface CodexCanvasLaunch {
  designatedWorktree: string | null
  developerInstructions?: string
  /** What the launch carries, for the canvas page; null with the tools off. */
  guidance: CanvasSessionGuidance | null
}

/** Never throws: a launch is never stopped by its canvas guidance (the
 *  worktree is kept; the guidance is then recorded as unknown). */
export function prepareCodexCanvasLaunch(input: CodexCanvasLaunchInput): CodexCanvasLaunch {
  const designatedWorktree = codexDesignatedWorktree(input.configuredCwd, input.sessionId)
  try {
    return { designatedWorktree, ...guidanceFor(input) }
  } catch (err) {
    logWarn(`[codex-canvas] the canvas guidance for ${input.sessionId} could not be prepared: ${(err as Error)?.message ?? err}`)
    return { designatedWorktree, guidance: input.toolsOn ? { guidance: 'tools-only', reason: 'unknown-settings' } : null }
  }
}

function guidanceFor(input: CodexCanvasLaunchInput): Omit<CodexCanvasLaunch, 'designatedWorktree'> {
  const platform = input.platform ?? process.platform
  let resourcesDir = ''
  try { resourcesDir = getResourcesDirectory() || '' } catch { resourcesDir = '' }
  // A managed realm's home sits directly under the managed realms root, and
  // this computer's own sign-in never can (realm-paths.ts refuses an overlap
  // either way), so the path alone tells the two apart.
  const managedSkillsDir = resourcesDir ? input.managedSkillsDirFor(input.home, resourcesDir) : null
  const managed = managedSkillsDir !== null
  if (!input.toolsOn) {
    if (managed) removeCodexRealmSkills(input.home, managedSkillsDir)
    return { guidance: null }
  }
  const managedSkills = managed ? stageCodexRealmSkills(input.home, managedSkillsDir) : undefined
  let pluginSkillsDir: string | null = null
  if (!managed && platform !== 'win32' && input.route === 'direct') {
    const pluginDir = ensureCanvasPlugin()
    pluginSkillsDir = pluginDir ? path.join(pluginDir, 'skills') : null
  }
  const decision = decideCodexGuidance({
    platform,
    route: input.route,
    external: !managed,
    ...(managedSkills ? { managedSkills } : {}),
    cliVersion: input.cliVersion,
    home: input.home,
    cwds: input.startFolders,
    pluginSkillsDir,
    env: input.env,
  })
  return { guidance: decision.guidance, ...(decision.developerInstructions ? { developerInstructions: decision.developerInstructions } : {}) }
}
