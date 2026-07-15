import type { OverlayModelEntry } from './model-registry'

export type FindingKind = 'registry-proposal' | 'compat' | 'info'
export type FindingSeverity = 'info' | 'warn' | 'high'
export type FindingStatus = 'open' | 'applied' | 'dismissed' | 'muted'

export interface SentinelFinding {
  id: string                       // stable: `obs:model:<value>` / `obs:effort:<value>` / `cc:<ver>:<n>`
  kind: FindingKind
  severity: FindingSeverity
  title: string
  evidence: string                 // quoted changelog line(s) or observation source
  proposedPatch?: OverlayModelEntry
  affectedFeature?: string         // view key for badges: 'logs' | 'tokenomics' | 'sessions' | ...
  badgeText?: string
  /** Breaking-change findings only: which CCC surface the change hits --
   *  1 session launch, 2 terminal embedding, 3 statusline hook, 4 config/account.
   *  Absent on the deterministic backstop (keyed off the manifest area instead). */
  surface?: number
  status: FindingStatus
  createdAt: number
  ccVersionFrom?: string
  ccVersionTo?: string
}

export interface SentinelStateSnapshot {
  lastSeenCcVersion: string | null
  analyzing: boolean
  lastAnalysisAt: number | null
  lastAnalysisError: string | null
  findings: SentinelFinding[]
}
