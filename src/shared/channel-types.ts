// src/shared/channel-types.ts

// Canonical bus sources (Section 2.A). `rule:<name>` is templated.
export const CHANNEL_SOURCES = [
  'github', 'vision', 'codex', 'tokenomics', 'memory',
  'pty', 'manual', 'attention', 'retraction',
] as const
export type ChannelSourceBase = typeof CHANNEL_SOURCES[number]
export type ChannelSource = ChannelSourceBase | `rule:${string}`

export interface ChannelEnvelopeMeta {
  source: ChannelSource
  ts: string            // ISO-8601, unique per send
  from?: string         // sending-session label (manual/codex routing only)
  firedBy?: 'system'    // rule-fired with no human origin
}

// Discriminated union -- one builder per send-point. `file-diff` is RESERVED
// for v1.5.11 (Section 4.A deferral) so the shape doesn't break later; it is
// NOT produced by any v1.5.10 send-point.
export type ChannelPayload =
  | { kind: 'github-pr'; title: string; number: number; url: string; ciStatus?: string; logTail?: string }
  | { kind: 'vision-screenshot'; dataUrl?: string; path?: string; caption?: string }
  | { kind: 'tokenomics-anomaly'; sessionLabel: string; tool?: string; spendDelta: number; baseline: number; ts: string }
  | { kind: 'memory-entry'; title: string; body: string }
  | { kind: 'pty-tail'; text: string; originSessionId: string; ts: string }
  | { kind: 'rule'; text: string }
  | { kind: 'retraction' }
  | { kind: 'file-diff'; path: string; diff: string } // RESERVED -- do not emit in v1.5.10

export const LEDGER_KINDS = [
  'bus-fire', 'bus-overflow', 'tray-overflow', 'permission-prompt',
  'permission-auto-allow', 'permission-approve', 'permission-deny',
  'tier-2-fallback', 'tier-2-timeout', 'failed',
] as const
export type LedgerKind = typeof LEDGER_KINDS[number]

export interface LedgerRecord {
  id: string
  ts: string
  source: ChannelSource | 'permission'   // 'permission' is a UI/ledger marker, not a bus source
  target: string | null
  transport: 'pty' | 'mcp' | null
  kind: LedgerKind
  summary: string                          // already redacted; never the full body
  firedBy?: 'system' | 'user'
  attachmentPath?: string
}

export type PermissionTransport = 'hook' | 'mcp'
export type TierLabel = 'channel-relay' | 'hooks' | null

export interface PendingPermission {
  requestId: string
  sessionId: string
  sessionLabel: string
  identityColorKey?: string
  provider?: string
  tool: string
  payloadPreview: string
  reason?: string
  capturedAt: number
  transport: PermissionTransport
  tierLabel: TierLabel
  highRisk?: { matched: string }          // present when payload matches a destructive pattern
}

export interface RuleTrigger {
  event: string                            // CC hook kind or CCC-internal event name
  branch?: string
  scope?: 'bound-pr' | 'project'
  headroomBelow?: number
  matcher?: string                         // for Notification triggers
  minDurationMs?: number
}
export type RuleTargetStrategy =
  | 'dependent-branches' | 'pr-author' | 'pr-session'
  | 'anomaly-session' | 'project-sessions' | 'events-feed-only'
export interface RuleAction {
  template: string | null                  // null = filter-only (no send)
  target: RuleTargetStrategy
}
export interface ChannelRule {
  id: string
  name: string
  enabled: boolean
  when: RuleTrigger
  then: RuleAction
  cooldownMs?: number
  builtin?: boolean
  fireCount: number
  lastFiredAt?: string
}

export type StandingApprovalTool = 'Bash' | 'Edit' | 'WebFetch' | '*'
export type StandingApprovalTtl = '1h' | '4h' | 'until-restart'
export interface StandingApproval {
  id: string
  tool: StandingApprovalTool
  ttl: StandingApprovalTtl
  createdAt: number
  expiresAt: number | null                 // null = until-restart
}

export interface FeatureState {
  disableConductorChannels: boolean
  introShown: boolean
}

const PAYLOAD_KINDS = new Set([
  'github-pr', 'vision-screenshot', 'tokenomics-anomaly',
  'memory-entry', 'pty-tail', 'rule', 'retraction', 'file-diff',
])
export function isChannelPayload(v: unknown): v is ChannelPayload {
  return !!v && typeof v === 'object' && PAYLOAD_KINDS.has((v as { kind?: string }).kind ?? '')
}
