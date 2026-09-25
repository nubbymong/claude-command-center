// The account-profile id shape, in shared code so the provider-neutral
// registry (src/shared/providers) and the Claude legacy snapshot use the SAME
// charset as the main process. src/main/profile-id.ts re-exports it: there is
// one definition, never a hand-copied second regex.

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
