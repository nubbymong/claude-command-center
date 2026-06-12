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
  /** T16: per-session CCC indexing opt-out. DEFAULT-TRUE (undefined / true = on).
   *  When false, CCC does not index this session's transcript for the Logs viewer.
   *  The conversation still lives in Claude's own files (~/.claude/projects). */
  loggingEnabled?: boolean
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
  /** Sentinel Trigger A: raw model id (data.model?.id) from the bridge script.
   *  `model` above is display-name-preferring; this field is id-first for
   *  accurate registry matching. The renderer ignores it. */
  modelId?: string
}

// ── Agent Templates ──

// Valid values are registry dropdown entries (e.g. 'opus', 'opus[1m]', 'fable', 'sonnet', 'haiku')
// plus the special sentinel 'inherit' (use the parent session model). Widened to string so the
// type does not hard-code the set of models — the registry is the authority.
export type AgentModelOverride = string

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

// ── Tokenomics v2 (worker-backed) cross-process contract ──
export type TkProvider = 'claude' | 'codex'

export interface TkSummary {
  kpis: {
    lifeToDateCostUsd: number
    last7dCostUsd: number
    prev7dCostUsd: number
    cacheEfficiencyPct: number
    cacheSavingsUsd: number
  }
  dailySeries: Array<{ day: string; costUsd: number }>
  modelSplit: Array<{ model: string; costUsd: number; tokens: number }>
  cacheSplit: { inputUsd: number; outputUsd: number; cacheReadUsd: number; cacheCreateUsd: number }
  costByConfig: Array<{ configId: string | null; label: string; costUsd: number; sessions: number }>
  heatmap: Array<{ bucket: number; tokens: number }>
}

export interface TkSessionRow {
  sessionId: string
  provider: TkProvider
  configId: string | null
  configLabel: string
  model: string
  costUsd: number
  inTok: number
  outTok: number
  cacheReadTok: number
  cacheCreateTok: number
  msgCount: number
  lastTs: number
}

export interface TkSessionsPage {
  rows: TkSessionRow[]
  nextCursor: { lastTs: number; sessionId: string } | null
}

export interface TkSessionDetail extends TkSessionRow {
  firstTs: number
  projectDir: string
  byModel: Array<{ model: string; costUsd: number; inTok: number; outTok: number; cacheReadTok: number; cacheCreateTok: number; msgCount: number }>
}

export interface TkIndexStatus {
  firstIndexComplete: boolean
  indexing: boolean
  filesDone: number
  filesTotal: number
  eventsTotal: number
  lastIndexAt: number | null
  /** Non-null when the worker reported a fatal/uncorrelated error (e.g. a failed
   *  DB open). The renderer surfaces this instead of an endless 'indexing' state. */
  error?: string | null
}

export interface TkSummaryFilter { configId?: string | null; from?: number; to?: number; model?: string }
export interface TkSessionsQuery extends TkSummaryFilter { search?: string; cursor?: { lastTs: number; sessionId: string } | null; limit?: number }
export interface TkIndexProgress { filesDone: number; filesTotal: number; eventsIngested: number; phase: string }
export interface TkIndexCompleteEvent { firstIndex: boolean; eventsTotal: number }

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
