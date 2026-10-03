import { useSettingsStore } from '../stores/settingsStore'
import { usesClaude, type ProviderChoiceView } from '../onboarding/provider-choice'
import { providerOffMessage } from '../../shared/providers'

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

/** The reason, wherever Claude Code being off stops something: main's own
 *  sentence (a refusal main sends reads the same). */
export const CLAUDE_OFF = providerOffMessage('Claude Code')

/** The reason on a config that cannot launch because Claude Code is off. */
export const CLAUDE_OFF_LAUNCH_REASON = providerOffMessage('Claude Code', 'to launch this config')

/** OD27 M1 D5 (approved as drawn): the one muted line shown where a Claude
 *  Code accounts section would be while it is switched off (the Account
 *  usage page, the AI usage popover, the onboarding recap's Account row). */
export const CLAUDE_OFF_ACCOUNTS_LINE = 'Claude Code is off. Turn it on in Settings, Accounts to see its accounts.'

/** The reason Ask Conductor cannot open: it is a Claude session. */
export const ASK_CLAUDE_OFF = 'Ask Conductor runs on Claude Code, which is off. Turn it on in Settings, Accounts.'

/** The reason the session dialog's SSH Persistent card is off for a
 *  terminal-only config while Claude Code is off: what persists is the remote
 *  claude command, wrapped in tmux, and no Claude is launched then. */
export const PERSISTENT_CLAUDE_OFF = 'SSH Persistent keeps a remote Claude Code session running, which needs Claude Code on.'

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
