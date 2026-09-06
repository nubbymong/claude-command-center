// The #54 config-edit guard decision, as a pure function so Sidebar's chokepoint
// and its dialog read one rule and it can be unit-tested without mounting the
// whole sidebar. Editing a saved SSH config while a session it launched is live
// -- or was left running for a later reattach -- carries a real consequence
// (changes apply on the next launch; a destination change can break resume), so
// such an edit is warned about. Any other config, or an SSH config with no
// running session, opens the editor directly.
import type { TerminalConfig } from '../../stores/configStore'
import type { DetachedRemote } from '../../../shared/types'
import { matchDetachedRemotes } from '../../utils/detachedRemotes'

export interface ConfigEditGuardState {
  /** Live sessions launched from this config (from the running-count map). */
  liveCount: number
  /** Detached ("left running") remotes that reattach to this config. */
  leftRunningCount: number
  /** True when the edit should be warned about before the editor opens. */
  needsGuard: boolean
}

/**
 * Whether opening `config` for edit should warn first, and the counts that drive
 * the dialog's copy. Only an SSH config with a live or left-running session
 * needs the guard; the left-running count is 0 for a non-SSH config (there is no
 * detached-remote registry for local sessions, and no resume to break).
 */
export function configEditGuardState(
  config: Pick<TerminalConfig, 'id' | 'sessionType' | 'sshConfig'>,
  liveCount: number,
  detachedEntries: DetachedRemote[],
): ConfigEditGuardState {
  const leftRunningCount = config.sessionType === 'ssh'
    ? matchDetachedRemotes(detachedEntries, config).length
    : 0
  const needsGuard = config.sessionType === 'ssh' && (liveCount > 0 || leftRunningCount > 0)
  return { liveCount, leftRunningCount, needsGuard }
}
