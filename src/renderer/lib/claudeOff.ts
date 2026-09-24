import { useSettingsStore } from '../stores/settingsStore'
import { usesClaude, type ProviderChoiceView } from '../onboarding/provider-choice'

/**
 * Claude Code switched off in Settings, Accounts: the one place the renderer
 * decides it, and the one place it says so. Everything that would start
 * Claude asks this: a config launch (isConfigLaunchBlocked), Ask Conductor,
 * the SSH flow's "Launch Claude", a cloud agent, an insights run.
 *
 * The on/off itself has one definition (usesClaude: absent means on). This
 * module imports no launch hooks or stores beyond the settings, so any
 * surface can ask at render time without pulling in what it guards.
 */

/** The reason, wherever Claude Code being off stops something. */
export const CLAUDE_OFF = 'Claude Code is off. Turn it on in Settings, Accounts.'

/** The reason on a config that cannot launch because Claude Code is off. */
export const CLAUDE_OFF_LAUNCH_REASON = 'Claude Code is off. Turn it on in Settings, Accounts to launch this config.'

/** The reason Ask Conductor cannot open: it is a Claude session. */
export const ASK_CLAUDE_OFF = 'Ask Conductor runs on Claude Code, which is off. Turn it on in Settings, Accounts.'

/** True while Claude Code is switched off. */
export function isClaudeOff(settings: ProviderChoiceView = useSettingsStore.getState().settings): boolean {
  return !usesClaude(settings)
}

/** The subscribed form, for a surface that shows itself disabled: it
 *  re-renders the moment the switch flips in Settings. */
export function useClaudeOff(): boolean {
  const claudeEnabled = useSettingsStore((s) => s.settings.claudeEnabled)
  return isClaudeOff({ claudeEnabled })
}
