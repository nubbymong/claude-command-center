import {
  IDENTITY_COLOR_KEYS,
  bucketLegacyColorToKeySource,
  type IdentityColorKey,
} from '../../shared/identity-colors'

export interface ColourMigrationSummary {
  scanned: number
  changed: number
  skipped: number
  fallback: number
}

interface ColourRecord {
  color?: string
  identityColorKey?: IdentityColorKey
  legacyColor?: string
}

const isValidKey = (k: unknown): k is IdentityColorKey =>
  typeof k === 'string' && (IDENTITY_COLOR_KEYS as readonly string[]).includes(k)

/**
 * Idempotent, non-destructive migration of legacy raw `color` to an identity
 * KEY. Never overwrites a valid existing identityColorKey; never deletes
 * `color`. Sets identityColorKey + legacyColor only on records that change.
 * Pure (no I/O). `fallback` counts records that needed the nearest/neutral
 * path rather than an exact key/name/hex match.
 */
export function migrateColorRecords<T extends ColourRecord>(
  records: readonly T[],
): { records: T[]; summary: ColourMigrationSummary } {
  let changed = 0
  let skipped = 0
  let fallback = 0
  const out = records.map((r) => {
    if (isValidKey(r.identityColorKey)) {
      skipped++
      return r
    }
    const { key, source } = bucketLegacyColorToKeySource(r.color ?? '')
    if (source === 'fallback' || source === 'nearest') fallback++
    changed++
    return { ...r, identityColorKey: key, legacyColor: r.color }
  })
  return { records: out, summary: { scanned: records.length, changed, skipped, fallback } }
}

interface ReviewConfigRef { id: string; legacyColor?: string }
interface ReviewSessionRef { configId?: string; legacyColor?: string }

/**
 * Choose the target for the notice's "Review colours" action (safety fallback
 * chain): first migrated config -> a migrated session's still-existing config
 * -> none. Never throws; returns 'none' when there is nothing safe to open
 * (e.g. the migrated config was deleted, or only sessions changed with no
 * resolvable config).
 */
export function pickColourReviewTarget(
  configs: readonly ReviewConfigRef[],
  sessions: readonly ReviewSessionRef[],
): { kind: 'config'; configId: string } | { kind: 'none' } {
  const cfg = configs.find((c) => c.legacyColor)
  if (cfg) return { kind: 'config', configId: cfg.id }
  const sess = sessions.find((s) => s.legacyColor && s.configId && configs.some((c) => c.id === s.configId))
  if (sess && sess.configId) return { kind: 'config', configId: sess.configId }
  return { kind: 'none' }
}
