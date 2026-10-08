// Experimental: more than one Claude account on macOS (owner decision D2 kept
// multi-account off there for WP1 only; this is the opt-in that lifts it).
//
// ONE rule, read by main (src/main/mac-multi-account.ts, from the saved
// settings file) and by the renderer (from the settings store, which is
// hydrated from that same file). Off unless the platform is darwin AND the
// saved setting is exactly `true`: an absent, malformed or unreadable value is
// off, and on win32/linux the setting means nothing at all -- those platforms
// already isolate accounts and their behaviour must not depend on it.
//
// What it changes on macOS (see src/main/account-profiles.ts, profileRealmSet):
// a NON-primary Claude profile runs with CLAUDE_CONFIG_DIR set to its own
// `<home>/.claude`, which Claude Code documents as keying both its config
// directory and its macOS Keychain entry, while HOME stays the real home so
// the login keychain is still found (#117). The primary profile -- the normal
// sign-in -- is left exactly as it is today.

/** The saved settings key. */
export const MAC_MULTI_ACCOUNT_SETTING = 'experimentalMacMultiAccount' as const

/** Claude Code version the mechanism is documented in. The official docs say
 *  CLAUDE_CONFIG_DIR keys the macOS Keychain entry, but do not say from which
 *  release; community reports place it between 2.1.20 and 2.1.56. The
 *  MECHANISM was verified by hand on a Mac (2026-10-06, CLI only); the CLI
 *  version used was not recorded, so this floor is still NOT verified. */
export const MAC_MULTI_ACCOUNT_MIN_CLI_UNVERIFIED = '2.1.56'

/** True only on macOS with the saved setting exactly `true`. */
export function macMultiAccountEnabled(platform: string | undefined, settings: unknown): boolean {
  if (platform !== 'darwin') return false
  if (!settings || typeof settings !== 'object') return false
  const s = settings as Record<string, unknown>
  return Object.hasOwn(s, MAC_MULTI_ACCOUNT_SETTING) && s[MAC_MULTI_ACCOUNT_SETTING] === true
}

/** True where this platform keeps Claude to one account: macOS with the
 *  experimental setting off (D2). False on win32/linux whatever is saved. */
export function claudeMultiAccountBlocked(platform: string | undefined, settings: unknown): boolean {
  return platform === 'darwin' && !macMultiAccountEnabled(platform, settings)
}
