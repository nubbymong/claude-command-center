// WP2 commit 6d: where the user's on/off for Claude is saved (plan A4), as data
// the accounts service reads through the package contract, and the renderer's
// Providers switch writes after main accepts a change. Its own module, with
// type-only imports, so a test can pin the renderer's key against it.
import type { ProviderEnablementSpec } from '../core'

/** On unless the user turned it off (A4): Claude-only users change nothing. */
export const CLAUDE_ENABLEMENT: ProviderEnablementSpec = Object.freeze({ settingsKey: 'claudeEnabled', absent: 'on' as const })
