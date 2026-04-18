import type { Capability } from '../../../shared/github-types'
import {
  CLASSIC_PAT_SCOPE_CAPABILITIES,
  FINEGRAINED_PERMISSION_CAPABILITIES,
} from '../../../shared/github-constants'

export type AuthKindForMapping = 'classic' | 'fine-grained' | 'oauth' | 'gh-cli'

export function scopesToCapabilities(
  kind: AuthKindForMapping,
  scopes: string[],
): Capability[] {
  const table =
    kind === 'fine-grained'
      ? FINEGRAINED_PERMISSION_CAPABILITIES
      : CLASSIC_PAT_SCOPE_CAPABILITIES
  const set = new Set<Capability>()
  for (const scope of scopes) {
    if (!Object.prototype.hasOwnProperty.call(table, scope)) continue
    const caps = table[scope]
    if (!Array.isArray(caps)) continue
    caps.forEach((c) => set.add(c))
  }
  return Array.from(set)
}
