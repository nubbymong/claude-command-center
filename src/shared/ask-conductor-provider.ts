// Which assistant runs Ask Conductor when Claude Code and Codex are both on
// (owner decision 2026-09-27, OD27 M4, row 53, option B): a Settings row,
// "Ask Conductor runs on: Claude Code / Codex", shown only while both are on,
// Claude Code by default; turning a provider off never rewrites the saved
// choice. With both on, Sentinel's analysis runs on the provider this names
// (completion plan, P3.9). The Settings row and Ask on Codex are built with
// row 53 (PR 4, P4.3); until the row writes the key it reads as Claude Code
// (DEFAULT_SETTINGS holds 'claude'), the decided default. The one reading
// of the saved key, for both.
export type AskConductorProvider = 'claude' | 'codex'

/** The saved key, as PR 4's Settings row writes it. */
export const ASK_CONDUCTOR_PROVIDER_SETTING = 'askConductorProvider'

/** The saved choice, for when both providers are on: Codex only when the
 *  setting says exactly that, else Claude Code (absent, unreadable or
 *  anything else reads as the default). */
export function askConductorProviderChoice(settings: unknown): AskConductorProvider {
  if (!settings || typeof settings !== 'object') return 'claude'
  const v = Object.hasOwn(settings, ASK_CONDUCTOR_PROVIDER_SETTING) ? (settings as Record<string, unknown>)[ASK_CONDUCTOR_PROVIDER_SETTING] : undefined
  return v === 'codex' ? 'codex' : 'claude'
}

/** Which assistant runs Sentinel's analysis (P3.9, row 42): the one that is
 *  on; with both on, the one Ask Conductor runs on. Null with neither. */
export function sentinelAnalysisProvider(claudeOn: boolean, codexOn: boolean, settings: unknown): AskConductorProvider | null {
  if (claudeOn && codexOn) return askConductorProviderChoice(settings)
  return claudeOn ? 'claude' : codexOn ? 'codex' : null
}

/** What Ask Conductor says when its help folder cannot be rebuilt before a
 *  start (P4.3): the dock's line for a first launch or a revive, and the Ask
 *  tab's for a Restart, Past discussions or a restored tab. A fixed sentence:
 *  the file system's own message names the path and an entry a session chose,
 *  so it goes to neither, and the app log keeps only its code (review RASK-2). */
export const ASK_HELP_FOLDER_FAILED =
  "Could not rebuild Ask Conductor's help folder. Usually something still has a file open in it, such as a program Codex started in an earlier Ask session that is still running: end it, then try again. If it keeps failing, delete the help folder in your resources directory, or check that the resources directory is writable."
