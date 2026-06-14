import type { SentinelFinding } from './sentinel-types'

/**
 * Deterministic reachability gate for the Sentinel dot.
 *
 * The AI grades a finding's severity from the Claude Code changelog alone — it
 * can't know whether CCC actually depends on the changed behavior or what kind
 * of account the user runs. That made the dot cry wolf: any open finding (even a
 * pure FYI, or a managed-enterprise-only change) lit the same amber as a genuine
 * problem. This gate decides whether a finding can ACTUALLY reach the user's CCC
 * — i.e. whether it should drive the alarming dot — independently of the AI's
 * label. It only ever DOWNGRADES well-known inert classes; anything it doesn't
 * recognize stays actionable, so a real break is never hidden.
 */

export interface ReachabilityContext {
  /** True when the user is on a managed/enterprise account (managed settings
   *  active). Default false — CCC's users are overwhelmingly individuals, and a
   *  managed-settings-only change cannot reach a non-managed install. */
  accountManaged?: boolean
}

// Change classes that cannot affect an individual (non-managed) CCC install.
// Conservative: only well-known inert markers match.
const MANAGED_ONLY = /\bmanaged (setting|config|polic)|\benforceAvailableModels\b/i
// Model-redirect env vars CCC never sets (verified: zero ANTHROPIC_DEFAULT_*_MODEL
// usage in the codebase). The changelog quotes a literal glob `ANTHROPIC_DEFAULT_*_MODEL`,
// so allow `*` and `_` between the prefix and MODEL.
const UNUSED_MODEL_ENV = /ANTHROPIC_DEFAULT_[A-Z*_]*MODEL/i

function findingText(f: SentinelFinding): string {
  return `${f.title}\n${f.evidence}\n${f.badgeText ?? ''}`
}

/**
 * Whether a finding describes a Claude Code change that can actually REACH the
 * user's CCC, and so should drive the alarming dot.
 *
 * Only `compat` findings of `warn`/`high` severity are candidates — `info` and
 * registry proposals are never alarming (FYI / one-click apply). A candidate is
 * then gated by reachability: managed-settings-only changes don't reach a
 * non-managed account, and changes to model-redirect env vars CCC doesn't set
 * can't reach it at all.
 */
export function findingReachesUser(f: SentinelFinding, ctx: ReachabilityContext = {}): boolean {
  if (f.kind !== 'compat') return false
  if (f.severity === 'info') return false
  const t = findingText(f)
  if (!ctx.accountManaged && MANAGED_ONLY.test(t)) return false
  if (UNUSED_MODEL_ENV.test(t)) return false
  return true
}
