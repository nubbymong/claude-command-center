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
  /** The Claude Code version the panel names: the one installed at the last
   *  completed check (fixer 11). An update not analysed to the end yet is not
   *  named; a version at or below the highest one checked is, with no
   *  analysis (a downgrade has nothing newer to check). */
  lastSeenCcVersion: string | null
  /** P3.9: the same for Codex; absent in a state file written before Codex
   *  had one. */
  lastSeenCodexVersion?: string | null
  /** Fixer 11 (gate 3 F10, ADR-009 D1 round 2): the highest Claude Code
   *  version recorded as checked, which the start-up rule and the cap go by
   *  (only a version above it is analysed at start). It never goes down, not
   *  even for a Re-run of a lower version. Absent in a file written before
   *  it: the recorded version (lastSeen*) is taken then. */
  highestCheckedCcVersion?: string | null
  /** Fixer 11: the same for Codex. */
  highestCheckedCodexVersion?: string | null
  analyzing: boolean
  /** P3.9: whose update the analysis in flight is about (while `analyzing`). */
  analyzingProvider?: SentinelProvider | null
  lastAnalysisAt: number | null
  lastAnalysisError: string | null
  /** P3.9 round 1: said beside a completed analysis that did not read all of
   *  the notes in full (some were cut, or not every version could be read). */
  lastAnalysisNote?: string | null
  /** P3.9 round 4: per `<provider>:<version>`, how many analyses of that
   *  update had findings that could not be matched to its notes (it is
   *  recorded as checked, with a note, after UNVERIFIED_MAX_TRIES). */
  unverifiedTries?: Record<string, number>
  findings: SentinelFinding[]
}
