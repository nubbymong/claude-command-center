// The GitHub CLI, started the same way wherever the app starts it: the GitHub
// panel's sign-in through gh (gh-cli-delegate.ts) and the update check's
// fallbacks (github-update.ts).
//
// On Windows gh.exe is found in the folders PATH names in full
// (findOnWindowsPathAsync) and started by the full path found, never by name,
// with the child's own program lookup kept to those folders
// (windowsStartCommand). With no gh.exe there the answer says so and nothing
// starts: a gh.exe in the app's working folder, or in a folder PATH names
// relative to it, is never run. Elsewhere `gh` by name from PATH, as before.
// Starts no process itself.
import { findOnWindowsPathAsync, windowsStartCommand } from '../windows-programs'

/** What a start reports when no gh.exe is in a folder PATH names in full. */
export const GH_NOT_ON_PATH = 'gh was not found in a folder PATH names (gh.exe)'

/** How gh starts: the program, its arguments, and (on Windows) the child's
 *  environment. Never through a shell. */
export interface GhStart {
  file: string
  args: string[]
  /** Pass to spawn / execFile as is. */
  windowsVerbatimArguments: boolean
  /** On Windows the child's environment (windowsStartCommand's); undefined
   *  elsewhere, where the child inherits this process's, as before. */
  env?: NodeJS.ProcessEnv
}

/** The start of gh with `args`, or why there is none. `env` is where PATH is
 *  read, and on Windows what the child's environment is made from; it is not
 *  changed. */
export async function ghStartCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<GhStart | { refused: string }> {
  if (platform !== 'win32') return { file: 'gh', args: [...args], windowsVerbatimArguments: false }
  const found = await findOnWindowsPathAsync(['gh.exe'], env)
  if (!found) return { refused: GH_NOT_ON_PATH }
  const how = windowsStartCommand(found, args, env)
  if ('refused' in how) return { refused: `gh was found but could not be started: ${how.refused}` }
  return { file: how.file, args: how.args, windowsVerbatimArguments: how.windowsVerbatimArguments, env: how.env }
}
