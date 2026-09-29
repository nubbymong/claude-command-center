import type { OverlayModelEntry } from './model-registry'

export type FindingKind = 'registry-proposal' | 'compat' | 'info'
export type FindingSeverity = 'info' | 'warn' | 'high'
export type FindingStatus = 'open' | 'applied' | 'dismissed' | 'muted'

/** The assistant a finding or an analysis is about (P3.9). */
export type SentinelProvider = 'claude' | 'codex'

export interface SentinelFinding {
  id: string                       // stable: `obs:model:<value>` / `obs:effort:<value>` / `cc:<ver>:<n>` / `codex-update:<ver>:<n>`
  kind: FindingKind
  severity: FindingSeverity
  title: string
  evidence: string                 // quoted changelog line(s) or observation source
  proposedPatch?: OverlayModelEntry
  affectedFeature?: string         // view key for badges: 'logs' | 'tokenomics' | 'sessions' | ...
  badgeText?: string
  /** Breaking-change findings only: which CCC surface the change hits --
   *  1 session launch, 2 terminal embedding, 3 statusline hook (Codex: its
   *  session files), 4 config/account.
   *  Absent on the deterministic backstop (keyed off the manifest area instead). */
  surface?: number
  /** P3.9: the assistant whose update or check the finding is about. Absent
   *  on findings made before Codex had any (Claude Code's). */
  provider?: SentinelProvider
  status: FindingStatus
  createdAt: number
  ccVersionFrom?: string
  ccVersionTo?: string
}

export interface SentinelStateSnapshot {
  lastSeenCcVersion: string | null
  /** P3.9: the Codex version the last completed check saw; absent in a
   *  state file written before Codex had one. */
  lastSeenCodexVersion?: string | null
  analyzing: boolean
  /** P3.9: whose update the analysis in flight is about (while `analyzing`). */
  analyzingProvider?: SentinelProvider | null
  lastAnalysisAt: number | null
  lastAnalysisError: string | null
  findings: SentinelFinding[]
}
