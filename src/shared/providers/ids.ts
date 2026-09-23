// WP1 provider core: provider ids and the opaque application-generated ids
// used for identities, groups, provider accounts and auth realms (design 5).
//
// Every id is validated before it is used in a path; file-system directory
// names are never derived from an email, display name or provider subject.
import type { ProviderId } from '../types'
export type { ProviderId } from '../types'

/** Every provider id, in display order. Exhaustive BY CONSTRUCTION: the map
 *  is keyed by `ProviderId`, so widening that union without listing the new id
 *  here is a compile error rather than a silent omission from `isProviderId`,
 *  `listProviderPackages()` and the composition roots. */
const PROVIDER_ID_ORDER: Readonly<Record<ProviderId, number>> = { claude: 0, codex: 1 }
export const PROVIDER_IDS: readonly ProviderId[] =
  (Object.keys(PROVIDER_ID_ORDER) as ProviderId[]).sort((a, b) => PROVIDER_ID_ORDER[a] - PROVIDER_ID_ORDER[b])

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value)
}

/** Opaque id prefixes. The prefix names the record kind so a mismatched
 *  binding (an identity id where an account id is expected) is rejected by
 *  shape, before any lookup (WP1.42). */
export const ID_PREFIX = {
  identity: 'idn',
  group: 'grp',
  account: 'acct',
  realm: 'realm',
} as const
export type OpaqueIdKind = keyof typeof ID_PREFIX

// <prefix>-<16..64 lowercase hex chars>. Lowercase hex only: no user or
// provider-controlled string can ever satisfy it by accident, and it is safe
// as a directory name on every supported file system.
// Built from ID_PREFIX so a new kind cannot be added to the map above and
// then be rejected at runtime by a pattern nobody remembered to widen.
const OPAQUE_ID_RE = new RegExp('^(' + Object.values(ID_PREFIX).join('|') + ')-[0-9a-f]{16,64}$')

export function isOpaqueId(value: unknown, kind?: OpaqueIdKind): boolean {
  if (typeof value !== 'string' || !OPAQUE_ID_RE.test(value)) return false
  return kind ? value.startsWith(`${ID_PREFIX[kind]}-`) : true
}

/** Build an id from application-generated randomness (never from user data). */
export function makeOpaqueId(kind: OpaqueIdKind, hex: string): string {
  const id = `${ID_PREFIX[kind]}-${hex}`
  if (!isOpaqueId(id, kind)) throw new Error(`makeOpaqueId(${kind}): randomness must be 16..64 lowercase hex chars`)
  return id
}
