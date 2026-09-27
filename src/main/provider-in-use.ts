// WP2: what runs a provider's CLI without an account lease, for the
// switch-off rule. `setProviderEnabled(false)` is refused while anything of
// the provider runs (accounts-service); leases cover Codex sessions, reviews,
// sign-ins and operations, and this covers the rest, composed here where main
// builds the accounts service (index.ts), not inside pty-manager.
//
// Claude Code, besides its sessions (pty-manager, including a spawn still
// being prepared), runs as cloud agents (running or pending), Insights runs,
// Sentinel's version check and analysis, a shell-only SSH session's accepted
// "Launch Claude" (pty-handlers), and the first-run CLI setup terminal
// (setup-handlers). Each is counted from the same step as its launch check,
// so a switch-off either sees it or refuses it.
import { countUnleasedAgentSessions } from './pty-manager'
import { countClaudeAgentsInUse } from './cloud-agent-manager'
import { countInsightsRunsInFlight } from './insights-runner'
import { sentinelClaudeRunsInFlight } from './sentinel/index'
import { countSshClaudeLaunches } from './ipc/pty-handlers'
import { countCliSetupInUse } from './ipc/setup-handlers'
import type { ProviderId } from '../shared/providers'

/** Each provider's CLI in use outside its sessions, by what runs it. */
const OUTSIDE_SESSIONS: Partial<Record<ProviderId, ReadonlyArray<() => number>>> = {
  claude: [countClaudeAgentsInUse, countInsightsRunsInFlight, sentinelClaudeRunsInFlight, countSshClaudeLaunches, countCliSetupInUse],
}

/** How much of a provider runs without an account lease. A counter that
 *  throws counts as one (fail closed: a switch-off is refused, not waved
 *  through). */
export function providerUseWithoutLease(providerId: ProviderId): number {
  const counters: ReadonlyArray<() => number> = [
    () => countUnleasedAgentSessions(providerId),
    ...(OUTSIDE_SESSIONS[providerId] ?? []),
  ]
  let n = 0
  for (const count of counters) {
    let c: number
    try { c = count() } catch { c = 1 }
    n += Number.isSafeInteger(c) && c > 0 ? c : 0
  }
  return n
}
