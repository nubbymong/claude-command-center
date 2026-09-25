// WP2 commit 6e: which assistants the user runs, as the saved settings say
// it. PURE (no store imports): steps.ts, the harness and App all read these,
// and steps.ts must stay importable by the node-only registry tests.
//
// The saved keys are the ones main reads for each provider's on/off
// (PROVIDER_ENABLED_SETTING in providerAccountsStore): `claudeEnabled`
// absent means on (Claude-only users change nothing), `codexEnabled` is on
// only once the user has said so.

export type AssistantsChoice = 'claude' | 'codex' | 'both'

export interface ProviderChoiceView {
  claudeEnabled?: boolean
  codexEnabled?: boolean
}

/** Claude Code is in use unless the saved setting turns it off. */
export function usesClaude(s: ProviderChoiceView): boolean {
  return s.claudeEnabled !== false
}

/** Codex is in use only once the saved setting turns it on. */
export function usesCodex(s: ProviderChoiceView): boolean {
  return s.codexEnabled === true
}

/** Both keys a choice saves. */
export function choiceSettings(choice: AssistantsChoice): { claudeEnabled: boolean; codexEnabled: boolean } {
  return { claudeEnabled: choice !== 'codex', codexEnabled: choice !== 'claude' }
}

/** The choice the saved settings already express, or null when nothing has
 *  been chosen yet (a fresh install: both keys absent). */
export function savedChoice(s: ProviderChoiceView): AssistantsChoice | null {
  if (s.claudeEnabled === undefined && s.codexEnabled === undefined) return null
  if (!usesClaude(s)) return 'codex'
  return usesCodex(s) ? 'both' : 'claude'
}

/** What first-run setup hands back: "Use Codex only" when the Claude Code
 *  CLI is not installed. */
export interface FirstRunOutcome {
  codexOnly?: boolean
}

/** What "Use Codex only" saves. */
export const CODEX_ONLY_SETTINGS = Object.freeze(choiceSettings('codex'))

/** A start-up with Claude Code turned off never asks for the Claude CLI's
 *  folder trust (the version-change CLI setup step): there is no Claude CLI
 *  to set up. */
export function skipsClaudeCliSetup(s: ProviderChoiceView): boolean {
  return !usesClaude(s)
}

// Setup found no Claude Code CLI and the user continued with Codex only.
// Held in memory for this renderer's lifetime, never saved: on a fresh
// install the assistants page, which follows in the same run, offers Codex
// alone and says why; an upgrader (on the version-change screen, or on the
// first-run screen of a new computer pointed at an existing resources
// folder) is handed the Codex setup page once, in this same run, and a
// later start knows nothing of it.
let claudeMissingAtSetup = false

export function noteClaudeMissingAtSetup(): void {
  claudeMissingAtSetup = true
}

export function claudeWasMissingAtSetup(): boolean {
  return claudeMissingAtSetup
}

/** Tests only. */
export function resetProviderChoiceForTests(): void {
  claudeMissingAtSetup = false
}
