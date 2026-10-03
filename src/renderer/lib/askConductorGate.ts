import { ASK_CLAUDE_OFF, isClaudeOff, useClaudeOff } from './claudeOff'
import type { ProviderChoiceView } from '../onboarding/provider-choice'

/**
 * Whether Ask Conductor can open. Kept apart from askConductor.ts, which the
 * command dialog loads only on click: every entry point needs this at render
 * time, to show itself disabled, without pulling in the launcher.
 *
 * Ask is a real Claude session (askConductor.ts pins its provider), so it
 * cannot open while Claude Code is switched off in Settings, Accounts: the
 * one Claude-off rule and its wording, in claudeOff.ts. Deliberately free of
 * the launch hooks, so the launcher never imports the resume picker.
 */

/** Why Ask Conductor cannot open while Claude Code is switched off. */
export { ASK_CLAUDE_OFF }

/** True when Ask Conductor cannot launch now. */
export function isAskConductorBlocked(settings?: ProviderChoiceView): boolean {
  return settings ? isClaudeOff(settings) : isClaudeOff()
}

/** The subscribed form, for an entry point that shows itself disabled: it
 *  re-renders the moment the switch flips in Settings. */
export function useAskConductorBlocked(): boolean {
  return useClaudeOff()
}
