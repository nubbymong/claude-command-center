/**
 * The account-profile id shape, on its own so modules that must stay free of
 * the account-profiles graph (electron, the resources directory, junction
 * management) can still recognise an id. claude-headless recovers the profile a
 * spawn runs under from its HOME path (#48) and is unit-tested against a stub
 * pty-manager with no electron at all; it cannot import account-profiles.
 *
 * account-profiles re-exports `isValidProfileId` from here, so every existing
 * import keeps working and there is ONE definition of the charset -- a second,
 * hand-copied regex is exactly the drift the cloud-agent tests warn about.
 */
import path from 'node:path'

// Profile ids are CCC-generated, lowercase-alphanumeric + hyphen. Validating
// here is the primary defense against a malicious/buggy renderer-supplied id
// (e.g. "..\\..\\.claude") escaping the profiles root in teardown.
const PROFILE_ID_RE = /^[a-z0-9][a-z0-9-]*$/

// `unknown` in, type-guard out: the id can arrive over IPC, where it is not
// necessarily a string. `RE.test(x)` would stringify a non-string first, so a
// crafted `{ toString: () => 'ok' }` used to pass. Length-capped like
// isValidNoteId so a pathological id can't be used to build a huge path.
export function isValidProfileId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && PROFILE_ID_RE.test(id)
}

/** The fixed basename of the profiles root: `getProfilesRoot()` is
 *  `<resources>/account-profiles`, and every profile home sits directly under it. */
export const PROFILES_ROOT_DIRNAME = 'account-profiles'

/**
 * The profile a HOME path belongs to, or null for the default (global) home.
 *
 * `getProfileConfigDir(id)` is `join(getProfilesRoot(), id)` -- the id is the
 * last path segment, and the segment above it is always `account-profiles` --
 * so the inverse needs no filesystem and no resources-directory lookup. Both
 * halves are required: the real user home (`C:\Users\nicho`, `/home/pi`) has a
 * basename that passes the id charset, and it must map to null, not to a
 * phantom profile. A null answer means "nothing to register", never a guess.
 */
export function profileIdFromHome(home: string | null | undefined): string | null {
  if (typeof home !== 'string' || home.length === 0) return null
  const base = path.basename(home)
  if (!isValidProfileId(base)) return null
  return path.basename(path.dirname(home)) === PROFILES_ROOT_DIRNAME ? base : null
}
