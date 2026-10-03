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

/** Codex as the saved settings say it: on or off once the user answered,
 *  else not answered yet, which every surface reads as "not set up" (main
 *  starts nothing of it). The settings store drops an earlier build's
 *  unanswered value at load (migrateCodexAnswer), and every way of answering
 *  writes the answer with it, so a saved on or off here is an answer. */
export type CodexPreference = 'on' | 'off' | 'undecided'

export function codexPreference(s: ProviderChoiceView): CodexPreference {
  return s.codexEnabled === true ? 'on' : s.codexEnabled === false ? 'off' : 'undecided'
}

/** Codex is in use only once the saved setting turns it on. */
export function usesCodex(s: ProviderChoiceView): boolean {
  return codexPreference(s) === 'on'
}

/** The one assistant in use when only one is (usesClaude, usesCodex), for
 *  copy that names the assistants (the guided tour, the Feature Guide).
 *  Null when both are, and when neither is (a state setup never leaves), so
 *  that copy then reads as it does with both on. */
export type OnlyAssistant = 'claude' | 'codex' | null

export function onlyAssistantInUse(s: ProviderChoiceView): OnlyAssistant {
  const claude = usesClaude(s)
  const codex = usesCodex(s)
  if (claude && !codex) return 'claude'
  if (codex && !claude) return 'codex'
  return null
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

/** What "Use Codex only" saves: the choice, and that it is an answer to
 *  "do you use Codex?" (codexAnswered), so an upgrader who chose it is not
 *  asked again by the one-time page after an update. */
export const CODEX_ONLY_SETTINGS = Object.freeze({ ...choiceSettings('codex'), codexAnswered: true as const })

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

// The one-time "Do you use Codex?" page after an update (codex-reconfirm-gate)
// was answered yes in this run: that upgrader is handed the Codex setup page
// next, the way "Use Codex only" hands one over. In memory only, like the
// flag above: a later start knows nothing of it.
let codexChosenOnUpgrade = false

export function noteCodexChosenOnUpgrade(): void {
  codexChosenOnUpgrade = true
}

export function codexWasChosenOnUpgrade(): boolean {
  return codexChosenOnUpgrade
}

/** Tests only. */
export function resetProviderChoiceForTests(): void {
  claudeMissingAtSetup = false
  codexChosenOnUpgrade = false
}
