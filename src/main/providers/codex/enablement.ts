// WP2 commit 3: where the user's on/off for Codex is saved (plan A4), as data
// the accounts service reads through the package contract -- so no
// provider-name condition decides it. The renderer's own reads of the same
// setting are retired with the legacy Codex surfaces.
import type { ProviderEnablementSpec } from '../core'

/** On only by an explicit yes: installation alone is never consent (design
 *  6.3 step 5), so an absent value is "not answered yet". */
export const CODEX_ENABLEMENT: ProviderEnablementSpec = Object.freeze({ settingsKey: 'codexEnabled', absent: 'undecided' as const })
