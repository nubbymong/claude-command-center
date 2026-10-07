// P3.12 round 1 (B5): when the one-time conversation-indexing notice is due.
// PURE (no store imports), like provider-choice.ts, which it reads.
import { usesCodex, type ProviderChoiceView } from '../onboarding/provider-choice'
import { LOGGING_CONSENT_VERSION } from '../../shared/logging-consent-version'

export { LOGGING_CONSENT_VERSION }

export interface LoggingConsentView extends ProviderChoiceView {
  loggingConsentSeen?: boolean
  loggingConsentVersion?: number
  loggingEnabled?: boolean
}

/** The notice is due when it was never seen; or, with Codex in use and
 *  indexing on, when the notice seen predates the one that names Codex. A
 *  Claude-only user, and one who turned indexing off, see nothing new. */
export function loggingConsentDue(s: LoggingConsentView): boolean {
  if (!s.loggingConsentSeen) return true
  if (s.loggingEnabled === false || !usesCodex(s)) return false
  const seen = typeof s.loggingConsentVersion === 'number' ? s.loggingConsentVersion : 1
  return seen < LOGGING_CONSENT_VERSION
}
