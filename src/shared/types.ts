/**
 * Shared type definitions used across main, preload, and renderer.
 * This is the canonical source — other files should import from here.
 */

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
  enabled: boolean
  browser: 'chrome' | 'edge'
  debugPort: number     // CDP port, default 9222
  mcpPort: number       // MCP SSE server port, default 19333
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

export interface ClaudeOptions {
  model?: string
  effortLevel?: 'low' | 'medium' | 'high'
  legacyVersion?: LegacyVersion
  disableAutoMemory?: boolean
  flickerFree?: boolean
  powershellTool?: boolean
  agentIds?: string[]
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
  sessionType: 'local' | 'ssh'
  shellOnly?: boolean
  partnerTerminalPath?: string
  partnerElevated?: boolean
  sshConfig?: SshConfig
  machineName?: string
  githubIntegration?: import('./github-types').SessionGitHubIntegration
  // Provider discriminator + sub-options
  provider: ProviderId
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
  flickerFree?: boolean
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  powershellTool?: boolean
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  effortLevel?: 'low' | 'medium' | 'high'
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
  isPeak?: boolean
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

// ── Logs ──

export interface LogSession {
  configLabel: string
  sessionId: string
  logDir: string
  startTime?: number
  endTime?: number
  size: number
}

export interface LogEntry {
  ts: number
  type: string
  data?: string
}

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

// ── Account Profiles ──

export interface AccountProfile {
  id: 'primary' | 'secondary'
  label: string
  savedAt: number
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
}

export interface TokenomicsSyncProgress {
  phase: 'scanning' | 'processing' | 'complete'
  totalFiles: number
  processedFiles: number
  currentFile?: string
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
