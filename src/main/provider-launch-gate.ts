// WP2: main refuses every launch of a provider that is switched off (owner
// requirement, 2026-09-25). The renderer already disables every way in while
// a provider is off (commit 6e); this is the authority behind it, so a
// renderer bug, a saved session restored at start or a Restart of an old tab
// cannot start a provider the user turned off.
//
// ONE question, asked by every entry point that starts a provider's CLI for
// the user, BEFORE any process starts: pty:spawn (new launches, restored
// sessions, Restart, Ask Conductor, SSH sessions that run Claude on the
// remote), the SSH flow's "Launch Claude", the first-run CLI setup terminal,
// Cloud Agents (again right before the agent's process starts), Insights
// (again before each Claude step), Sentinel's analysis, the legacy CLI
// install, and the review tools at run time. Probes that would run a
// provider's CLI ask the silent form (providerProbeRefusal). The answer comes
// from the accounts service (main's own on/off: the switch made in Settings,
// else the saved setting), and fails closed: no service, or a saved setting
// that cannot be read, refuses.
//
// The boundary: a terminal-only session runs whatever the user types in it,
// `claude` included. That is the user's own command in their own shell, not
// a launch the app starts, so nothing here stands between them.
import { getAccountsService } from './provider-accounts'
import { tryGetProviderPackage } from './providers/core'
import { providerStateUnknownMessage } from '../shared/providers'
import type { ProviderId, ProviderLaunchRefusal } from '../shared/providers'
import { logWarn } from './debug-logger'

function unknownState(providerId: ProviderId): ProviderLaunchRefusal {
  let name: string = String(providerId)
  try { name = tryGetProviderPackage(providerId)?.displayName ?? name } catch { /* the id is enough */ }
  return { code: 'provider-state-unknown', providerId, message: providerStateUnknownMessage(name) }
}

/** The rule itself: never throws; anything that goes wrong is a refusal. */
function answer(providerId: ProviderId): ProviderLaunchRefusal | null {
  try {
    const service = getAccountsService()
    return service ? service.launchRefusal(providerId) : unknownState(providerId)
  } catch {
    return unknownState(providerId)
  }
}

/**
 * Why a launch of `providerId` may not start now, or null when it may.
 * A refused launch is logged.
 */
export function providerLaunchRefusal(providerId: ProviderId): ProviderLaunchRefusal | null {
  const refusal = answer(providerId)
  if (refusal) logWarn(`[launch] ${providerId} launch refused (${refusal.code})`)
  return refusal
}

/**
 * The same rule for a probe that would run the provider's CLI (a version or
 * sign-in status check): no probe runs for a provider that is off. Not
 * logged: a probe skipped at every start is not an event.
 */
export function providerProbeRefusal(providerId: ProviderId): ProviderLaunchRefusal | null {
  return answer(providerId)
}
