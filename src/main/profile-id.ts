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
import fs from 'node:fs'
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

/** Windows and (by default) macOS filesystems are case-insensitive: a path can
 *  come back in a case other than the literal the app built it with. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin'

function isProfilesRootName(name: string): boolean {
  return CASE_INSENSITIVE_PATHS ? name.toLowerCase() === PROFILES_ROOT_DIRNAME : name === PROFILES_ROOT_DIRNAME
}

/**
 * The name `dir` has ON DISK when it exists -- a Windows 8.3 short form
 * (`ACCOUN~1`) expands to the long name it stands for -- and the segment as
 * written otherwise. Never throws: a path that does not exist, or a junction
 * that cannot be resolved, is judged on its text. Only ever consulted AFTER the
 * text failed to match (see profileIdFromHome), so a junctioned profiles root
 * whose target is called something else keeps matching on its text.
 */
function onDiskName(dir: string): string {
  try { return path.basename(fs.realpathSync.native(dir)) } catch { return path.basename(dir) }
}

/**
 * The profile a HOME path belongs to, or null for the default (global) home.
 *
 * `getProfileConfigDir(id)` is `join(getProfilesRoot(), id)` -- the id is the
 * last path segment, and the segment above it is always `account-profiles` --
 * so the inverse needs no resources-directory lookup. Both halves are required:
 * the real user home (`C:\Users\nicho`, `/home/pi`) has a basename that passes
 * the id charset, and it must map to null, not to a phantom profile. A null
 * answer means "nothing to register", never a guess.
 *
 * The parent segment is compared the way the filesystem would (adversarial pass
 * on #598): a home handed back as `...\Account-Profiles\<id>` or through an 8.3
 * short name names the SAME directory, and reading it as "not a profile" would
 * silently skip the consumer registration (#48) and the rotation wait (#49) --
 * the exact stranding those exist to prevent. EITHER the text or the on-disk
 * name may match: the text first (no I/O, and a junctioned root whose target
 * has another name must keep matching -- re-attack finding), the on-disk name
 * only when the text did not (the 8.3 case). The id itself stays exact: it is
 * CCC-generated lowercase, and a differently-cased id is not one.
 */
export function profileIdFromHome(home: string | null | undefined): string | null {
  if (typeof home !== 'string' || home.length === 0) return null
  const base = path.basename(home)
  if (!isValidProfileId(base)) return null
  const parent = path.dirname(home)
  return isProfilesRootName(path.basename(parent)) || isProfilesRootName(onDiskName(parent)) ? base : null
}
