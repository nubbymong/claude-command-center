import { useSettingsStore } from '../stores/settingsStore'
import { usesClaude, usesCodex, type ProviderChoiceView } from '../onboarding/provider-choice'
import { sentinelAnalysisProvider, type AskConductorProvider } from '../../shared/ask-conductor-provider'

/**
 * Whether Ask Conductor can open, and on which assistant. Kept apart from
 * askConductor.ts, which the command dialog loads only on click: every entry
 * point needs this at render time, to show itself disabled, without pulling
 * in the launcher.
 *
 * Ask runs on the assistant that is on; with Claude Code and Codex both on, on
 * the one Settings, General, "Ask Conductor runs on" names, Claude Code by
 * default (owner decision 2026-09-27, OD27 M4, option B; WP2 PR 4, P4.3).
 * That is the one reading of the saved choice Sentinel's analysis follows too
 * (shared/ask-conductor-provider.ts), and turning a provider off never
 * rewrites it. Ask cannot open only while neither is on. Deliberately free of
 * the launch hooks, so the launcher never imports the resume picker.
 */

/** The saved settings Ask's provider is read from. */
export type AskProviderView = ProviderChoiceView & { askConductorProvider?: AskConductorProvider }

/** Why Ask Conductor cannot open: neither assistant is on. (The exported
 *  name predates Ask on Codex; every entry point imports it.) */
export const ASK_CLAUDE_OFF = 'Ask Conductor runs on Claude Code or Codex, and both are off. Turn one on in Settings, Accounts.'

/** The assistant Ask Conductor starts on now: the one that is on; with both
 *  on, the saved choice. Null while neither is on. */
export function askConductorProviderNow(settings: AskProviderView = useSettingsStore.getState().settings): AskConductorProvider | null {
  return sentinelAnalysisProvider(usesClaude(settings), usesCodex(settings), settings)
}

/** True while both assistants are on: the only time there is a choice, so
 *  the Settings row "Ask Conductor runs on" and the dock's provider badge
 *  show only then. */
export function askConductorChoiceShown(settings: ProviderChoiceView = useSettingsStore.getState().settings): boolean {
  return usesClaude(settings) && usesCodex(settings)
}

/** True while `provider` is switched on. */
export function askProviderIsOn(provider: AskConductorProvider, settings: ProviderChoiceView = useSettingsStore.getState().settings): boolean {
  return provider === 'codex' ? usesCodex(settings) : usesClaude(settings)
}

/** True when Ask Conductor cannot launch now. */
export function isAskConductorBlocked(settings?: AskProviderView): boolean {
  return askConductorProviderNow(settings) === null
}

/** The subscribed form, for an entry point that shows itself disabled: it
 *  re-renders the moment either switch flips in Settings. */
export function useAskConductorBlocked(): boolean {
  const claudeEnabled = useSettingsStore((s) => s.settings.claudeEnabled)
  const codexEnabled = useSettingsStore((s) => s.settings.codexEnabled)
  return isAskConductorBlocked({ claudeEnabled, codexEnabled })
}

/** The subscribed provider Ask would start on now (null: it cannot open). */
export function useAskConductorProvider(): AskConductorProvider | null {
  const claudeEnabled = useSettingsStore((s) => s.settings.claudeEnabled)
  const codexEnabled = useSettingsStore((s) => s.settings.codexEnabled)
  const askConductorProvider = useSettingsStore((s) => s.settings.askConductorProvider)
  return askConductorProviderNow({ claudeEnabled, codexEnabled, askConductorProvider })
}

/** The subscribed form of askConductorChoiceShown. */
export function useAskConductorChoiceShown(): boolean {
  const claudeEnabled = useSettingsStore((s) => s.settings.claudeEnabled)
  const codexEnabled = useSettingsStore((s) => s.settings.codexEnabled)
  return askConductorChoiceShown({ claudeEnabled, codexEnabled })
}

/** Why a question is not typed into the open Ask tab: the assistant that tab
 *  runs on has been switched off since it opened. A live tab keeps its
 *  assistant until it is closed (the choice applies the next time Ask
 *  starts), and nothing is typed into an assistant that is off. */
export function askTabProviderOff(provider: AskConductorProvider): string {
  const name = provider === 'codex' ? 'Codex' : 'Claude Code'
  return `The open Ask Conductor tab runs on ${name}, which is off. Turn it on in Settings, Accounts, or close the tab and ask again.`
}
