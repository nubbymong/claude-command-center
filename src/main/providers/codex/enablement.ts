// WP2 commit 3: where the user's on/off for Codex is saved (plan A4), as data
// the accounts service reads through the package contract -- so no
// provider-name condition decides it. The renderer's own reads of the same
// setting are retired with the legacy Codex surfaces.
import type { ProviderEnablementSpec } from '../core'

/** On only by an explicit yes: installation alone is never consent (design
 *  6.3 step 5), so an absent value is "not answered yet". And the yes or no
 *  counts only once it was given in this model (`codexAnswered`): every user
 *  who updates chooses again, and an earlier build's `codexEnabled` does not
 *  carry over (owner decision 2026-09-26). */
export const CODEX_ENABLEMENT: ProviderEnablementSpec = Object.freeze({ settingsKey: 'codexEnabled', absent: 'undecided' as const, answeredKey: 'codexAnswered' })
