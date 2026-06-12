// src/shared/github-types.ts
// Shared types for the GitHub sidebar feature.
// NOTE: 'discussions' is intentionally omitted from Capability — per spec §11,
// Discussions are deferred from v1. Add back here when/if re-introduced.

export type Capability =
  | 'pulls'
  | 'issues'
  | 'contents'
  | 'statuses'
  | 'checks'
  | 'actions'
  | 'notifications'

export type GitHubFeatureKey =
  | 'activePR'
  | 'ci'
  | 'reviews'
  | 'linkedIssues'
  | 'notifications'
  | 'localGit'
  | 'sessionContext'

export interface RateLimitSnapshot {
  limit: number
  remaining: number
  resetAt: number
  capturedAt: number
}

export interface AuthProfile {
  id: string
  kind: 'gh-cli' | 'oauth' | 'pat-classic' | 'pat-fine-grained'
  label: string
  username: string
  avatarUrl?: string
  scopes: string[]
  capabilities: Capability[]
  allowedRepos?: string[]
  tokenCiphertext?: string
  ghCliUsername?: string
  createdAt: number
  lastVerifiedAt: number
  lastAuthErrorAt?: number
  expiresAt?: number
  expiryObservable: boolean
  rateLimits?: {
    core?: RateLimitSnapshot
    search?: RateLimitSnapshot
    graphql?: RateLimitSnapshot
  }
}

export interface GitHubSyncIntervals {
  activeSessionSec: number
  backgroundSec: number
  notificationsSec: number
}

export interface GitHubConfig {
  schemaVersion: number
  authProfiles: Record<string, AuthProfile>
  defaultAuthProfileId?: string
  featureToggles: Record<GitHubFeatureKey, boolean>
  syncIntervals: GitHubSyncIntervals
  enabledByDefault: boolean
  transcriptScanningOptIn: boolean
  seenOnboardingVersion?: string
}

export interface SessionGitHubIntegration {
  enabled: boolean
  repoUrl?: string
  repoSlug?: string
  authProfileId?: string
  autoDetected: boolean
  panelWidth?: number
  collapsedSections?: Record<string, boolean>
  dismissedAutoDetect?: boolean
}

export interface NotificationSummary {
  id: string
  type: 'review_requested' | 'mention' | 'assign' | 'subscribed' | string
  repo: string
  title: string
  url: string
  unread: boolean
  updatedAt: number
}

export interface NotificationsCache {
  etag?: string
  lastFetched: number
  items: NotificationSummary[]
}

export interface PRSnapshot {
  number: number
  title: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  author: string
  authorAvatarUrl?: string
  createdAt: number
  updatedAt: number
  mergeableState: 'clean' | 'conflict' | 'blocked' | 'unknown'
  allowedMergeMethods?: Array<'merge' | 'squash' | 'rebase'>
  url: string
  /** Pre-scanned issue numbers referenced in the PR body (#N, closes #N,
   * owner/repo#N), deduped. Sized by the source PR's `body` field at
   * sync time so the renderer doesn't re-parse on every context build. */
  bodyRefs?: number[]
}

export interface WorkflowRunSnapshot {
  id: number
  workflowName: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped' | null
  durationMs?: number
  url: string
  failedJobs?: Array<{ id: number; name: string; tailLine?: string }>
}

export interface ReviewThreadSnapshot {
  id: string
  file: string
  line: number
  commenter: string
  bodyMarkdown: string
  resolved: boolean
}

export interface ReviewSnapshot {
  id: number
  reviewer: string
  reviewerAvatarUrl?: string
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING' | 'DISMISSED'
  threads: ReviewThreadSnapshot[]
}

export interface IssueSnapshot {
  number: number
  title: string
  state: 'open' | 'closed'
  assignee?: string
  url: string
  primary?: boolean
}

export interface StatusSnapshot {
  context: string
  state: 'success' | 'failure' | 'pending' | 'error'
  description?: string
  url?: string
}

export interface CheckRunSnapshot {
  id: number
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion?:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | null
  detailsUrl?: string
}

export interface RepoCache {
  etags: Record<string, string>
  lastSynced: number
  pr?: PRSnapshot | null
  actions?: WorkflowRunSnapshot[]
  reviews?: ReviewSnapshot[]
  issues?: IssueSnapshot[]
  statuses?: StatusSnapshot[]
  checks?: CheckRunSnapshot[]
  accessedAt: number
}

export interface GitHubCache {
  schemaVersion: number
  repos: Record<string, RepoCache>
  notificationsByProfile: Record<string, NotificationsCache>
  lru: string[]
}

// --- GitHub AI-credits (Copilot) usage meter -------------------------------
//
// Normalized shape produced by fetchAiUsage(login). GitHub's raw billing rows
// use `discount*`/`net*` field names; we rename them to the words the UI uses:
//   discountQuantity/discountAmount -> coveredQuantity/coveredAmount
//     (the portion absorbed by the plan's included allowance)
//   netQuantity/netAmount           -> billedQuantity/billedAmount
//     (the overage the user actually pays for; billedAmount > 0 = the headline
//      "you are being billed beyond your included credits" signal)
//
// `source` records which endpoint the data came from: 'ai_credit' (new-plan
// primary endpoint) or 'premium_request' (old-plan fallback).
export interface AiUsageItem {
  product: string
  sku: string
  model: string
  unitType: string
  grossQuantity: number
  grossAmount: number
  coveredQuantity: number
  coveredAmount: number
  billedQuantity: number
  billedAmount: number
}

export interface AiUsageReport {
  fetchedAt: number
  source: 'ai_credit' | 'premium_request'
  timePeriod: { year: number; month: number }
  items: AiUsageItem[]
  totals: {
    grossAmount: number
    coveredAmount: number
    billedAmount: number
  }
}

// Structured status that travels ALONGSIDE the (possibly null) cached report so
// the UI can tell apart "no data because we never fetched" from "no data because
// the token is missing the billing scope" from "no GitHub auth at all". The
// report stays the source of numbers; this is the source of state copy.
//   - 'pending'       no fetch has resolved yet (first boot / just enabled)
//   - 'no-auth'       no usable GitHub auth profile to fetch with
//   - 'scope-missing' authed, but BOTH endpoints returned 403/404 (token lacks
//                     the `user` scope (classic) / Account "Plan: read" (fine))
//   - 'error'         network / non-403/404 HTTP / parse failure (transient)
//   - 'ok'            a report was fetched successfully (may have zero items)
export type AiUsageStatus = 'ok' | 'no-auth' | 'scope-missing' | 'error' | 'pending'

// The payload pushed over GITHUB_AI_USAGE_UPDATE and returned by
// GITHUB_AI_USAGE_GET. Additive: the report is still the headline, but it now
// carries a status so the renderer renders accurate empty/action states.
export interface AiUsagePayload {
  report: AiUsageReport | null
  status: AiUsageStatus
}

export interface ToolCallFileSignal {
  filePath: string
  at: number
  tool: 'Read' | 'Write' | 'Edit' | 'NotebookEdit' | 'MultiEdit' | 'Bash'
}

export interface TranscriptReference {
  kind: 'issue' | 'pr'
  repo?: string
  number: number
  at: number
}

export interface SessionContextResult {
  primaryIssue?: {
    number: number
    repo?: string
    title?: string
    state?: 'open' | 'closed'
    assignee?: string
  }
  otherSignals: Array<{ source: 'branch' | 'transcript' | 'pr-body'; number: number; repo?: string }>
  recentFiles: ToolCallFileSignal[]
  activePR?: { number: number; state: 'open' | 'closed' | 'merged'; draft: boolean }
}

export interface LocalGitState {
  branch?: string
  ahead: number
  behind: number
  staged: string[]
  unstaged: string[]
  untracked: string[]
  stashCount: number
  recentCommits: Array<{ sha: string; subject: string; at: number }>
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  expires_in: number
  interval: number
}

export interface OAuthTokenResponse {
  access_token?: string
  token_type?: string
  scope?: string
  error?: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | string
  error_description?: string
  interval?: number
}
