// WP2 commit 6e: App's start-up and setup wiring for a Codex-only user, kept
// out of App so it can be run and tested as behaviour (App itself cannot be
// rendered in a unit test: it boots the whole app).
//
//   - finishSetup: what happens when a setup screen ends, first run and
//     version change alike. "Use Codex only" saves Claude Code off and Codex
//     on, and hands this run to the Codex setup page: a fresh install meets
//     it in the full flow anyway (after the assistants page); an upgrader,
//     who never sees the assistants page, gets it on its own or inside the
//     run that is due. The hand-off is in memory only: a later start does not
//     show the page again.
//   - harnessRun: whether the onboarding harness is due, and whether it
//     opens for the Codex setup page alone.
//   - cliSetupAtStart: whether a new version asks for the Claude CLI's
//     folder trust; never with Claude Code off (there is no Claude CLI to set
//     up), nor with a config already there.
import { applyFirstRunOutcome } from './save-provider-choice'
import { skipsClaudeCliSetup, type FirstRunOutcome, type ProviderChoiceView } from './provider-choice'

export interface SetupFinishSteps {
  /** First run only: load the config the setup pointed at, before anything
   *  is saved over it (see applyFirstRunOutcome). */
  loadConfig?: () => Promise<void>
  /** Open the onboarding harness for the Codex setup page, this run. */
  handOffCodexSetup: () => void
  /** Stamp this version's setup as done. */
  stampSetupVersion: () => void
  /** Close the setup screen. */
  close: () => void
}

export async function finishSetup(outcome: FirstRunOutcome | undefined, steps: SetupFinishSteps): Promise<void> {
  if (steps.loadConfig) await steps.loadConfig()
  // Synchronous into the store (the save to disk follows), before the stamp
  // and before the start-up after it reads the settings.
  void applyFirstRunOutcome(outcome)
  if (outcome?.codexOnly) steps.handOffCodexSetup()
  steps.stampSetupVersion()
  steps.close()
}

export interface HarnessRunInput {
  /** The full flow is outstanding (deriveOnboarding). */
  fullFlowDue: boolean
  /** The release notes are due, on their own. */
  whatsNewOnly: boolean
  /** This run's "Use Codex only" (finishSetup). */
  codexSetupHandOff: boolean
}

export function harnessRun(s: HarnessRunInput): { due: boolean; codexSetupOnly: boolean } {
  return {
    due: s.fullFlowDue || s.whatsNewOnly || s.codexSetupHandOff,
    // Alone only when nothing else is due; otherwise the page joins that run.
    codexSetupOnly: s.codexSetupHandOff && !s.fullFlowDue && !s.whatsNewOnly,
  }
}

export async function cliSetupAtStart(s: {
  hasExistingConfig: boolean
  settings: ProviderChoiceView
  isCliReady: () => Promise<boolean>
}): Promise<'stamp' | 'ask'> {
  if (s.hasExistingConfig || skipsClaudeCliSetup(s.settings)) return 'stamp'
  return (await s.isCliReady()) ? 'stamp' : 'ask'
}
