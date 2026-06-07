/**
 * Shared type definitions used across main, preload, and renderer.
 * This is the canonical source — other files should import from here.
 */

import type { IdentityColorKey } from './identity-colors'

// ── Vision ──

/** @deprecated Use GlobalVisionConfig instead — vision is now global, not per-session */
export interface VisionConfig {
  enabled: boolean
  browser: 'chrome' | 'edge'
  debugPort: number
  url?: string
  headless?: boolean  // default true — run browser without visible window
}

export interface GlobalVisionConfig {
  /** @deprecated P7.3: browser auto-starts at CCC boot unconditionally.
   *  Field is ignored on load and treated as true. Retained for back-compat
   *  with existing user configs; remove in v1.6. */
  enabled?: boolean
  browser: 'chrome' | 'edge'
  debugPort: number     // CDP port, default 9222
  /** @deprecated P7.2: port is now resolved from build mode via
   *  resolveConductorMcpPort(isPackagedApp()). Field is ignored on load
   *  and not written on save. Retained on the type for back-compat with
   *  existing user configs that have it set. Remove in v1.6. */
  mcpPort?: number
  url?: string
  headless?: boolean    // default true
}

// ── SSH ──

export interface SshConfig {
  host: string
  port: number
  username: string
  remotePath: string
  hasPassword?: boolean
  postCommand?: string
  hasSudoPassword?: boolean
  dockerContainer?: string
}

// ── Legacy Version ──

export interface LegacyVersion {
  enabled: boolean
  version: string
}

// ── Provider types ──

export type ProviderId = 'claude' | 'codex'

export interface AccountIdentity {
  email: string
  name?: string
  accountUuid?: string
  provider: 'claude' | 'codex'
}

export interface ClaudeOptions {
  model?: string
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode'
  legacyVersion?: LegacyVersion
  disableAutoMemory?: boolean
  agentIds?: string[]
  /** v1.5 P6: when true, the Claude PTY is registered into the codex_review opt-in set
   *  and the SessionDialog toggle is persisted. Tool description still appears to all
   *  Claude sessions (soft ACL); this flag controls authorisation server-side. */
  enableCodexReview?: boolean
}

export interface CodexOptions {
  /** gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex / gpt-5.3-codex-spark / gpt-5.2 */
  model?: string
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
  permissionsPreset: 'read-only' | 'standard' | 'auto' | 'unrestricted'
}

// ── Session Persistence ──

export interface SavedSession {
  id: string
  configId?: string
  label: string
  workingDirectory: string
  color: string
  /** V2 identity colour: stable palette key. Authoritative over `color` at render time. */
  identityColorKey?: IdentityColorKey
  /** Pre-migration raw `color`, retained only when this record was migrated. */
  legacyColor?: string
  sessionType: 'local' | 'ssh'
  shellOnly?: boolean
  partnerTerminalPath?: string
  partnerElevated?: boolean
  sshConfig?: SshConfig
  machineName?: string
  githubIntegration?: import('./github-types').SessionGitHubIntegration
  // Provider discriminator + sub-options
  provider: ProviderId
  /** v1.5.19: links a session to an account profile (multi-account). */
  profileId?: string
  /**
   * T8b (bug #5): the exact conversation this session was on at quit, so an
   * app-relaunch resumes the SAME conversation rather than the newest in the
   * cwd's mangled folder (which can be stale, e.g. a git worktree). `resumeCwd`
   * is the directory the conversation actually ran in (read from the JSONL);
   * the launcher must cd there for the cwd-scoped `claude --resume` to resolve.
   * Best-effort enriched at save time; absent => fall back to existing behaviour.
   */
  resumeUuid?: string
  resumeCwd?: string
  claudeOptions?: ClaudeOptions
  codexOptions?: CodexOptions
  // Legacy top-level fields -- kept for backward compat during migration; read from claudeOptions after P1.2
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  model?: string
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  legacyVersion?: LegacyVersion
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  agentIds?: string[]
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode'
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  disableAutoMemory?: boolean
}

export interface SessionState {
  sessions: SavedSession[]
  activeSessionId: string | null
  savedAt: number
}

// ── Statusline ──

export interface RateLimitExtra {
  enabled: boolean
  utilization: number
  usedUsd: number
  limitUsd: number
}

export interface StatuslineData {
  sessionId: string
  model?: string
  // Codex: reasoning effort label (e.g. "xhigh"), surfaced alongside model in the
  // ContextBar. Always undefined for Claude sessions.
  reasoningEffort?: string
  // Claude: live reasoning effort from the statusline payload (effort.level),
  // reflects mid-session /effort changes. Maps to session.effortLevel.
  effortLevel?: string
  // Claude: live Fast Mode flag from the statusline payload (fast_mode), reflects
  // mid-session /fast toggles. Per-session and verified to flip true<->false.
  // Maps to session.fastMode; drives the sidebar card's ⚡ bolt.
  fastMode?: boolean
  contextUsedPercent?: number
  contextRemainingPercent?: number
  contextWindowSize?: number
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  totalDurationMs?: number
  linesAdded?: number
  linesRemoved?: number
  rateLimitCurrent?: number
  rateLimitCurrentResets?: string
  rateLimitWeekly?: number
  rateLimitWeeklyResets?: string
  rateLimitExtra?: RateLimitExtra
  /** Active-account email surfaced by the bridge script. Renderer displays it left of the model name. */
  accountEmail?: string
  /** Pre-computed by main process via `colourForEmail()` as an identity-palette KEY;
   *  the renderer resolves it to a theme hex via resolveIdentityColor(). */
  accountColour?: IdentityColorKey
  /** Logs v2 (Task 8): Claude Code's live `transcript_path` for this session,
   *  surfaced by the bridge script. Consumed in main (statusline-watcher fan-out
   *  -> transcript binder) as a continuous, exact discovery source; the renderer
   *  ignores it. */
  transcriptPath?: string
}

// ── Agent Templates ──

export type AgentModelOverride = 'sonnet' | 'opus' | 'haiku' | 'inherit'

export interface AgentTemplate {
  id: string
  name: string           // "code-reviewer" (lowercase, hyphens)
  description: string    // When Claude should delegate to this agent
  prompt: string         // System prompt
  model: AgentModelOverride
  tools: string[]        // Allowed tools (empty = inherit all)
  isBuiltIn?: boolean    // Pre-built template (read-only)
}

// ── Cloud Agents ──

export type CloudAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface CloudAgent {
  id: string
  name: string
  description: string
  status: CloudAgentStatus
  createdAt: number
  updatedAt: number
  projectPath: string
  configId?: string
  /** Account profile this agent ran under (multi-account). Undefined = default/global account. */
  profileId?: string
  /** Resolved account email at dispatch time. Drives the card label + account filter. */
  accountEmail?: string
  output: string
  cost?: number
  duration?: number
  tokenUsage?: { inputTokens: number; outputTokens: number }
  error?: string
}

// ── Insights ──

export interface InsightsRun {
  id: string
  timestamp: number
  status: 'running' | 'extracting_kpis' | 'complete' | 'failed'
  statusMessage?: string
  error?: string
  /** Account this run was generated for (multi-account). Undefined = default. */
  accountEmail?: string
  profileId?: string
}

export interface InsightsCatalogue {
  runs: InsightsRun[]
}

export interface KpiMetric {
  value: number
  label: string
  format?: 'number' | 'percent' | 'duration'
  goodDirection?: 'up' | 'down' | 'neutral'
}

export interface InsightsData {
  period?: { start?: string; end?: string; days?: number }
  summary?: {
    improvements?: string[]
    regressions?: string[]
    suggestions?: string[]
  }
  kpis?: Record<string, Record<string, KpiMetric>>
  lists?: Record<string, Array<{ name: string; count: number }>>
  [key: string]: any
}

/** Alias for backward compatibility */
export type KpiData = InsightsData

// ── Agent Teams ──

export type TeamStepMode = 'sequential' | 'parallel'

export interface TeamStep {
  id: string              // 'ts-' + random
  templateId: string      // references AgentTemplate.id
  label: string           // display name (defaults to template name)
  mode: TeamStepMode
  promptOverride?: string // optional: override the template's prompt
}

export interface TeamTemplate {
  id: string              // 'team-' + timestamp + random
  name: string
  description: string
  steps: TeamStep[]
  projectPath: string
  createdAt: number
  updatedAt: number
}

export type TeamRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface TeamRunStep {
  stepId: string          // matches TeamStep.id
  agentId: string | null  // CloudAgent.id once dispatched
  status: TeamRunStatus
  label: string
  startedAt?: number
  completedAt?: number
}

export interface TeamRun {
  id: string              // 'tr-' + timestamp + random
  teamId: string
  teamName: string        // snapshot at run time
  status: TeamRunStatus
  steps: TeamRunStep[]
  projectPath: string
  createdAt: number
  updatedAt: number
  duration?: number
  error?: string
}

// ── Tokenomics ──

export interface TokenomicsSessionRecord {
  sessionId: string
  projectDir: string
  model: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCostUsd: number
  messageCount: number
  firstTimestamp: string
  lastTimestamp: string
  durationMs?: number
  costPerHour?: number
  tokensPerMinute?: number
  // v1.5: provider discriminator. Optional on read for back-compat -- the
  // tokenomics-manager back-fills 'claude' on legacy records during load.
  provider?: ProviderId
  /** Canonicalised account email at write time. Lowercased + trimmed. Undefined for unattributed records. */
  accountEmail?: string
  /** Stability hint (account uuid from oauthAccount or Codex JWT). Never the primary key. */
  accountUuid?: string
  /** User-flagged via wizard: session spanned accounts. Excludes the record from per-account filter totals but keeps it in "All accounts". */
  attributionMixed?: boolean
  /** Account profile the session spawned under (undefined => default/single-account). Stamped at run time from the drift-immune spawn capture. A stable per-account key that survives a friendly-name or login-email change. */
  profileId?: string
  /** P8.14: config that owned the session at run time. Used by the back-fill wizard to group unattributed sessions. Optional -- legacy records may lack it. */
  configId?: string
  /** P8.14: human-readable label for `configId` (e.g. "This App Dev"). Mirrored at write time so the wizard doesn't have to cross-reference the configs store. */
  configLabel?: string
}

export interface TokenomicsDailyAggregate {
  date: string
  totalCostUsd: number
  totalTokens: number
  messageCount: number
  sessionCount: number
  totalDurationMs: number
  avgCostPerHour: number
  byModel: Record<string, { costUsd: number; inputTokens: number; outputTokens: number }>
  /** Per-account daily rollup, keyed by canonical accountEmail (unattributed sessions
   *  fall under '__unattributed__' so the axis reconciles to the day total). Optional
   *  for back-compat: rebuilt on load, so persisted pre-account aggregates lack it. */
  byAccount?: Record<string, { costUsd: number; inputTokens: number; outputTokens: number }>
}

export interface TokenomicsData {
  sessions: Record<string, TokenomicsSessionRecord>
  dailyAggregates: Record<string, TokenomicsDailyAggregate>
  lastSyncTimestamp: number
  totalCostUsd: number
  seedComplete: boolean
  // Extra spend tracking (from Anthropic API via statusline)
  extraSpend?: {
    enabled: boolean
    usedUsd: number
    limitUsd: number
    lastUpdated: number // epoch ms
  }
  // Rate limit tracking (from Anthropic API via statusline)
  rateLimits?: {
    fiveHour?: number    // utilization percentage
    sevenDay?: number    // utilization percentage
    lastUpdated: number
  }
  // P6: Codex review (Claude-driven) -- per-day aggregates from
  // <resourcesDir>/tokenomics/codex-review-by-day.json. Distinct from
  // interactive Codex usage already in dailyAggregates.
  codexReviewByDay?: Record<string, {
    reviewCount: number
    totalInputTokens: number
    totalOutputTokens: number
  }>
}

export interface TokenomicsSyncProgress {
  phase: 'scanning' | 'processing' | 'complete'
  totalFiles: number
  processedFiles: number
  currentFile?: string
}

// -- P8: Attribution wizard --

export type AttributionPayload = {
  sessionIds: string[]
  assignment:
    | { type: 'email'; email: string }
    | { type: 'mixed' }
    | { type: 'clear' }
}

export interface UnattributedSessionGroup {
  groupId: string                     // configId or '__no-config__'
  groupLabel: string                  // e.g. "This App Dev" or "(no config)"
  sessionIds: string[]
  totalCostUsd: number
  suggestedEmail: string | null       // null when before earliest backup
}

// -- Codex Review (P6) --

export interface CodexReviewRateLimitWindow {
  /** 0 to 1 (e.g. 0.59 == 59% used). */
  usedPercent: number
  /** Unix seconds when the 5h window resets. */
  resetsAt: number
  /** Plan tier from the most recent token_count event (e.g. "plus", "pro"). */
  planType: string
}

export interface CodexReviewUsageRecord {
  /** CCC session id (the Claude session that called the tool). */
  sessionId: string
  /** Number of successful codex_review calls so far in this session. */
  reviewCount: number
  /** Sum of input tokens across all reviews in this session. */
  totalInputTokens: number
  /** Sum of output tokens across all reviews in this session. */
  totalOutputTokens: number
  /** State of the user's 5h gpt-5.5 window after the most recent review.
   *  Null if no review has produced a token_count event yet. */
  lastRateLimitWindow: CodexReviewRateLimitWindow | null
  /** Unix ms of the last review's completion time. */
  lastReviewAt: number
}

/** Disk-persisted aggregate keyed by ISO date (YYYY-MM-DD).
 *  Lives at <resourcesDir>/tokenomics/codex-review-by-day.json. */
export interface CodexReviewDailyShard {
  /** ISO date string (YYYY-MM-DD, local time) -> aggregate for that day. */
  byDay: Record<string, {
    reviewCount: number
    totalInputTokens: number
    totalOutputTokens: number
  }>
  lastUpdated: number  // unix ms
}

// ── Notes ──

export interface NoteMetadata {
  id: string
  label: string
  color: string
  configId?: string
  createdAt: number
}

// ── Memory Visualiser ──

export interface MemoryFile {
  id: string
  name: string
  filename: string
  project: string
  projectDir: string
  type: 'user' | 'feedback' | 'project' | 'reference' | 'snapshot' | 'uncategorized'
  description: string
  size: number
  modified: number
  hasFrontmatter: boolean
  path: string
}

export interface MemoryProject {
  name: string
  projectDir: string
  fileCount: number
  totalSize: number
  lastModified: number
  types: Record<string, number>
  memoryMdLines?: number
}

export interface SchemaWarning {
  level: 'info' | 'warn' | 'error'
  message: string
  project?: string
  file?: string
}

export interface MemoryScanResult {
  projects: MemoryProject[]
  memories: MemoryFile[]
  warnings: SchemaWarning[]
  totalSize: number
  scannedAt: number
}
